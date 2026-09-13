import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  LoopContext,
  RunLoopOptions,
  StreamFn,
  TextBlock,
  Tool,
  ToolCallBlock,
  ToolResult,
  ToolResultMessage,
} from "./types.ts";

// mini runLoop:L2。toolCall 执行 + toolResult 回填 + 同批串行 + maxTurns 保险丝。
// 双层 while 形状照抄 pi(steering/followUp 队列不挂 → 外层由停止条件退)。
// loop 层零 try/catch:工具失败靠 run 返回 isError:true ToolResult 回喂(L3 error 进流同约束)。
// confirm gate 留 T2(beforeToolCall hook),L2 工具直接执行。
export async function* runLoop(
  streamFn: StreamFn,
  tools: Tool[],
  context: LoopContext,
  options: RunLoopOptions,
): AsyncGenerator<AgentEvent> {
  // PRD:maxTurns=50 唯一故意偏离(保险丝)。可配,缺省 50。
  const maxTurns = options.maxTurns ?? 50;
  const newMessages: AgentMessage[] = [];

  yield { type: "agent_start" };

  let turnCount = 0;
  while (true) {
    // maxTurns 保险丝:已达上限 → 强制停并告知(AC-L2-4/L2-5)。
    if (turnCount >= maxTurns) {
      yield { type: "agent_end", messages: newMessages, reason: "maxTurns" };
      return;
    }
    turnCount += 1;
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
        case "toolcall_delta": {
          applyToolCallDelta(partial, event);
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
          // thinking_delta / error → L3 覆盖
          break;
      }
      if (event.type === "done") break;
    }

    newMessages.push(partial);

    // 停止条件①:无 toolCall(stopReason 非 tool_use)→ 自然停(L1 行为)。
    if (partial.stopReason !== "tool_use") {
      yield { type: "turn_end", message: partial, toolResults: [] };
      yield { type: "agent_end", messages: newMessages };
      return;
    }

    // ---- 同批 toolCall 串行执行(AC-L2-3)----
    const toolCalls = partial.content.filter((b): b is ToolCallBlock => b.type === "toolCall");
    const toolResults: ToolResultMessage[] = [];
    for (const call of toolCalls) {
      const tool = tools.find((t) => t.name === call.name);
      yield {
        type: "tool_execution_start",
        toolCallId: call.id,
        toolName: call.name,
        args: call.arguments,
      };
      // 工具不在注册表 → error result 回喂(不断循环)。tool.run 契约不 throw。
      const result: ToolResult = tool
        ? await tool.run(call.arguments)
        : { content: [{ type: "text", text: `tool not found: ${call.name}` }], isError: true };
      yield {
        type: "tool_execution_end",
        toolCallId: call.id,
        toolName: call.name,
        result,
        isError: result.isError,
      };
      const resultMsg: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        isError: result.isError,
      };
      context.messages.push(resultMsg);
      newMessages.push(resultMsg);
      toolResults.push(resultMsg);
    }

    yield { type: "turn_end", message: partial, toolResults };
    // 继续 next turn(模型收 toolResult 后决定停或续)
  }
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

// toolcall_delta 载 parsed args prefix;loop 取最新 arguments 快照(salvage 归 S1)。
// 同 id 的块累积更新;新 id 建块。name 随 delta 更新(适配器定稿前可能先发 name)。
function applyToolCallDelta(
  m: AssistantMessage,
  event: { id: string; name: string; arguments: unknown },
): void {
  const existing = m.content.find(
    (b): b is ToolCallBlock => b.type === "toolCall" && b.id === event.id,
  );
  if (existing) {
    existing.name = event.name;
    existing.arguments = event.arguments;
  } else {
    m.content.push({
      type: "toolCall",
      id: event.id,
      name: event.name,
      arguments: event.arguments,
    });
  }
}
