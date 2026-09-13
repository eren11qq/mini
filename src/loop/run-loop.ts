import type {
  AgentEvent,
  AssistantMessage,
  LoopContext,
  RunLoopOptions,
  StreamFn,
  TextBlock,
} from "./types.ts";

// mini runLoop:L1 骨架。纯文本 1 圈停。
// 双层 while 形状照抄 pi(steering/followUp 队列不挂 → 外层一次即退)。
// L1 只覆盖:streamFn 吐 text_delta + done(stopReason 非 tool_use)。
export async function* runLoop(
  streamFn: StreamFn,
  _tools: unknown,
  context: LoopContext,
  _options: RunLoopOptions,
): AsyncGenerator<AgentEvent> {
  const newMessages: AssistantMessage[] = [];

  yield { type: "agent_start" };
  yield { type: "turn_start" };

  // ---- stream 一轮 assistant response ----
  const partial: AssistantMessage = {
    role: "assistant",
    content: [],
    stopReason: "stop",
  };
  let pushed = false;

  for await (const event of streamFn(context)) {
    switch (event.type) {
      case "start": {
        pushed = true;
        context.messages.push(partial);
        yield { type: "message_start", message: snapshot(partial) };
        break;
      }
      case "text_delta": {
        appendText(partial, event.delta);
        if (pushed) context.messages[context.messages.length - 1] = partial;
        yield { type: "message_update", message: snapshot(partial) };
        break;
      }
      case "done": {
        partial.stopReason = event.stopReason;
        if (pushed) context.messages[context.messages.length - 1] = partial;
        yield { type: "message_end", message: snapshot(partial) };
        break;
      }
      default:
        // thinking_delta / toolcall_delta / error → L2/L3 覆盖
        break;
    }
    if (event.type === "done") break;
  }

  newMessages.push(partial);

  // L1:无 toolCall → toolResults 空
  yield { type: "turn_end", message: partial, toolResults: [] };
  yield { type: "agent_end", messages: newMessages };
}

function snapshot(m: AssistantMessage): AssistantMessage {
  return { ...m, content: [...m.content] };
}

function appendText(m: AssistantMessage, delta: string): void {
  const last = m.content[m.content.length - 1];
  if (last && last.type === "text") {
    (last as TextBlock).text += delta;
  } else {
    m.content.push({ type: "text", text: delta });
  }
}
