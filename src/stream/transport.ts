// S2 retry 缝(双方言共用的网络侧叶子):TransportError + 真 transport(fetch 流式读/空闲超时)
// + withRetry(5xx/timeout 重试 1 次、4xx 即停;半截流不重放)。
// 卡 1(ADR-003)自 openai-completions.ts 逐字搬入,行为不变;住叶子 = dispatch(core.ts)
// import 两方言时不成环。假 transport 测试亦抛 TransportError 走同一路径。
import type { Transport } from "./protocol.ts";

// S2 retry 缝:TransportError 区分 5xx/timeout(重试)vs 4xx(透传不重试)。
// defaultTransport 抛此型;假 transport 测试亦抛此型走同一路径。
export class TransportError extends Error {
  status?: number;
  isTimeout?: boolean;
  constructor(message: string, opts?: { status?: number; isTimeout?: boolean }) {
    super(message);
    this.name = "TransportError";
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.isTimeout) this.isTimeout = true;
  }
}

function isRetryable(e: unknown): boolean {
  if (!(e instanceof TransportError)) return false;
  if (e.isTimeout) return true;
  if (e.status !== undefined && e.status >= 500 && e.status < 600) return true;
  return false;
}

// Story 8 真路径 timeout 入口(此前 isTimeout 只有 mock 能造):等待下一个 chunk 时
// 起空闲计时,超 TRANSPORT_IDLE_TIMEOUT_MS 无新字节(覆盖连接/TTFB/流断)→ abort 并抛
// TransportError{isTimeout} → withRetry 重试 1 次。计时只在 read 等待期运行,yield 给
// 消费者(下游跑工具再慢)不误伤。外部 signal(Story 16 断流)转发至 fetch。
export const TRANSPORT_IDLE_TIMEOUT_MS = 30_000;
export const defaultTransport: Transport = async function* (url, init, signal) {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TRANSPORT_IDLE_TIMEOUT_MS);
  };
  const disarm = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const timeoutOrRethrow = (e: unknown): never => {
    if (timedOut) throw new TransportError("transport idle timeout", { isTimeout: true });
    throw e;
  };
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    arm();
    const res = await fetch(url, { ...init, signal: controller.signal }).catch(timeoutOrRethrow);
    disarm();
    if (!res.ok || !res.body) {
      throw new TransportError(`HTTP ${res.status}`, { status: res.status });
    }
    const dec = new TextDecoder();
    let buf = "";
    const reader = res.body.getReader();
    for (;;) {
      arm();
      const r = await reader.read().catch(timeoutOrRethrow);
      disarm();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line) yield line;
      }
    }
    if (buf) yield buf;
  } finally {
    disarm();
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }
};

// S2 retry:包 Transport。5xx/timeout → 重试 retries 次(默认1,PRD story 8);
// 4xx → 透传不重试。重试耗尽 → 抛原错,createStream catch 成 error 事件。
export function withRetry(transport: Transport, retries = 1): Transport {
  return async function* (url, init, signal) {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let yielded = false;
      try {
        for await (const line of transport(url, init, signal)) {
          yielded = true;
          yield line;
        }
        return;
      } catch (e) {
        lastErr = e;
        // 只在未吐出任何一行前重试。中途断流从头重放会让上层重复收 start/text_delta
        // (adapter 已把前缀事件发出去了)→ 直接上抛,由 adapter 编成 error 事件。
        // PRD 风险节(relay 抖动史)针对的是握手失败,不是半截流重放。
        if (yielded) throw e;
        if (attempt < retries && isRetryable(e)) continue;
        throw e;
      }
    }
    throw lastErr;
  };
}
