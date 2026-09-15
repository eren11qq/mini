import { describe, it, expect, vi, afterEach } from "vitest";
import {
  TransportError,
  TRANSPORT_IDLE_TIMEOUT_MS,
  defaultTransport,
  withRetry,
} from "./transport.ts";
import type { Transport } from "../loop/types.ts";

// 锚点直测(ADR-003 Q6=A 的"下一独立 slice"):transport.ts 自 openai-completions.ts 提炼成
// 网络侧叶子后,公开面 = TransportError / TRANSPORT_IDLE_TIMEOUT_MS / defaultTransport / withRetry。
// 既有 retry.test.ts(经 createStream)只覆盖 withRetry 的四剧本;defaultTransport 的真 fetch
// 路径(行切分 / !ok / 无 body / 空闲超时 / 外部 signal)此前零直测 —— 本文件补上。
// isRetryable 是私有实现细节,通过 5xx/4xx/timeout/非 TransportError 四种输入的可见行为判它。

// ---------- withRetry 替身 ----------

type Outcome = { lines?: string[]; err?: Error };

function scripted(outcomes: Outcome[]): { transport: Transport; calls: () => number } {
  let n = 0;
  const transport: Transport = async function* () {
    const o = outcomes[Math.min(n, outcomes.length - 1)]!;
    n += 1;
    // 先吐行再抛:lines + err 同项 = 半截流(已 yield 过才断)
    for (const line of o.lines ?? []) yield line;
    if (o.err !== undefined) throw o.err;
  };
  return { transport, calls: () => n };
}

async function collect(t: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of t) out.push(line);
  return out;
}

describe("withRetry 直测:重试与否只看错误形状", () => {
  // AC-S2-2/3/4/5 的叶子版判据(不经 createStream,不看 ProviderEvent)
  it("5xx → 重试 1 次成功:调 2 次,行序完整不重", async () => {
    const { transport, calls } = scripted([
      { err: new TransportError("HTTP 503", { status: 503 }) },
      { lines: ["a", "b"] },
    ]);
    expect(await collect(withRetry(transport, 1)("u", {}))).toEqual(["a", "b"]);
    expect(calls()).toBe(2);
  });

  it("恒 5xx → 调 2 次后上抛原 TransportError(交 createStream catch 成 error 事件)", async () => {
    const { transport, calls } = scripted([
      { err: new TransportError("HTTP 503", { status: 503 }) },
    ]);
    await expect(collect(withRetry(transport, 1)("u", {}))).rejects.toThrow(/503/);
    expect(calls()).toBe(2);
  });

  it("4xx → 不重试:调 1 次即上抛", async () => {
    const { transport, calls } = scripted([
      { err: new TransportError("HTTP 401", { status: 401 }) },
      { lines: ["a"] },
    ]);
    await expect(collect(withRetry(transport, 1)("u", {}))).rejects.toThrow(/401/);
    expect(calls()).toBe(1);
  });

  it("isTimeout → 同 5xx 走重试", async () => {
    const { transport, calls } = scripted([
      { err: new TransportError("timeout", { isTimeout: true }) },
      { lines: ["a"] },
    ]);
    expect(await collect(withRetry(transport, 1)("u", {}))).toEqual(["a"]);
    expect(calls()).toBe(2);
  });

  it("非 TransportError(如下游代码 bug)→ 不重试", async () => {
    const { transport, calls } = scripted([{ err: new Error("boom") }, { lines: ["a"] }]);
    await expect(collect(withRetry(transport, 1)("u", {}))).rejects.toThrow("boom");
    expect(calls()).toBe(1);
  });

  it("半截流(已吐行才断)→ 立即上抛,不从头重放", async () => {
    const { transport, calls } = scripted([
      { lines: ["a"], err: new TransportError("HTTP 503", { status: 503 }) },
      { lines: ["a", "b"] },
    ]);
    const got = await collect(withRetry(transport, 1)("u", {})).catch((e: unknown) => e);
    // 消费者已收 "a";重放会让上层 start/text_delta 重复 → 必须上抛
    expect(got).toBeInstanceOf(TransportError);
    expect(calls()).toBe(1);
  });

  it("retries 参数决定次数:2 → 3 试;0 → 1 试", async () => {
    const a = scripted([{ err: new TransportError("HTTP 503", { status: 503 }) }]);
    await expect(collect(withRetry(a.transport, 2)("u", {}))).rejects.toThrow(/503/);
    expect(a.calls()).toBe(3);

    const b = scripted([{ err: new TransportError("HTTP 503", { status: 503 }) }]);
    await expect(collect(withRetry(b.transport, 0)("u", {}))).rejects.toThrow(/503/);
    expect(b.calls()).toBe(1);
  });

  it("成功流不被吞不重复(逐行透传)", async () => {
    const { transport, calls } = scripted([{ lines: ["1", "2", "3"] }]);
    expect(await collect(withRetry(transport, 1)("u", {}))).toEqual(["1", "2", "3"]);
    expect(calls()).toBe(1);
  });
});

// ---------- defaultTransport 替身 ----------

interface FakeReader {
  read(): Promise<{ done?: boolean; value?: Uint8Array }>;
}
interface FakeResponse {
  ok: boolean;
  status: number;
  body: { getReader(): FakeReader } | null;
}

const te = new TextEncoder();

function teChunk(c: string | Uint8Array): Uint8Array {
  return typeof c === "string" ? te.encode(c) : c;
}

/** 依次吐出这些块(bytes 用来造跨块截断的多字节字符),然后 done。 */
function responseFromChunks(chunks: Array<string | Uint8Array>): FakeResponse {
  let i = 0;
  const reader: FakeReader = {
    read: async () => {
      const c = chunks[i];
      if (c === undefined) return { done: true };
      i += 1;
      return { value: teChunk(c) };
    },
  };
  return { ok: true, status: 200, body: { getReader: () => reader } };
}

/** read() 由测试手动 settle:精确控制"下一批字节何时到"。 */
function controllableResponse(): {
  res: FakeResponse;
  push: (chunk: string | Uint8Array | null) => void;
} {
  const queue: Array<(r: { done?: boolean; value?: Uint8Array }) => void> = [];
  const reader: FakeReader = {
    read: () =>
      new Promise((settle) => {
        queue.push(settle);
      }),
  };
  return {
    res: { ok: true, status: 200, body: { getReader: () => reader } },
    push: (chunk) => {
      const settle = queue.shift();
      if (!settle) throw new Error("测试失序:没有等待中的 read()");
      settle(chunk === null ? { done: true } : { value: teChunk(chunk) });
    },
  };
}

/** fetch 挂起不返回,只在 signal abort 时 reject(模拟连接/TTFB 卡死)。 */
function stallingFetch() {
  const signals: AbortSignal[] = [];
  const fetchMock = vi.fn((_url: string, init: RequestInit) => {
    const signal = init.signal;
    if (signal) signals.push(signal);
    return new Promise<FakeResponse>((_res, rej) => {
      signal?.addEventListener("abort", () => rej(new Error("aborted by signal")));
    });
  });
  return { fetchMock, signals };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("defaultTransport 直测:行切分与残块", () => {
  it("跨 chunk 拼行 / 空行(SSE 分隔符)不 yield / 尾块无换行也 flush", async () => {
    vi.stubGlobal("fetch", async () =>
      responseFromChunks(["data: a\nda", "ta: b\n\n", "data: tail-no-newline"]),
    );
    expect(await collect(defaultTransport("u", {}))).toEqual([
      "data: a",
      "data: b",
      "data: tail-no-newline",
    ]);
  });

  it("多字节字符被切在 chunk 边界 → 不乱码(stream:true 解码)", async () => {
    const bytes = te.encode("data: 你好世界\n");
    vi.stubGlobal("fetch", async () => responseFromChunks([bytes.slice(0, 8), bytes.slice(8)]));
    expect(await collect(defaultTransport("u", {}))).toEqual(["data: 你好世界"]);
  });

  it("透传 url 与 init(含注入的 signal)给 fetch", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => responseFromChunks([]));
    vi.stubGlobal("fetch", fetchMock);
    await collect(defaultTransport("https://x/v1/chat", { method: "POST", headers: { a: "b" } }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://x/v1/chat");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("defaultTransport 直测:HTTP 失败形状", () => {
  it("!ok → TransportError 带 status(401 不重试 / 503 可重试的分诊输入)", async () => {
    for (const status of [401, 503]) {
      vi.stubGlobal("fetch", async () => ({ ok: false, status, body: null }));
      const err = await collect(defaultTransport("u", {})).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).status).toBe(status);
      expect((err as TransportError).isTimeout).toBeUndefined();
      expect((err as TransportError).message).toBe(`HTTP ${status}`);
      vi.unstubAllGlobals();
    }
  });

  it("ok 但 body 为 null → TransportError(不静默零事件)", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, body: null }));
    await expect(collect(defaultTransport("u", {}))).rejects.toBeInstanceOf(TransportError);
  });
});

describe("defaultTransport 直测:空闲超时(story 8 真路径 —— isTimeout 不再只有 mock 能造)", () => {
  it("fetch 挂死 → 空转到 idle 上限 → TransportError{isTimeout}", async () => {
    vi.useFakeTimers();
    const { fetchMock, signals } = stallingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const it = defaultTransport("u", {})[Symbol.asyncIterator]();
    const p = it.next();
    // 立即挂 handler:超时在下面的 advance 里触发,晚一步挂就是 unhandled rejection
    const settled = p.then(() => undefined).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(TRANSPORT_IDLE_TIMEOUT_MS + 10);
    const err = await settled;
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).isTimeout).toBe(true);
    expect((err as TransportError).message).toBe("transport idle timeout");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it("每次等待 < idle 而累计 > idle → 不误伤(计时按 read 重装)", async () => {
    vi.useFakeTimers();
    const { res, push } = controllableResponse();
    vi.stubGlobal("fetch", async () => res);
    const it = defaultTransport("u", {})[Symbol.asyncIterator]();
    const step = TRANSPORT_IDLE_TIMEOUT_MS - 5_000;

    const p1 = it.next();
    await vi.advanceTimersByTimeAsync(step);
    push("data: a\n");
    expect((await p1).value).toBe("data: a");

    const p2 = it.next();
    await vi.advanceTimersByTimeAsync(step);
    push("data: b\n");
    expect((await p2).value).toBe("data: b");

    const p3 = it.next();
    await vi.advanceTimersByTimeAsync(step);
    push(null);
    expect((await p3).done).toBe(true); // 累计 3×(idle-5s) 仍活
  });

  it("计时只在 read 等待期跑:消费者暂停(不 next)不算断流", async () => {
    vi.useFakeTimers();
    const { res, push } = controllableResponse();
    vi.stubGlobal("fetch", async () => res);
    const it = defaultTransport("u", {})[Symbol.asyncIterator]();

    const p1 = it.next();
    await vi.advanceTimersByTimeAsync(0);
    push("data: a\n");
    expect((await p1).value).toBe("data: a");

    // 下游跑慢工具:2× idle 无人 next,不得判超时
    await vi.advanceTimersByTimeAsync(TRANSPORT_IDLE_TIMEOUT_MS * 2);

    const p2 = it.next();
    await vi.advanceTimersByTimeAsync(1_000);
    push("data: b\n");
    expect((await p2).value).toBe("data: b");
  });

  it("外部 signal 中断 → 原错上抛,不冒充 timeout", async () => {
    vi.useFakeTimers();
    const { fetchMock } = stallingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const ctrl = new AbortController();
    const it = defaultTransport("u", {}, ctrl.signal)[Symbol.asyncIterator]();
    const p = it.next();
    await vi.advanceTimersByTimeAsync(1_000); // 远未到 idle
    ctrl.abort();
    const err = await p.then(() => undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TransportError);
  });
});

describe("defaultTransport × withRetry 串联:真 fetch 路径的重试", () => {
  it("第 1 次连接卡死超时 → 重试第 2 次成功(fetch 调 2 次,首行到手)", async () => {
    vi.useFakeTimers();
    const stall = stallingFetch();
    const ok = responseFromChunks(["data: a\n"]);
    let calls = 0;
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      calls += 1;
      return calls === 1 ? stall.fetchMock(url, init) : Promise.resolve(ok);
    });
    const it = withRetry(defaultTransport, 1)("u", {})[Symbol.asyncIterator]();
    const p = it.next();
    await vi.advanceTimersByTimeAsync(TRANSPORT_IDLE_TIMEOUT_MS + 10);
    expect((await p).value).toBe("data: a");
    expect(calls).toBe(2);
  });
});
