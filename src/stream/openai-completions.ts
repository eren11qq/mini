// S1 openai-completions 适配器:把 deepseek/openai-completions 方言的 SSE
// 翻成统一 ProviderEvent 协议。loop 缝 = StreamFn(context);config 绑在本文件。
// 零网络靠 Transport 注入缝:假 transport 回放 SSE 行,真 transport = fetch 流式读。
// error 一律编码进流、不 throw(loop 层零 try/catch 约束)。
import type {
  LoopContext,
  ProviderConfig,
  ProviderEvent,
  StreamFn,
  StopReason,
  Transport,
  Usage,
} from "../loop/types.ts";
import { anthropicStream } from "./anthropic-messages.ts";

export interface StreamDeps {
  transport?: Transport;
}

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

const FINISH_TO_STOP: Record<string, StopReason> = {
  stop: "stop",
  tool_calls: "tool_use",
  length: "length",
  content_filter: "error",
};

// Story 8 真路径 timeout 入口(此前 isTimeout 只有 mock 能造):等待下一个 chunk 时
// 起空闲计时,超 TRANSPORT_IDLE_TIMEOUT_MS 无新字节(覆盖连接/TTFB/流断)→ abort 并抛
// TransportError{isTimeout} → withRetry 重试 1 次。计时只在 read 等待期运行,yield 给
// 消费者(下游跑工具再慢)不误伤。外部 signal(Story 16 断流)转发至 fetch。
export const TRANSPORT_IDLE_TIMEOUT_MS = 30_000;
const defaultTransport: Transport = async function* (url, init, signal) {
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

// salvage:把分多 delta 累积的 toolcall arguments 前缀尽力解析成对象。
// 残缺 → 返回已完成顶层 key/value;完整 → JSON.parse 精确;非对象 → 原串。
// 目标:UI 不空白(AC-S1-6),定稿截断 → 整批拒执(AC-S1-7)。
function stringEnd(s: string, i: number): number {
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === "\\") {
      j += 2;
      continue;
    }
    if (s[j] === '"') return j + 1;
    j += 1;
  }
  return -1;
}

function braceEnd(s: string, i: number, open: string): number {
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let j = i;
  let inStr = false;
  while (j < s.length) {
    const c = s[j];
    if (inStr) {
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === '"') inStr = false;
      j += 1;
      continue;
    }
    if (c === '"') {
      inStr = true;
      j += 1;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
    j += 1;
  }
  return -1;
}

function valueEnd(s: string, i: number): number {
  const c = s[i];
  if (c === '"') return stringEnd(s, i);
  if (c === "{" || c === "[") return braceEnd(s, i, c);
  let j = i;
  while (j < s.length && !",}\t\r\n ".includes(s.charAt(j))) j += 1;
  return j;
}

function skipWs(s: string, i: number): number {
  let j = i;
  while (j < s.length && " \t\r\n".includes(s.charAt(j))) j += 1;
  return j;
}

export function salvage(s: string): unknown {
  const t = s.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    // 继续尽力
  }
  if (!t.startsWith("{")) return undefined;
  const out: Record<string, unknown> = {};
  let i = skipWs(t, 0);
  i = skipWs(t, i + 1); // 过 {
  while (i < t.length) {
    i = skipWs(t, i);
    if (t[i] === "}") break;
    if (t[i] !== '"') break;
    const keyEnd = stringEnd(t, i);
    if (keyEnd === -1) break;
    const key = JSON.parse(t.slice(i, keyEnd)) as string;
    i = skipWs(t, keyEnd);
    if (t[i] !== ":") break;
    i = skipWs(t, i + 1);
    const vEnd = valueEnd(t, i);
    if (vEnd === -1 || vEnd > t.length) break;
    const valStr = t.slice(i, vEnd);
    try {
      out[key] = JSON.parse(valStr);
    } catch {
      break;
    }
    i = skipWs(t, vEnd);
    if (t[i] === ",") {
      i = skipWs(t, i + 1);
      continue;
    }
    if (t[i] === "}") break;
    break;
  }
  return out;
}

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

// S3 派发器:dialect=anthropic-messages → anthropicStream;else openai(已有)。
// withRetry 统一包一层(两边共 Transport 缝)。S1 缝签名不变 → 上层零改动(AC-S3-3)。
export function createStream(config: ProviderConfig, deps?: StreamDeps): StreamFn {
  const transport = withRetry(deps?.transport ?? defaultTransport, 1);
  return function stream(context: LoopContext, signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    return config.dialect === "anthropic-messages"
      ? anthropicStream(config, transport, context, signal)
      : openaiStream(config, transport, context, signal);
  };
}

// mini 内部消息 → openai chat 线格式(story 14 配对靠 tool_call_id):
// user 原样;assistant text 拼接 + toolCall→tool_calls(arguments 必须 JSON 字符串);
// toolResult→{role:"tool",tool_call_id};thinking 块不回传(UI 用,provider 无此通道)。
// systemPrompt → 首位 system 消息(Story 31)。
function toOpenaiMessages(context: LoopContext): unknown[] {
  const out: unknown[] = [];
  if (context.systemPrompt) out.push({ role: "system", content: context.systemPrompt });
  for (const m of context.messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      let text = "";
      const calls: unknown[] = [];
      for (const b of m.content) {
        if (b.type === "text") text += b.text;
        else if (b.type === "toolCall") {
          calls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.arguments ?? {}) },
          });
        }
      }
      out.push({
        role: "assistant",
        content: calls.length > 0 ? text || null : text,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
    } else {
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId,
        content: m.content.map((t) => t.text).join(""),
      });
    }
  }
  return out;
}

function openaiStream(
  config: ProviderConfig,
  transport: Transport,
  context: LoopContext,
  signal?: AbortSignal,
): AsyncIterable<ProviderEvent> {
  return (async function* () {
    const url = `${config.base_url}/chat/completions`;
    const key = process.env[config.key_env] ?? "";
    const model = config.models[0]?.id ?? "";
    // AC-S4-2 前置:context.tools → openai function-tool 数组(透传 name/description/parameters)。
    // 缺省不发 tools 字段(空数组部分 API 拒收)。
    const body: Record<string, unknown> = {
      model,
      messages: toOpenaiMessages(context),
      stream: true,
    };
    if (Array.isArray(context.tools) && context.tools.length > 0) {
      body.tools = context.tools.map((t: any) => ({
        type: "function",
        function: {
          name: t?.name,
          ...(t?.description ? { description: t.description } : {}),
          ...(t?.parameters ? { parameters: t.parameters } : {}),
        },
      }));
    }
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    };
    const tc = new Map<number, { id: string; name: string; argString: string }>();
    yield { type: "start" };
    try {
      for await (const line of transport(url, init, signal)) {
        const data = line.startsWith("data: ") ? line.slice(6) : line.trim();
        if (!data || data === "[DONE]") continue;
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue; // 非 JSON 行跳过(openai 注释行等)
        }
        const choice = json.choices?.[0];
        const delta = choice?.delta ?? {};
        if (typeof delta.content === "string" && delta.content) {
          yield { type: "text_delta", delta: delta.content };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const c of delta.tool_calls) {
            const idx: number = c.index ?? 0;
            const cur = tc.get(idx) ?? { id: "", name: "", argString: "" };
            if (c.id) cur.id = c.id;
            if (c.function?.name) cur.name = c.function.name;
            if (typeof c.function?.arguments === "string") {
              cur.argString += c.function.arguments;
            }
            tc.set(idx, cur);
            const parsed = salvage(cur.argString);
            if (
              parsed &&
              (typeof parsed !== "object" || Object.keys(parsed as object).length > 0)
            ) {
              yield {
                type: "toolcall_delta",
                id: cur.id,
                name: cur.name,
                arguments: parsed,
              };
            }
          }
        }
        const finish = choice?.finish_reason;
        if (finish) {
          const usage: Usage | undefined = json.usage
            ? {
                prompt_tokens: json.usage.prompt_tokens ?? 0,
                completion_tokens: json.usage.completion_tokens ?? 0,
              }
            : undefined;
          // AC-S1-7:定稿时校验所有 toolCall arguments 可解析;
          // 任一截断不可解析 → 整批拒执,流 error,不产 done。
          const bad = [...tc.values()].find((c) => {
            try {
              JSON.parse(c.argString);
              return false;
            } catch {
              return true;
            }
          });
          if (bad) {
            yield {
              type: "error",
              stopReason: "error",
              errorMessage: `toolcall ${bad.id || "?"} arguments truncated`,
            };
          } else {
            const stopReason = FINISH_TO_STOP[finish] ?? "error";
            yield { type: "done", stopReason, usage };
          }
        }
      }
    } catch (e) {
      yield {
        type: "error",
        stopReason: "error",
        errorMessage: e instanceof Error ? e.message : String(e),
      };
    }
  })();
}
