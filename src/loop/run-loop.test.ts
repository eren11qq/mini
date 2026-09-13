import { describe, it, expect } from "vitest";
import { runLoop } from "./run-loop.js";
import type {
  AgentEvent,
  AssistantMessage,
  LoopContext,
  ProviderEvent,
  StreamFn,
} from "./types.js";

// AC-L1-2:纯文本一轮停
// Scenario:假 streamFn 只吐 text_delta 序列(无 toolCall),done stopReason 非 tool_use
// Expected:事件序列 agent_start→turn_start→message_start→message_update*→message_end→turn_end→agent_end;
//         context.messages 末位一条 assistant message 含本轮全部 text;循环停止
async function* fakeTextStream(): AsyncIterable<ProviderEvent> {
  yield { type: "start" };
  yield { type: "text_delta", delta: "Hello" };
  yield { type: "text_delta", delta: " world" };
  yield { type: "done", stopReason: "stop" };
}

describe("AC-L1-2 纯文本一轮停", () => {
  it("流出七段事件序列且 messages 末位含全部 text", async () => {
    const streamFn: StreamFn = () => fakeTextStream();
    const context: LoopContext = { messages: [] };

    const events: AgentEvent[] = [];
    for await (const ev of runLoop(streamFn, {}, context, {})) {
      events.push(ev);
    }

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_update",
      "message_update",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
    // agent_end 后无 turn_start(停止判定)
    const agentEndIdx = types.indexOf("agent_end");
    const afterEnd = types.slice(agentEndIdx + 1);
    expect(afterEnd.filter((t) => t === "turn_start")).toHaveLength(0);

    // context.messages 末位一条 assistant message 含本轮全部 text
    expect(context.messages).toHaveLength(1);
    const last = context.messages[0];
    expect(last?.role).toBe("assistant");
    const assistant = last as AssistantMessage;
    expect(assistant.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(assistant.stopReason).toBe("stop");
  });

  it("无 toolCall 停止判定:done stopReason 非 tool_use → 不开新 turn(AC-L1-3)", async () => {
    const streamFn: StreamFn = () => fakeTextStream();
    const context: LoopContext = { messages: [] };

    const events: AgentEvent[] = [];
    for await (const ev of runLoop(streamFn, {}, context, {})) {
      events.push(ev);
    }

    const turnStarts = events.filter((e) => e.type === "turn_start");
    expect(turnStarts).toHaveLength(1);
  });
});
