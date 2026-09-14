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
  ThinkingBlock,
} from "./types.ts";
import { validateArgs } from "./validate.js";
import { appendRule, isValidSeed, loadRules, type Rule } from "./rules.js";

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
  const signal = options.signal;
  const newMessages: AgentMessage[] = [];
  // T2-7:rules 每次 agent run 开头读一遍(手删文件 = 下次 run 重新弹,撤销正路)。
  const rulesPath = options.rulesPath;
  let rules: Rule[] = rulesPath ? await loadRules(rulesPath) : [];

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
    let messageEnded = false;

    // Story 16:signal 传进 streamFn → 真 adapter 透传 transport→fetch(流可中断)。
    for await (const event of streamFn(context, signal)) {
      // AC-L3-4:外部 abort 缝内查。命中 → 该 turn 立即停。
      if (signal?.aborted) {
        partial.stopReason = "aborted";
        if (pushed) context.messages[context.messages.length - 1] = partial;
        yield { type: "message_end", message: snapshot(partial) };
        messageEnded = true;
        break;
      }
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
          // Story 9 / AC-S1-3:usage 透传落 AssistantMessage.usage(M3 压缩阈值数据源)。
          if (event.usage) partial.usage = event.usage;
          if (pushed) context.messages[context.messages.length - 1] = partial;
          yield { type: "message_end", message: snapshot(partial) };
          messageEnded = true;
          break;
        }
        case "error": {
          // AC-L3-2:provider error 编码进流,loop 不 throw。
          // 落 partial.stopReason/errorMessage → emit message_end → break →
          // 停止条件①判 stopReason 非 tool_use → turn_end + agent_end(reason)。
          partial.stopReason = event.stopReason;
          partial.errorMessage = event.errorMessage;
          if (!pushed) {
            context.messages.push(partial);
            pushed = true;
            yield { type: "message_start", message: snapshot(partial) };
          } else {
            context.messages[context.messages.length - 1] = partial;
          }
          yield { type: "message_end", message: snapshot(partial) };
          messageEnded = true;
          break;
        }
        case "thinking_delta": {
          // H1"thinking 淡显"来源:累积进 ThinkingBlock(同 text_delta 快照协议)。
          // 序列化回 provider 时 thinking 块会被方言适配器丢弃(不可回传),仅 UI 用。
          appendThinking(partial, event.delta);
          if (pushed) context.messages[context.messages.length - 1] = partial;
          yield { type: "message_update", message: snapshot(partial) };
          break;
        }
        default:
          break;
      }
      if (event.type === "done" || event.type === "error") break;
    }

    // AC-L3-4:stream 因 abort 自然结束(未发 done/error)→ 缝内查兜底。
    if (signal?.aborted && !messageEnded) {
      partial.stopReason = "aborted";
      if (pushed) context.messages[context.messages.length - 1] = partial;
      yield { type: "message_end", message: snapshot(partial) };
      messageEnded = true;
    }

    newMessages.push(partial);

    // 停止条件①:无 toolCall(stopReason 非 tool_use)→ 自然停(L1 行为)。
    // error/aborted 在此停:agent_end 带 reason(AC-L3-2 / AC-L3-6)。
    if (partial.stopReason !== "tool_use") {
      yield { type: "turn_end", message: partial, toolResults: [] };
      const reason =
        partial.stopReason === "error" || partial.stopReason === "aborted"
          ? partial.stopReason
          : undefined;
      yield {
        type: "agent_end",
        messages: newMessages,
        ...(reason !== undefined && { reason }),
      };
      return;
    }

    // ---- 同批 toolCall 串行执行(AC-L2-3)----
    // AC-L3-4:abort 在 tool 批前命中 → 不执行工具,该 turn 停。
    if (signal?.aborted) {
      partial.stopReason = "aborted";
      if (pushed) context.messages[context.messages.length - 1] = partial;
      yield { type: "turn_end", message: partial, toolResults: [] };
      yield { type: "agent_end", messages: newMessages, reason: "aborted" };
      return;
    }
    const toolCalls = partial.content.filter((b): b is ToolCallBlock => b.type === "toolCall");
    const toolResults: ToolResultMessage[] = [];
    let anyTerminate = false;
    for (const call of toolCalls) {
      const tool = tools.find((t) => t.name === call.name);
      yield {
        type: "tool_execution_start",
        toolCallId: call.id,
        toolName: call.name,
        args: call.arguments,
      };
      // 工具不在注册表 → error result 回喂(不断循环)。tool.run 契约不 throw。
      // AC-T2-4:schema 在 run 前校验(照 pi prepare→validate),失败 → error result,不执行 run。
      // Story 16 / T4:signal 透传给 run,bash 工具据此超时/中断杀进程树。
      let result: ToolResult;
      if (!tool) {
        result = {
          content: [{ type: "text", text: `tool not found: ${call.name}` }],
          isError: true,
        };
      } else {
        // 顺序照 pi prepare→validate→beforeToolCall:先挡无效 args,再费用户一次确认。
        const vErr = tool.schema ? validateArgs(tool.schema, call.arguments) : null;
        if (vErr !== null) {
          result = { content: [{ type: "text", text: vErr }], isError: true };
        } else {
          // AC-T2-5/6/7/8 beforeToolCall 确认门(逻辑在 loop,story 24;confirm 缺省 = 放行,
          // PRD line 100)。AC-T2-7:命中 rules(tool+prefix 相等)免弹;always 落盘,
          // `*`/空种子拒写(AC-T2-8 无一键全允许)退化为一次性 yes。
          const subject = tool.prefixOf?.(call.arguments) ?? JSON.stringify(call.arguments);
          const preapproved = rules.some((r) => r.tool === tool.name && r.prefix === subject);
          if (tool.skipConfirm || !options.confirm || preapproved) {
            result = await tool.run(call.arguments, signal);
          } else {
            const answer = options.confirm(
              `Execute: ${tool.name}(${JSON.stringify(call.arguments)})? ❯1 Yes / 2 Yes, always / 3 No`,
            );
            if (answer === "no") {
              result = {
                content: [{ type: "text", text: `user rejected: ${tool.name}` }],
                isError: true,
              };
            } else {
              result = await tool.run(call.arguments, signal);
              if (answer === "always" && rulesPath && isValidSeed(subject)) {
                rules = await appendRule(rulesPath, { tool: tool.name, prefix: subject });
              }
            }
          }
        }
      }
      yield {
        type: "tool_execution_end",
        toolCallId: call.id,
        toolName: call.name,
        result,
        isError: result.isError,
      };
      if (result.terminate) anyTerminate = true;
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

    // AC-L3-5:整批 terminate。某 ToolResult.terminate=true → 该批后停。
    if (anyTerminate) {
      yield { type: "agent_end", messages: newMessages, reason: "terminate" };
      return;
    }
    // 继续 next turn(模型收 toolResult 后决定停或续)
  }
}

function snapshot(m: AssistantMessage): AssistantMessage {
  // 深拷贝 content 块:TextBlock.text 不可变,但块本身随 delta 原地突变
  // (appendText 改 last.text += delta)。浅拷数组会让各快照共享同一块 →
  // 时间旅行错乱(AC-L3-3:message_end 前每快照内容 = 当时已收 delta)。
  return { ...m, content: m.content.map((b) => ({ ...b })) };
}

function appendText(m: AssistantMessage, delta: string): void {
  const last = m.content[m.content.length - 1];
  if (last && last.type === "text") {
    (last as TextBlock).text += delta;
  } else {
    m.content.push({ type: "text", text: delta });
  }
}

// thinking_delta 同 text_delta 累积语义:末块是 thinking 则拼接,否则新起一块
//(thinking 与 text 交错时各留各的块)。
function appendThinking(m: AssistantMessage, delta: string): void {
  const last = m.content[m.content.length - 1];
  if (last && last.type === "thinking") {
    (last as ThinkingBlock).text += delta;
  } else {
    m.content.push({ type: "thinking", text: delta });
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
