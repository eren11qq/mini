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
} from "../loop/types.js";

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

// 真 transport:fetch POST 取 SSE,逐行 yield。signal 透传给 fetch(L3 abort 兜底)。
// 非 ok 抛 TransportError(S2 retry 据 status 区分 5xx/4xx)。
const defaultTransport: Transport = async function* (url, init, signal) {
  const res = await fetch(url, { ...init, signal });
  if (!res.ok || !res.body) {
    throw new TransportError(`HTTP ${res.status}`, { status: res.status });
  }
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
  if (buf) yield buf;
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
      try {
        for await (const line of transport(url, init, signal)) yield line;
        return;
      } catch (e) {
        lastErr = e;
        if (attempt < retries && isRetryable(e)) continue;
        throw e;
      }
    }
    throw lastErr;
  };
}

export function createStream(config: ProviderConfig, deps?: StreamDeps): StreamFn {
  const base = deps?.transport ?? defaultTransport;
  const transport = withRetry(base, 1);
  return function stream(context: LoopContext): AsyncIterable<ProviderEvent> {
    return (async function* () {
      const url = `${config.base_url}/chat/completions`;
      const key = process.env[config.key_env] ?? "";
      const model = config.models[0]?.id ?? "";
      const init: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: context.messages,
          stream: true,
        }),
      };
      const tc = new Map<number, { id: string; name: string; argString: string }>();
      yield { type: "start" };
      try {
        for await (const line of transport(url, init)) {
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
  };
}
