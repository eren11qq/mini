// S1 openai-completions 适配器:把 deepseek/openai-completions 方言的 SSE
// 翻成统一 ProviderEvent 协议。loop 缝 = StreamFn(context);config 由 core.ts 派发时传入。
// 零网络靠 Transport 注入缝(transport.ts):假 transport 回放 SSE 行,真 transport = fetch 流式读。
// error 一律编码进流、不 throw(loop 层零 try/catch 约束)。
// 卡 1(ADR-003)纯搬迁后本文件只留 openai 线格式:toOpenaiMessages + openaiStream;
// transport/retry/salvage/派发器已迁 core.ts + transport.ts + salvage.ts,逻辑逐字未动。
import type { LoopContext, StopReason, Usage } from "../loop/types.ts";
import type { ProviderConfig, ProviderEvent, Transport } from "./protocol.ts";
import { salvage } from "./salvage.ts";

const FINISH_TO_STOP: Record<string, StopReason> = {
  stop: "stop",
  tool_calls: "tool_use",
  length: "length",
  content_filter: "error",
};

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

// 由 core.ts createStream 派发调用;transport 已过 withRetry 包装。
export function openaiStream(
  config: ProviderConfig,
  transport: Transport,
  context: LoopContext,
  signal?: AbortSignal,
): AsyncIterable<ProviderEvent> {
  return (async function* () {
    const url = `${config.base_url}/chat/completions`;
    const key = process.env[config.key_env] ?? "";
    const model = config.models[0]?.id ?? "";
    // AC-S4-2 前置:注册表 Tool[] → openai function-tool 数组(卡 4:映射归方言,schema 直读)。
    // 缺省不发 tools 字段(空数组部分 API 拒收)。
    const body: Record<string, unknown> = {
      model,
      messages: toOpenaiMessages(context),
      stream: true,
    };
    if (context.tools && context.tools.length > 0) {
      body.tools = context.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          ...(t.schema ? { parameters: t.schema } : {}),
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
