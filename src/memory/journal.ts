// D1(docs/ISSUES.md)纯叶:AgentEvent → SessionManager append entry 的分发表(裁决零 fs 零网络)。
// 为什么住 memory 家:产物 shape 就是会话 entry(契约见 session-manager.ts),消费方 = cli 订阅环。
// 修复靶心:cli 从前硬编码只订阅 message_end → toolResult 从不落盘 → 带工具的会话 --continue
// 末条 assistant 悬空 toolCall、配对全缺,两方言 toWire 喂 provider 必 400。
// entry 类型零新增(仍 5 类):toolResult 走现有 "message" payload(故事 6,PRD-V2 缝裁决)。
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  ToolResultMessage,
} from "../loop/types.ts";
import type { ToolCallBlock } from "../blocks.ts";
import type { ToolResult } from "../tools/tool.ts";

export interface JournalEntry {
  type: "message";
  payload: AgentMessage;
}

// 表 = 事件到达序的单条映射:assistant 的 message_end 天然先于同批 tool_execution_end,
// cli 逐事件查表 append → 落盘顺序与内存 context.messages 构造顺序一致。
export function eventToEntries(event: AgentEvent): JournalEntry[] {
  switch (event.type) {
    case "message_end":
      return [{ type: "message", payload: event.message }];
    case "tool_execution_end": {
      // result 类型契约 = ToolResult(loop/types 照抄 pi 记 unknown);payload 只取
      // content/isError —— terminate/details 展示侧信道不落盘(run-loop resultMsg 同款构造)。
      const r = event.result as ToolResult;
      return [
        {
          type: "message",
          payload: {
            role: "toolResult",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            content: r.content,
            isError: event.isError,
          },
        },
      ];
    }
    default:
      return [];
  }
}

// —— D1 刀2:悬空配对修复。kill -9 落在工具批中途 → 盘上末条 assistant 停在 tool_use、
// 部分/全部 toolCall 无结果;rebuild 出口调用本函数注入合成行,loop/cli 零感知(接盘点 =
// session-manager.rebuild)。合成行永不落盘:盘 = append-only 真相源,修复是投影,每次
// rebuild 重推导(幂等:补过再喂 = diff-0)。toolName 取自 toolCall 块,配对靠 id。
// 判据按卡字面只盯「末条 assistant 且 stopReason==="tool_use"」;aborted 残批带 toolCall
// 的更老悬空不在射程(记 D1 卡注,待判卷)。
export const REPAIR_TEXT =
  "interrupted before result was persisted — 副作用可能已发生,先核实(bash 重跑前查盘)再重试";

export function repairDangling(messages: AgentMessage[]): {
  messages: AgentMessage[];
  injected: ToolResultMessage[];
} {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  const a = lastAssistant >= 0 ? (messages[lastAssistant] as AssistantMessage) : undefined;
  if (a === undefined || a.stopReason !== "tool_use") return { messages, injected: [] };

  const calls = a.content.filter((b): b is ToolCallBlock => b.type === "toolCall");
  const batchIds = new Set(calls.map((c) => c.id));
  const persisted = new Set<string>();
  let lastOwn = lastAssistant; // 插入点 = 该批末条已有结果之后(wire:tool 必紧跟 assistant)
  for (let i = lastAssistant + 1; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "toolResult" && batchIds.has(m.toolCallId)) {
      persisted.add(m.toolCallId);
      lastOwn = i;
    }
  }
  const injected: ToolResultMessage[] = calls
    .filter((c) => !persisted.has(c.id))
    .map((c) => ({
      role: "toolResult",
      toolCallId: c.id,
      toolName: c.name,
      content: [{ type: "text", text: REPAIR_TEXT }],
      isError: true,
    }));
  if (injected.length === 0) return { messages, injected: [] };
  return {
    messages: [...messages.slice(0, lastOwn + 1), ...injected, ...messages.slice(lastOwn + 1)],
    injected,
  };
}

// —— D1 刀3:maxTurns 保险丝跨 resume 续计的偏移派生(故事 5:杀了重开不洗白计数)。
// 窗口 = 末条 user 之后(与 loop 的「每次 runLoop 调用从 0 起计」同口径:一次用户请求 =
// 一个窗口);只数 assistant(一轮 = 一次 assistant 生成),toolResult 不占 turn。
// 消费方 = cli 组装 options:传 maxTurns = 50 − 本值(下限 0),loop 零改动。
export function turnsSinceLastUser(messages: AgentMessage[]): number {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      lastUser = i;
      break;
    }
  }
  let turns = 0;
  for (let i = lastUser + 1; i < messages.length; i++) {
    if (messages[i]!.role === "assistant") turns++;
  }
  return turns;
}
