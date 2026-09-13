import { describe, it, expect } from "vitest";
import { runLoop } from "./run-loop.js";
import type {
  AgentEvent,
  AssistantMessage,
  LoopContext,
  ProviderEvent,
  StreamFn,
  Tool,
  ToolCallBlock,
  ToolResultMessage,
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
    for await (const ev of runLoop(streamFn, [], context, {})) {
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
    for await (const ev of runLoop(streamFn, [], context, {})) {
      events.push(ev);
    }

    const turnStarts = events.filter((e) => e.type === "turn_start");
    expect(turnStarts).toHaveLength(1);
  });
});

// AC-L2-2: 单次 toolCall 两圈停
// Scenario:假 streamFn 第 1 圈吐 toolcall_delta(done stopReason=tool_use),第 2 圈纯文本(stop)
// tools 注册表含假工具 echo(args)=>args
// Expected:第 1 圈 message_start→update→message_end→tool_execution_start→tool_execution_end→turn_end;
//         第 2 圈纯文本;停。messages 终态三条(user/assistant+toolCall/toolResult 配对)
// Must not:toolCallId 不匹配
function makeEchoTool(): Tool & { calls: unknown[] } {
  const calls: unknown[] = [];
  const tool: Tool & { calls: unknown[] } = {
    name: "echo",
    calls,
    async run(args: unknown) {
      calls.push(args);
      return {
        content: [{ type: "text", text: JSON.stringify(args) }],
        isError: false,
      };
    },
  };
  return tool;
}

// 第 1 圈:吐 toolcall_delta(stopReason=tool_use);第 2 圈:纯文本停。
// 用 context.messages 里 assistant 消息条数判第几圈。
async function* twoTurnStream(): AsyncIterable<ProviderEvent> {
  yield { type: "start" };
  yield { type: "toolcall_delta", id: "c1", name: "echo", arguments: { x: 1 } };
  yield { type: "done", stopReason: "tool_use" };
}

async function* secondTurnText(): AsyncIterable<ProviderEvent> {
  yield { type: "start" };
  yield { type: "text_delta", delta: "ok" };
  yield { type: "done", stopReason: "stop" };
}

describe("AC-L2-2 单次 toolCall 两圈停", () => {
  it("执行工具、回填 toolResult 配对、第 2 圈纯文本停", async () => {
    const echo = makeEchoTool();
    let turn = 0;
    const streamFn: StreamFn = () => {
      turn += 1;
      return turn === 1 ? twoTurnStream() : secondTurnText();
    };
    const context: LoopContext = {
      messages: [{ role: "user", content: "do echo" }],
      tools: [],
    };

    const events: AgentEvent[] = [];
    for await (const ev of runLoop(streamFn, [echo], context, {})) {
      events.push(ev);
    }

    // 关键子序列(过滤掉 message_update 噪声)
    const filtered = events
      .filter((e) =>
        [
          "message_start",
          "message_end",
          "tool_execution_start",
          "tool_execution_end",
          "turn_end",
          "agent_end",
        ].includes(e.type),
      )
      .map((e) => e.type);
    expect(filtered).toEqual([
      "message_start",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "turn_end",
      "message_start",
      "message_end",
      "turn_end",
      "agent_end",
    ]);

    // agent_end 后无 turn_start(停止)
    const endIdx = events.map((e) => e.type).indexOf("agent_end");
    expect(events.slice(endIdx + 1).filter((e) => e.type === "turn_start")).toHaveLength(0);

    // tool 被调一次,args 配对
    expect(echo.calls).toEqual([{ x: 1 }]);

    // messages 终态四条(2 圈):user / assistant1(含 toolCall id=c1) /
    //   toolResult(toolCallId=c1) / assistant2(纯文本)。AC 的"三条"指配对三元组。
    expect(context.messages).toHaveLength(4);
    expect(context.messages[0]?.role).toBe("user");

    const assistant = context.messages[1] as AssistantMessage;
    expect(assistant.role).toBe("assistant");
    expect(assistant.stopReason).toBe("tool_use");
    const callBlock = assistant.content.find((b): b is ToolCallBlock => b.type === "toolCall");
    expect(callBlock).toBeDefined();
    expect(callBlock?.id).toBe("c1");
    expect(callBlock?.name).toBe("echo");

    const result = context.messages[2] as ToolResultMessage;
    expect(result.role).toBe("toolResult");
    // toolCallId 配对相等(Must not:不匹配)
    expect(result.toolCallId).toBe(callBlock!.id);
    expect(result.toolName).toBe("echo");
    expect(result.isError).toBe(false);

    const assistant2 = context.messages[3] as AssistantMessage;
    expect(assistant2.role).toBe("assistant");
    expect(assistant2.stopReason).toBe("stop");
    expect(assistant2.content).toEqual([{ type: "text", text: "ok" }]);
  });
});

// AC-L2-3: 同批多 toolCall 串行
// Scenario:假 streamFn 一圈吐两个 toolCall(A,B);两假工具各自记录执行时间戳
// Expected:A 的 tool_execution_end 早于 B 的 tool_execution_start;无交错
// Must not:A、B 并发(时间戳重叠)
function makeRecordingTool(
  name: string,
  clock: () => number,
): Tool & { started: number[]; ended: number[] } {
  const started: number[] = [];
  const ended: number[] = [];
  const tool: Tool & { started: number[]; ended: number[] } = {
    name,
    started,
    ended,
    async run() {
      started.push(clock());
      // 让并发可见:若 runLoop 并发,此处 await 期间另一 tool 会 start
      await new Promise((r) => setTimeout(r, 5));
      ended.push(clock());
      return { content: [{ type: "text", text: name }], isError: false };
    },
  };
  return tool;
}

describe("AC-L2-3 同批多 toolCall 串行", () => {
  it("A.end 早于 B.start,时间戳不重叠", async () => {
    let t = 0;
    const clock = () => ++t;
    const toolA = makeRecordingTool("toolA", clock);
    const toolB = makeRecordingTool("toolB", clock);

    // 一圈吐两个 toolCall,done stopReason=tool_use;第 2 圈纯文本停。
    let turn = 0;
    const streamFn: StreamFn = () => {
      turn += 1;
      if (turn === 1) {
        return (async function* () {
          yield { type: "start" };
          yield { type: "toolcall_delta", id: "A", name: "toolA", arguments: null };
          yield { type: "toolcall_delta", id: "B", name: "toolB", arguments: null };
          yield { type: "done", stopReason: "tool_use" };
        })();
      }
      return (async function* () {
        yield { type: "start" };
        yield { type: "text_delta", delta: "done" };
        yield { type: "done", stopReason: "stop" };
      })();
    };
    const context: LoopContext = {
      messages: [{ role: "user", content: "run A and B" }],
      tools: [],
    };

    const events: AgentEvent[] = [];
    for await (const ev of runLoop(streamFn, [toolA, toolB], context, { clock })) {
      events.push(ev);
    }

    // 事件序:A.start < A.end < B.start < B.end
    const aStart = events.findIndex(
      (e) => e.type === "tool_execution_start" && (e as { toolCallId: string }).toolCallId === "A",
    );
    const aEnd = events.findIndex(
      (e) => e.type === "tool_execution_end" && (e as { toolCallId: string }).toolCallId === "A",
    );
    const bStart = events.findIndex(
      (e) => e.type === "tool_execution_start" && (e as { toolCallId: string }).toolCallId === "B",
    );
    const bEnd = events.findIndex(
      (e) => e.type === "tool_execution_end" && (e as { toolCallId: string }).toolCallId === "B",
    );
    expect(aStart).toBeGreaterThanOrEqual(0);
    expect(aStart).toBeLessThan(aEnd);
    expect(aEnd).toBeLessThan(bStart);
    expect(bStart).toBeLessThan(bEnd);

    // 时间戳不重叠:A.end <= B.start(串行)。并发则 B.start < A.end。
    expect(toolA.ended[0]!).toBeLessThanOrEqual(toolB.started[0]!);
  });
});

// AC-L2-4 / AC-L2-5:maxTurns 保险丝
// Scenario:假 streamFn 每圈恒 tool_use;tools 含 echo
// Expected:maxTurns 上限后强制停,turn_start 计数 = maxTurns,agent_end 带 reason="maxTurns"
// Must not:超过 maxTurns 个 turn
const echoTool: Tool = {
  name: "echo",
  async run(args: unknown) {
    return { content: [{ type: "text", text: String(args) }], isError: false };
  },
};

// 每圈恒 tool_use 的流。turn 计数靠闭包自增,toolCall id 带圈号避免重复。
function makeInfiniteToolUseStream(): StreamFn {
  let turn = 0;
  return () => {
    turn += 1;
    return (async function* () {
      yield { type: "start" };
      yield { type: "toolcall_delta", id: `c${turn}`, name: "echo", arguments: turn };
      yield { type: "done", stopReason: "tool_use" };
    })();
  };
}

describe("AC-L2-4 maxTurns=50 保险丝", () => {
  it("第 50 turn 后强制停,turn_start 计数 = 50,agent_end reason=maxTurns", async () => {
    const streamFn = makeInfiniteToolUseStream();
    const context: LoopContext = { messages: [{ role: "user", content: "loop" }] };

    const events: AgentEvent[] = [];
    for await (const ev of runLoop(streamFn, [echoTool], context, { maxTurns: 50 })) {
      events.push(ev);
    }

    const turnStarts = events.filter((e) => e.type === "turn_start");
    expect(turnStarts).toHaveLength(50);
    // Must not:超过 50 turn
    expect(turnStarts.length).toBeLessThanOrEqual(50);

    // 告知事件:agent_end 带 reason="maxTurns"(含 "maxTurns" 字样)
    const end = events.find((e) => e.type === "agent_end") as { reason?: string };
    expect(end).toBeDefined();
    expect(end.reason).toBe("maxTurns");

    // agent_end 后无 turn_start
    const endIdx = events.map((e) => e.type).indexOf("agent_end");
    expect(events.slice(endIdx + 1).filter((e) => e.type === "turn_start")).toHaveLength(0);
  });
});

describe("AC-L2-5 maxTurns 可配", () => {
  it("maxTurns=3 → 第 3 turn 后停,turn_start 计数 = 3", async () => {
    const streamFn = makeInfiniteToolUseStream();
    const context: LoopContext = { messages: [{ role: "user", content: "loop" }] };

    const events: AgentEvent[] = [];
    for await (const ev of runLoop(streamFn, [echoTool], context, { maxTurns: 3 })) {
      events.push(ev);
    }

    const turnStarts = events.filter((e) => e.type === "turn_start");
    expect(turnStarts).toHaveLength(3);
    const end = events.find((e) => e.type === "agent_end") as { reason?: string };
    expect(end.reason).toBe("maxTurns");
  });
});
