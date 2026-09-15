// S3 anthropic-messages 适配器:把 anthropic messages SSE 翻成统一 ProviderEvent。
// thinking 块 → thinking_delta;text 块 → text_delta;tool_use 块 input_json_delta 累积
// + 复用 salvage(salvage.ts)→ toolcall_delta。usage(input_tokens/output_tokens → prompt/completion)。
// 与 openai 共用 Transport 缝 + withRetry(transport.ts),由 core.ts createStream 派发并统一包一层。
// 卡 1(ADR-003):salvage 改从叶子导入,双方言互 import 的环已斩断。
import type {
  LoopContext,
  ProviderConfig,
  ProviderEvent,
  StopReason,
  Transport,
  Usage,
} from "../loop/types.ts";
import { salvage } from "./salvage.ts";

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

// mini 内部消息 → anthropic messages 线格式:
// assistant toolCall→tool_use(input 为对象,免 JSON 字符串,异于 openai);
// toolResult→user.tool_result,连续多条并入同一 user 消息(API 要求 role 交替);
// thinking 块不回传(无 signature 的 thinking 会被真 API 拒),仅 UI 用(H1 淡显)。
// systemPrompt → body.system(Story 31)。
function toAnthropicMessages(context: LoopContext): { role: string; content: unknown[] }[] {
  const out: { role: string; content: unknown[] }[] = [];
  for (const m of context.messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: [{ type: "text", text: m.content }] });
    } else if (m.role === "assistant") {
      const blocks: unknown[] = [];
      for (const b of m.content) {
        if (b.type === "text") blocks.push({ type: "text", text: b.text });
        else if (b.type === "toolCall") {
          blocks.push({ type: "tool_use", id: b.id, name: b.name, input: b.arguments ?? {} });
        }
      }
      if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
    } else {
      const block = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content.map((t) => t.text).join(""),
        is_error: m.isError,
      };
      const last = out[out.length - 1];
      const lastIsToolResult =
        last?.role === "user" &&
        (last.content[0] as { type?: string } | undefined)?.type === "tool_result";
      if (lastIsToolResult) last!.content.push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  return out;
}

export function anthropicStream(
  config: ProviderConfig,
  transport: Transport,
  context: LoopContext,
  signal?: AbortSignal,
): AsyncIterable<ProviderEvent> {
  return (async function* () {
    const url = `${config.base_url}/messages`;
    const key = process.env[config.key_env] ?? "";
    const model = config.models[0]?.id ?? "";
    const body: Record<string, unknown> = {
      model,
      messages: toAnthropicMessages(context),
      max_tokens: 8192,
      stream: true,
    };
    if (context.systemPrompt) body.system = context.systemPrompt;
    // tools:同 openai 线的注册表形态 {name,description,parameters} → input_schema。缺省不发。
    if (Array.isArray(context.tools) && context.tools.length > 0) {
      body.tools = context.tools.map((t: any) => ({
        name: t?.name,
        ...(t?.description ? { description: t.description } : {}),
        input_schema: t?.parameters ?? { type: "object", properties: {} },
      }));
    }
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // 双鉴权头:真 api.anthropic.com 认 x-api-key;token-plan relay 常收
        // Authorization: Bearer。同一 key 发两路,两边都兼容。
        "x-api-key": key,
        Authorization: `Bearer ${key}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    };
    const tc = new Map<number, { id: string; name: string; argString: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    yield { type: "start" };
    try {
      for await (const line of transport(url, init, signal)) {
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
