import { describe, expect, it } from "vitest";
import { eventToEntries, repairDangling, turnsSinceLastUser } from "./journal.ts";
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from "../loop/types.ts";

// D1(docs/ISSUES.md)纯叶锚测:AgentEvent → session append entry 的分发表。
// 现行 bug 靶心:cli 只订阅 message_end,toolResult 从不落盘 → --continue 悬空 toolCall 喂
// provider 必 400。本表 = 修复的裁决面(零 fs 零网络);cli 订阅环只查表,裁决零渗。
// entry 类型零新增(仍 5 类,toolResult 走现有 "message" payload)—— 故事 6。

const assistant: AssistantMessage = {
  role: "assistant",
  content: [
    { type: "text", text: "跑一下" },
    { type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo hi" } },
  ],
  stopReason: "tool_use",
  usage: { prompt_tokens: 10, completion_tokens: 2 },
};

describe("D1 eventToEntries — message_end(现行落盘行为逐字节不变)", () => {
  it("assistant message_end → 恰一条 {type:message},payload = 该 AssistantMessage 序列化逐字节同", () => {
    const entries = eventToEntries({ type: "message_end", message: assistant });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("message");
    expect(JSON.stringify(entries[0]!.payload)).toBe(JSON.stringify(assistant));
  });
});

describe("D1 eventToEntries — tool_execution_end(bug 修复本体)", () => {
  it("成功工具 → 恰一条 message entry,payload = ToolResultMessage 字段完整", () => {
    const entries = eventToEntries({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "exit code 0\nhi" }], isError: false },
      isError: false,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      type: "message",
      payload: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [{ type: "text", text: "exit code 0\nhi" }],
        isError: false,
      } satisfies ToolResultMessage,
    });
  });

  it("isError 工具 → payload.isError=true 照事件", () => {
    const entries = eventToEntries({
      type: "tool_execution_end",
      toolCallId: "c2",
      toolName: "bash",
      result: { content: [{ type: "text", text: "boom" }], isError: true },
      isError: true,
    });
    expect((entries[0]!.payload as ToolResultMessage).isError).toBe(true);
  });

  it("展示侧信道与 terminate 不漏进 entry(持久化只走 content,照 run-loop resultMsg 构造)", () => {
    const entries = eventToEntries({
      type: "tool_execution_end",
      toolCallId: "c3",
      toolName: "edit",
      result: {
        content: [{ type: "text", text: "ok" }],
        isError: false,
        terminate: true,
        details: { kind: "diff", rows: [] },
      },
      isError: false,
    });
    expect(Object.keys(entries[0]!.payload as object).sort()).toEqual([
      "content",
      "isError",
      "role",
      "toolCallId",
      "toolName",
    ]);
  });
});

describe("D1 eventToEntries — 其余 8 类事件 → 零条", () => {
  const others: AgentEvent[] = [
    { type: "agent_start" },
    { type: "agent_end", messages: [] },
    { type: "turn_start" },
    { type: "turn_end", message: assistant, toolResults: [] },
    { type: "message_start", message: assistant },
    { type: "message_update", message: assistant },
    { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: {} },
    {
      type: "tool_execution_update",
      toolCallId: "c1",
      toolName: "bash",
      args: {},
      partialResult: {},
    },
  ];
  for (const e of others) {
    it(`${e.type} → []`, () => {
      expect(eventToEntries(e)).toEqual([]);
    });
  }
});

// —— D1 刀2:悬空配对修复(接 rebuild 出口的纯函数;崩溃批次的 toolCall 在盘上无结果,
// 注入「结果未知」合成行 → wire 配对完整 + 模型被明告副作用状态,不盲目重跑 bash)。
const user: UserMessage = { role: "user", content: "go" };
const call = (id: string, name = "bash"): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: { command: "sleep 30" } }],
  stopReason: "tool_use",
});
const calls = (ids: [string, string], name = "bash"): AssistantMessage => ({
  role: "assistant",
  content: ids.map((id) => ({
    type: "toolCall" as const,
    id,
    name,
    arguments: { command: "sleep 30" },
  })),
  stopReason: "tool_use",
});
const result = (id: string): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "bash",
  content: [{ type: "text", text: "exit code 0" }],
  isError: false,
});
// 卡定稿文案(逐字,两方言 e2e 断锚 + AC「结果未知」引用同源)。
const REPAIR_TEXT =
  "interrupted before result was persisted — 副作用可能已发生,先核实(bash 重跑前查盘)再重试";

describe("D1 repairDangling — 末条 assistant 悬空 toolCall 补位", () => {
  it("无悬空 = diff-0(返回同内容数组、injected 空、输入零突变)", () => {
    const msgs: AgentMessage[] = [user, call("c1"), result("c1")];
    const snapshot = JSON.parse(JSON.stringify(msgs)) as AgentMessage[];
    const { messages, injected } = repairDangling(msgs);
    expect(injected).toEqual([]);
    expect(messages).toEqual(snapshot);
    expect(msgs).toEqual(snapshot); // 纯函数:绝不去改调用方数组
  });

  it("空数组 = diff-0", () => {
    const { messages, injected } = repairDangling([]);
    expect(injected).toEqual([]);
    expect(messages).toEqual([]);
  });

  it("两缺其一 = 只补缺位那条(c1 在、c2 悬空)", () => {
    const { messages, injected } = repairDangling([user, calls(["c1", "c2"]), result("c1")]);
    expect(injected).toHaveLength(1);
    expect(messages.at(-1)).toEqual({
      role: "toolResult",
      toolCallId: "c2",
      toolName: "bash",
      content: [{ type: "text", text: REPAIR_TEXT }],
      isError: true,
    });
    expect(injected[0]).toEqual(messages.at(-1));
  });

  it("末条 assistant 非 tool_use = 不动(即便其后啥都没有)", () => {
    const done: AssistantMessage = { role: "assistant", content: [], stopReason: "stop" };
    const { messages, injected } = repairDangling([user, done]);
    expect(injected).toEqual([]);
    expect(messages).toHaveLength(2);
  });

  it("多 toolCall 全缺 = 按调用序全补", () => {
    const a3: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "x1", name: "read", arguments: {} },
        { type: "toolCall", id: "x2", name: "bash", arguments: { command: "ls" } },
        { type: "toolCall", id: "x3", name: "read", arguments: {} },
      ],
      stopReason: "tool_use",
    };
    const { messages, injected } = repairDangling([user, a3]);
    expect(injected.map((m) => [m.toolCallId, m.toolName])).toEqual([
      ["x1", "read"],
      ["x2", "bash"],
      ["x3", "read"],
    ]);
    expect(messages.slice(1)).toEqual([a3, ...injected]);
    expect(injected.every((m) => m.isError === true)).toBe(true);
  });

  it("只看末条 assistant:更早的悬空批次不在射程(compaction 之后窗口自洽)", () => {
    // 早前 assistant(c9)缺结果,但末条 assistant 是 stop → 整体不动(配对判据 = 卡片字面)。
    const old = call("c9");
    const done: AssistantMessage = { role: "assistant", content: [], stopReason: "stop" };
    const { injected } = repairDangling([user, old, user, done]);
    expect(injected).toEqual([]);
  });

  it("补位插在该批已有结果之后、而非数组尾(wire 要求 tool 紧跟带 tool_calls 的 assistant)", () => {
    // 盘上场景:崩溃批 assistant(c1,c2)只落 tr(c1) → 用户 --continue 后又发 user2 并落了盘;
    // 若把 c2 的补位 append 到 user2 之后,openai 方言必 400(tool 消息不跟 assistant)。
    const a = calls(["c1", "c2"]);
    const { messages } = repairDangling([user, a, result("c1"), user]);
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult", // ← 补位在此,不是尾
      "user",
    ]);
    expect((messages[3] as ToolResultMessage).toolCallId).toBe("c2");
  });

  it("该批零结果落盘 = 补位紧跟 assistant 之后", () => {
    const a = call("c1");
    const { messages } = repairDangling([user, a, user]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "user"]);
  });
});

// —— D1 刀3:maxTurns 保险丝跨 resume 续计。偏移 = 重建 messages「末条 user 之后的 assistant
// 数」(跑飞一轮烧掉的 turn);cli 组 options 时以 50 − 偏移传入既有 maxTurns,loop 零改动。
const plainA = (): AssistantMessage => ({ role: "assistant", content: [], stopReason: "stop" });
const trRes = (id: string): ToolResultMessage => result(id);

describe("D1 turnsSinceLastUser — 烧掉 turn 数派生", () => {
  it("空数组 / 末条 user 未回 = 0", () => {
    expect(turnsSinceLastUser([])).toBe(0);
    expect(turnsSinceLastUser([user, plainA(), user])).toBe(0);
  });

  it("末条 user 之后两个 assistant = 2(toolResult 不计数)", () => {
    expect(
      turnsSinceLastUser([user, plainA(), user, plainA(), trRes("c9"), plainA(), trRes("c8")]),
    ).toBe(2);
  });

  it("中途 user 重置窗口:老会话长尾归零,只数最后一次提问之后", () => {
    const long = [plainA(), plainA(), plainA(), user, plainA(), user, plainA()];
    expect(turnsSinceLastUser(long)).toBe(1);
  });
});
