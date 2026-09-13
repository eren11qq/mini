// S3 anthropic-messages 适配器:把 anthropic messages SSE 翻成统一 ProviderEvent。
// thinking 块 → thinking_delta;text 块 → text_delta;tool_use 块 input_json_delta 累积
// + 复用 openai salvage → toolcall_delta。usage(input_tokens/output_tokens → prompt/completion)。
// 与 openai 共用 Transport 缝 + withRetry(createStream 派发器统一包一层)。
import type {
  LoopContext,
  ProviderConfig,
  ProviderEvent,
  StopReason,
  Transport,
  Usage,
} from "../loop/types.js";
import { salvage } from "./openai-completions.js";

const STOP_TO_REASON: Record<string, StopReason> = {
  end_turn: "stop",
  tool_use: "tool_use",
  max_tokens: "length",
  stop_sequence: "stop",
};

// 定稿时校验所有 toolCall arguments 可解析(同 AC-S1-7 语义);截断 → 整批拒执。
function hasBadToolcall(tc: Map<number, { id: string; name: string; argString: string }>) {
  for (const c of tc.values()) {
    try {
      JSON.parse(c.argString);
    } catch {
      return c;
    }
  }
  return undefined;
}

export function anthropicStream(
  config: ProviderConfig,
  transport: Transport,
  context: LoopContext,
): AsyncIterable<ProviderEvent> {
  return (async function* () {
    const url = `${config.base_url}/messages`;
    const key = process.env[config.key_env] ?? "";
    const model = config.models[0]?.id ?? "";
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        messages: context.messages,
        max_tokens: 8192,
        stream: true,
      }),
    };
    const tc = new Map<number, { id: string; name: string; argString: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    yield { type: "start" };
    try {
      for await (const line of transport(url, init)) {
        if (line.startsWith("event:")) continue;
        const data = line.startsWith("data: ") ? line.slice(6) : line.trim();
        if (!data || data === "[DONE]") continue;
        let json: any;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        const t = json.type;
        if (t === "message_start" && json.message?.usage) {
          inputTokens = json.message.usage.input_tokens ?? 0;
          outputTokens = json.message.usage.output_tokens ?? 0;
        } else if (t === "content_block_start") {
          const cb = json.content_block;
          if (cb?.type === "tool_use") {
            const idx: number = json.index ?? 0;
            tc.set(idx, { id: cb.id ?? "", name: cb.name ?? "", argString: "" });
          }
        } else if (t === "content_block_delta") {
          const d = json.delta;
          if (d?.type === "thinking_delta" && typeof d.thinking === "string") {
            yield { type: "thinking_delta", delta: d.thinking };
          } else if (d?.type === "text_delta" && typeof d.text === "string") {
            yield { type: "text_delta", delta: d.text };
          } else if (d?.type === "input_json_delta" && typeof d.partial_json === "string") {
            const idx: number = json.index ?? 0;
            const cur = tc.get(idx) ?? { id: "", name: "", argString: "" };
            cur.argString += d.partial_json;
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
        } else if (t === "message_delta") {
          if (json.usage?.output_tokens !== undefined) {
            outputTokens = json.usage.output_tokens;
          }
          const stopReason: StopReason = STOP_TO_REASON[json.delta?.stop_reason] ?? "stop";
          const bad = hasBadToolcall(tc);
          if (bad) {
            yield {
              type: "error",
              stopReason: "error",
              errorMessage: `toolcall ${bad.id || "?"} arguments truncated`,
            };
            return;
          }
          const usage: Usage = {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
          };
          yield { type: "done", stopReason, usage };
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
