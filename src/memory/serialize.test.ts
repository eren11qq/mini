// H3 S-c 纯缝:serializeConversation —— 生产 summarizeFn 的对话正文单源(M4 注:上层把
// serializeConversation(messages) 拼在 buildSummarizePrompt 后面)。断言 = 独立手写字面量,
// 不按实现反推(反 tautological)。
import { describe, expect, it } from "vitest";
import { serializeConversation } from "./serialize.ts";
import type { AgentMessage } from "../loop/types.ts";

const msg = (role: string, extra: Record<string, unknown>): AgentMessage =>
  ({ role, ...extra }) as unknown as AgentMessage;

describe("S-c serializeConversation", () => {
  it("AC-H3-接线 user/assistant/toolCall/toolResult → 各成 [role] 行;thinking 块丢;多 text 块多行", () => {
    const msgs: AgentMessage[] = [
      msg("user", { content: "读下 package.json" }),
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "内部推理不该进纪要" },
          { type: "text", text: "好的" },
          { type: "toolCall", id: "t1", name: "read", arguments: { path: "package.json" } },
        ],
        stopReason: "tool_use",
      },
      msg("toolResult", {
        toolCallId: "t1",
        toolName: "read",
        content: [{ type: "text", text: "{ name: mini }" }],
        isError: false,
      }),
    ];
    expect(serializeConversation(msgs)).toBe(
      "[user] 读下 package.json\n" +
        "[assistant] 好的\n" +
        '[toolCall] read {"path":"package.json"}\n' +
        "[toolResult] read { name: mini }",
    );
  });

  it("AC-H3-接线 isError 带标记(失败也是纪要该知道的信号)", () => {
    const out = serializeConversation([
      msg("toolResult", {
        toolCallId: "t1",
        toolName: "bash",
        content: [{ type: "text", text: "user rejected: bash" }],
        isError: true,
      }),
    ]);
    expect(out).toBe("[toolResult isError] bash user rejected: bash");
  });

  it("AC-H3-接线 空数组 → 空串;纯 thinking assistant → 整条不发声", () => {
    expect(serializeConversation([])).toBe("");
    const onlyThinking: AgentMessage[] = [
      { role: "assistant", content: [{ type: "thinking", text: "…" }], stopReason: "stop" },
    ];
    expect(serializeConversation(onlyThinking)).toBe("");
  });
});
