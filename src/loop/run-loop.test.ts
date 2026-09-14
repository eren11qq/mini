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

// AC-L3-2: 流中途 error 进流不崩
// Scenario:假 streamFn 吐 text_delta 后中途吐 error 事件(stopReason=error)
// Expected:error 进事件流(agent_end reason=error);runLoop 返回不 throw;context.messages 末位含本轮 partial text
// Must not:loop 源 try/catch;runLoop throw 中断调用者
async function* errorMidStream(): AsyncIterable<ProviderEvent> {
  yield { type: "start" };
  yield { type: "text_delta", delta: "partial " };
  yield { type: "text_delta", delta: "text" };
  yield { type: "error", stopReason: "error", errorMessage: "boom" };
}

describe("AC-L3-2 流中途 error 进流不崩", () => {
  it("error 事件 → agent_end reason=error + partial text 保留 + 不 reject", async () => {
    const streamFn: StreamFn = () => errorMidStream();
    const context: LoopContext = { messages: [] };

    const events: AgentEvent[] = [];
    // 不 reject:await 正常结束
    for await (const ev of runLoop(streamFn, [], context, {})) {
      events.push(ev);
    }

    // error 进流:agent_end 带 reason="error"
    const end = events.find((e) => e.type === "agent_end") as {
      reason?: string;
    };
    expect(end).toBeDefined();
    expect(end.reason).toBe("error");

    // message_end 事件的 assistant 快照 stopReason=error、带 errorMessage
    const msgEnd = events.find((e) => e.type === "message_end") as {
      message: AssistantMessage;
    };
    expect(msgEnd).toBeDefined();
    expect(msgEnd.message.stopReason).toBe("error");
    expect(msgEnd.message.errorMessage).toBe("boom");

    // agent_end 后无 turn_start
    const endIdx = events.map((e) => e.type).indexOf("agent_end");
    expect(events.slice(endIdx + 1).filter((e) => e.type === "turn_start")).toHaveLength(0);

    // context.messages 末位含本轮已收 partial text
    const last = context.messages[context.messages.length - 1] as AssistantMessage | undefined;
    expect(last?.role).toBe("assistant");
    expect(last?.stopReason).toBe("error");
    const textBlock = last?.content.find((b) => b.type === "text");
    expect((textBlock as { text: string } | undefined)?.text).toBe("partial text");
  });
});

// AC-L3-6: stopReason=error|aborted 停
// Scenario:假 streamFn done 事件 stopReason=error(及 =aborted)
// Expected:该 turn 停,不再开新 turn
async function* doneErrorStream(): AsyncIterable<ProviderEvent> {
  yield { type: "start" };
  yield { type: "text_delta", delta: "x" };
  yield { type: "done", stopReason: "error" };
}
async function* doneAbortedStream(): AsyncIterable<ProviderEvent> {
  yield { type: "start" };
  yield { type: "text_delta", delta: "y" };
  yield { type: "done", stopReason: "aborted" };
}

describe("AC-L3-6 stopReason=error|aborted 停", () => {
  it("done stopReason=error → 该 turn 停,无后续 turn_start,agent_end reason=error", async () => {
    const streamFn: StreamFn = () => doneErrorStream();
    const context: LoopContext = { messages: [] };
    const events: AgentEvent[] = [];
    for await (const ev of runLoop(streamFn, [], context, {})) {
      events.push(ev);
    }
    const turnStarts = events.filter((e) => e.type === "turn_start");
    expect(turnStarts).toHaveLength(1);
    const end = events.find((e) => e.type === "agent_end") as {
      reason?: string;
    };
    expect(end.reason).toBe("error");
  });

  it("done stopReason=aborted → 该 turn 停,无后续 turn_start,agent_end reason=aborted", async () => {
    const streamFn: StreamFn = () => doneAbortedStream();
    const context: LoopContext = { messages: [] };
    const events: AgentEvent[] = [];
    for await (const ev of runLoop(streamFn, [], context, {})) {
      events.push(ev);
    }
    const turnStarts = events.filter((e) => e.type === "turn_start");
    expect(turnStarts).toHaveLength(1);
    const end = events.find((e) => e.type === "agent_end") as {
      reason?: string;
    };
    expect(end.reason).toBe("aborted");
  });
});

// AC-L3-3: partial 占位随 delta 替换
// Scenario:假 streamFn 吐多条 text_delta,中途未到 message_end
// Expected:messages 末位恒 1 条 partial assistant;text 随 delta 累积
// Must not:每个 delta 新增一条 message
async function* multiDeltaNoEnd(): AsyncIterable<ProviderEvent> {
  yield { type: "start" };
  yield { type: "text_delta", delta: "a" };
  yield { type: "text_delta", delta: "b" };
  yield { type: "text_delta", delta: "c" };
  // 故意不到 message_end:循环靠 for-await 结束自然退出该 turn
  yield { type: "done", stopReason: "stop" };
}

describe("AC-L3-3 partial 占位随 delta 替换", () => {
  it("每收一条 delta messages.length 不增、末位 text 含已收 delta 拼接", async () => {
    const streamFn: StreamFn = () => multiDeltaNoEnd();
    const context: LoopContext = { messages: [] };

    // 收集每条 message_update 时的快照,断言 text 累积
    const updates: AssistantMessage[] = [];
    for await (const ev of runLoop(streamFn, [], context, {})) {
      if (ev.type === "message_update") {
        updates.push((ev as { message: AssistantMessage }).message);
      }
    }

    // message_update 三条(text_delta 次数),text 逐条累积
    expect(updates).toHaveLength(3);
    const texts = updates.map(
      (m) => (m.content.find((b) => b.type === "text") as { text: string } | undefined)?.text,
    );
    expect(texts).toEqual(["a", "ab", "abc"]);

    // messages 末位恒 1 条 partial assistant,含全部拼接
    expect(context.messages).toHaveLength(1);
    const last = context.messages[0] as AssistantMessage;
    expect(last.role).toBe("assistant");
    const textBlock = last.content.find((b) => b.type === "text") as { text: string } | undefined;
    expect(textBlock?.text).toBe("abc");
  });
});

// AC-L3-4: 外部 abort 信号
// Scenario:runLoop 运行中,注入外部 abort 信号
// Action:触发 abort
// Expected:当前 turn 立即停;agent_end 带 reason="aborted";不再有新 turn_start
// Must not:abort 后再开新 turn
async function* abortableStream(signal: AbortSignal): AsyncIterable<ProviderEvent> {
  yield { type: "start" };
  yield { type: "text_delta", delta: "partial" };
  // 持续慢吐 delta 直到 abort;abort 后流自然结束(不发 done)。
  while (!signal.aborted) {
    await new Promise((r) => setTimeout(r, 1));
    yield { type: "text_delta", delta: "." };
  }
}

describe("AC-L3-4 外部 abort 信号", () => {
  it("abort → 当前 turn 停、agent_end reason=aborted、无后续 turn_start", async () => {
    const controller = new AbortController();
    const streamFn: StreamFn = () => abortableStream(controller.signal);
    const context: LoopContext = { messages: [] };

    const events: AgentEvent[] = [];
    for await (const ev of runLoop(streamFn, [], context, {
      signal: controller.signal,
    })) {
      events.push(ev);
      // 见到首条 text_delta(message_update)后触发 abort
      if (ev.type === "message_update") {
        controller.abort();
      }
    }

    const end = events.find((e) => e.type === "agent_end") as {
      reason?: string;
    };
    expect(end).toBeDefined();
    expect(end.reason).toBe("aborted");

    // abort 后无新 turn_start
    const endIdx = events.map((e) => e.type).indexOf("agent_end");
    expect(events.slice(endIdx + 1).filter((e) => e.type === "turn_start")).toHaveLength(0);

    // partial text 仍保留(含 "partial")
    const last = context.messages[context.messages.length - 1] as AssistantMessage | undefined;
    expect(last?.role).toBe("assistant");
    expect(last?.stopReason).toBe("aborted");
  });
});

// AC-SEAM-1(PRD 审计①): done.usage 透传 → AssistantMessage.usage(Story 9,M3 数据源)
async function* usageStream(): AsyncIterable<ProviderEvent> {
  yield { type: "start" };
  yield { type: "text_delta", delta: "hi" };
  yield { type: "done", stopReason: "stop", usage: { prompt_tokens: 10, completion_tokens: 5 } };
}

describe("AC-SEAM-1 usage 透传落 AssistantMessage", () => {
  it("done.usage → message_end 快照与 context.messages 末位均带 usage", async () => {
    const streamFn: StreamFn = () => usageStream();
    const context: LoopContext = { messages: [] };
    const events: AgentEvent[] = [];
    for await (const ev of runLoop(streamFn, [], context, {})) events.push(ev);

    const msgEnd = events.find((e) => e.type === "message_end") as {
      message: AssistantMessage;
    };
    expect(msgEnd.message.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
    const last = context.messages[0] as AssistantMessage;
    expect(last.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
    // turn_end 消息同源
    const turnEnd = events.find((e) => e.type === "turn_end") as {
      message: AssistantMessage;
    };
    expect(turnEnd.message.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
  });

  it("done 无 usage → 字段缺省不抛(部分厂商不回 usage)", async () => {
    const streamFn: StreamFn = () => fakeTextStream();
    const context: LoopContext = { messages: [] };
    for await (const _ of runLoop(streamFn, [], context, {})) void _;
    const last = context.messages[0] as AssistantMessage;
    expect(last.usage).toBeUndefined();
  });
});

// AC-SEAM-5(PRD 审计⑤): thinking_delta 不再被 loop 丢弃 → ThinkingBlock 累积(H1 淡显来源)
async function* thinkingStream(): AsyncIterable<ProviderEvent> {
  yield { type: "start" };
  yield { type: "thinking_delta", delta: "Let" };
  yield { type: "thinking_delta", delta: " me" };
  yield { type: "text_delta", delta: "hi" };
  yield { type: "done", stopReason: "stop" };
}

describe("AC-SEAM-5 thinking_delta 进 partial", () => {
  it("thinking 块累积 + text 块另起,快照协议同 text", async () => {
    const streamFn: StreamFn = () => thinkingStream();
    const context: LoopContext = { messages: [] };
    const updates: AssistantMessage[] = [];
    for await (const ev of runLoop(streamFn, [], context, {})) {
      if (ev.type === "message_update") updates.push((ev as { message: AssistantMessage }).message);
    }
    expect(updates).toHaveLength(3);
    const thinkingTexts = updates.map((m) =>
      m.content.filter((b) => b.type === "thinking").map((b) => (b as { text: string }).text),
    );
    expect(thinkingTexts).toEqual([["Let"], ["Let me"], ["Let me"]]);
    const last = context.messages[0] as AssistantMessage;
    expect(last.content).toEqual([
      { type: "thinking", text: "Let me" },
      { type: "text", text: "hi" },
    ]);
  });
});

// AC-SEAM-6(PRD 审计⑥): options.signal 透传给 Tool.run(Story 16 / T4 杀进程树入口)
describe("AC-SEAM-6 Tool.run 收到 signal", () => {
  it("runLoop 把 options.signal 作为 run 第二参传入", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const spyTool: Tool = {
      name: "echo",
      async run(_args: unknown, signal?: AbortSignal) {
        receivedSignal = signal;
        return { content: [{ type: "text", text: "ok" }], isError: false };
      },
    };
    let turn = 0;
    const streamFn: StreamFn = () => {
      turn += 1;
      if (turn === 1) {
        return (async function* () {
          yield { type: "start" };
          yield { type: "toolcall_delta", id: "s1", name: "echo", arguments: {} };
          yield { type: "done", stopReason: "tool_use" };
        })();
      }
      return (async function* () {
        yield { type: "start" };
        yield { type: "done", stopReason: "stop" };
      })();
    };
    const context: LoopContext = { messages: [{ role: "user", content: "go" }] };
    for await (const _ of runLoop(streamFn, [spyTool], context, { signal: controller.signal }))
      void _;
    expect(receivedSignal).toBe(controller.signal);
  });
});

// AC-SEAM-S16(PRD 审计⑥配套): signal 同时传进 streamFn 第二参(真 adapter 断流用)
describe("AC-SEAM-S16 streamFn 收到 signal", () => {
  it("loop 以 (context, signal) 调 streamFn", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const streamFn: StreamFn = (_context, signal) => {
      received = signal;
      return fakeTextStream();
    };
    const context: LoopContext = { messages: [] };
    for await (const _ of runLoop(streamFn, [], context, { signal: controller.signal })) void _;
    expect(received).toBe(controller.signal);
  });
});

// AC-L3-5: 整批 terminate
// Scenario:某批 toolCall 中一个标 terminate
// Action:调 runLoop
// Expected:该批 tool_execution_end 全完后 agent_end(reason=terminate)
// Must not:terminate 后再开新 turn
const terminateTool: Tool = {
  name: "stopNow",
  async run() {
    return {
      content: [{ type: "text", text: "stopping" }],
      isError: false,
      terminate: true,
    };
  },
};

describe("AC-L3-5 整批 terminate", () => {
  it("某 ToolResult.terminate=true → 该批后 agent_end,无后续 turn_start", async () => {
    // 第 1 圈吐 toolcall(stopNow, stopReason=tool_use);若 terminate 被忽略会进第 2 圈纯文本。
    let turn = 0;
    const streamFn: StreamFn = () => {
      turn += 1;
      if (turn === 1) {
        return (async function* () {
          yield { type: "start" };
          yield {
            type: "toolcall_delta",
            id: "t1",
            name: "stopNow",
            arguments: null,
          };
          yield { type: "done", stopReason: "tool_use" };
        })();
      }
      return (async function* () {
        yield { type: "start" };
        yield { type: "text_delta", delta: "should not happen" };
        yield { type: "done", stopReason: "stop" };
      })();
    };
    const context: LoopContext = {
      messages: [{ role: "user", content: "stop" }],
      tools: [],
    };

    const events: AgentEvent[] = [];
    for await (const ev of runLoop(streamFn, [terminateTool], context, {})) {
      events.push(ev);
    }

    // 只 1 个 turn_start(terminate 后不开第 2 turn)
    const turnStarts = events.filter((e) => e.type === "turn_start");
    expect(turnStarts).toHaveLength(1);

    // tool_execution_end 存在(批跑完了)
    const toolEnd = events.find((e) => e.type === "tool_execution_end");
    expect(toolEnd).toBeDefined();

    // agent_end 带 reason="terminate",其后无 turn_start
    const end = events.find((e) => e.type === "agent_end") as {
      reason?: string;
    };
    expect(end).toBeDefined();
    expect(end.reason).toBe("terminate");
    const endIdx = events.map((e) => e.type).indexOf("agent_end");
    expect(events.slice(endIdx + 1).filter((e) => e.type === "turn_start")).toHaveLength(0);
  });
});
