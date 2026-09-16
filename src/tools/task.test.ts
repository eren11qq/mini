// D4(docs/ISSUES.md)task 子代理:runLoop-as-a-Tool(只读首版)。
// 缝 = makeTaskTool / confirmDeny 公共面 + runLoop 入口双层套娃(假流先例 registry.test)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop } from "../loop/run-loop.ts";
import type { AgentEvent, ConfirmAnswer, LoopContext } from "../loop/types.ts";
import type { ProviderEvent, StreamFn } from "../stream/protocol.ts";
import { readTool } from "./read.ts";
import { bashTool } from "./bash.ts";
import { confirmDeny, makeTaskTool } from "./task.ts";
import type { Tool } from "./tool.ts";

// 假流:第一圈捕获 child 收到的 LoopContext(工具面 = 白名单断言的观测点),吐纯文本停。
function captureStopStream(seen: { ctx?: LoopContext }): StreamFn {
  let turn = 0;
  return (context) => {
    if (++turn === 1) seen.ctx = context;
    return (async function* (): AsyncIterable<ProviderEvent> {
      yield { type: "start" };
      yield { type: "text_delta", delta: "answer" };
      yield { type: "done", stopReason: "stop" };
    })();
  };
}

describe("D4 confirmDeny 纯叶(堵 run-loop「缺 confirm = 放行」洞的 child 侧)", () => {
  it('任意 prompt → {no, "sub-agent headless"}(reason 进 toolResult 回喂面)', () => {
    expect(confirmDeny('Execute: bash({"command":"ls"})?')).toEqual({
      kind: "no",
      reason: "sub-agent headless",
    });
    expect(confirmDeny("")).toEqual({ kind: "no", reason: "sub-agent headless" });
  });
});

// AC-1:makeTaskTool 面(schema/description/无 skipConfirm)+ child 工具集白名单表断。
// skipConfirm 不声明 = task 本体在父侧照过确认门(钱包保险,卡「首版只读集是刻意的钱包保险」)。
describe("D4 makeTaskTool 公共面", () => {
  it("name=task、description 非空、schema 只收 {prompt:string}、无 skipConfirm", () => {
    const tool = makeTaskTool({ streamFn: captureStopStream({}) });
    expect(tool.name).toBe("task");
    expect(tool.description).toBeTruthy();
    expect(tool.skipConfirm).toBeFalsy();
    expect(tool.schema).toEqual({
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
      additionalProperties: false,
    });
  });

  it("缺省 child 工具面 = [read]:无 task 无 bash 无 write/edit(child streamFn 缝捕获 ctx.tools)", async () => {
    const seen: { ctx?: LoopContext } = {};
    const tool = makeTaskTool({ streamFn: captureStopStream(seen) });
    await tool.run({ prompt: "查一下" });
    expect(seen.ctx?.tools?.map((t) => t.name)).toEqual(["read"]);
  });

  it("深度守卫:deps.tools 注入含 task/bash → child 工具面仍无 task(子不繁殖);其余注入原样(测试后门)", async () => {
    const seen: { ctx?: LoopContext } = {};
    const fakeBash: Tool = { ...bashTool, run: async () => ({ content: [], isError: false }) };
    const parentish: Tool = { name: "task", run: async () => ({ content: [], isError: false }) };
    const tool = makeTaskTool({
      streamFn: captureStopStream(seen),
      tools: [readTool, fakeBash, parentish],
    });
    await tool.run({ prompt: "x" });
    expect(seen.ctx?.tools?.map((t) => t.name)).toEqual(["read", "bash"]);
  });
});

// AC-3 S1 双层套娃:父假流吐 toolCall task → child 独立假流(read → 作答)。
// 断 = 父 messages 终态配对、child 末条 assistant text 成 toolResult、child 事件全带
// agentId(onEvent 上报缝)、child usage 合计进 relay 的 agent_end 行;父侧事件零 agentId
// = 主代理 diff-0(trace 行形状锚的同源行为面)。
async function collect(gen: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}
function scriptedStream(turns: AsyncIterable<ProviderEvent>[]): StreamFn {
  let n = 0;
  return () => turns[Math.min(n++, turns.length - 1)]!;
}
function toolCallTurn(id: string, name: string, args: unknown): AsyncIterable<ProviderEvent> {
  return (async function* () {
    yield { type: "start" };
    yield { type: "toolcall_delta", id, name, arguments: args };
    yield {
      type: "done",
      stopReason: "tool_use",
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    };
  })();
}
function textTurn(
  text: string,
  usage?: { prompt_tokens: number; completion_tokens: number },
): AsyncIterable<ProviderEvent> {
  return (async function* () {
    yield { type: "start" };
    yield { type: "text_delta", delta: text };
    yield { type: "done", stopReason: "stop", ...(usage && { usage }) };
  })();
}

describe("D4 S1 双层套娃:父 toolCall task → child runLoop(read → 作答)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mini-task-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("child 真 read 临时文件 → 末 text 进父 toolResult;配对完整;child 事件带 agentId;usage 汇总", async () => {
    const path = join(dir, "fact.txt");
    await writeFile(path, "hello world\n");
    const child: StreamFn = scriptedStream([
      toolCallTurn("k1", "read", { path }),
      textTurn("answer: hello world", { prompt_tokens: 5, completion_tokens: 3 }),
    ]);
    const relayed: AgentEvent[] = [];
    const taskTool = makeTaskTool({
      streamFn: child,
      onEvent: (ev) => relayed.push(ev),
    });

    const parentConfirm: string[] = [];
    const context: LoopContext = { messages: [{ role: "user", content: "delegate" }] };
    const events = await collect(
      runLoop(
        scriptedStream([
          toolCallTurn("c1", "task", { prompt: "读 fact.txt 并总结" }),
          textTurn("parent done"),
        ]),
        [readTool, taskTool],
        context,
        { confirm: (): ConfirmAnswer => (parentConfirm.push("p"), { kind: "yes" }) },
      ),
    );

    // 父 toolResult = child 末条 assistant text(逐字)
    const toolMsg = context.messages.find((m) => m.role === "toolResult");
    expect(toolMsg?.role === "toolResult" && [toolMsg.toolCallId, toolMsg.isError]).toEqual([
      "c1",
      false,
    ]);
    expect(toolMsg?.role === "toolResult" && toolMsg.content.map((b) => b.text).join("")).toBe(
      "answer: hello world",
    );
    // 配对完整:父每个 toolCall id ⇔ toolResult id(悬空 = 400 靶心,D1 前提)
    const asst = context.messages.find((m) => m.role === "assistant");
    const callIds =
      asst?.role === "assistant"
        ? asst.content.filter((b) => b.type === "toolCall").map((b) => b.id)
        : [];
    expect(callIds).toEqual(
      context.messages
        .filter((m) => m.role === "toolResult")
        .map((m) => m.role === "toolResult" && m.toolCallId),
    );
    // 父 agent_end 正常收尾(无 error/aborted reason)= child 全程没污染父停止条件
    const last = events[events.length - 1]!;
    expect(last.type === "agent_end" && last.reason === undefined).toBe(true);

    // child 事件全带 agentId(task-N,同一次 run 同值);含 read 执行对 + agent_end 载 usage 合计
    expect(relayed.length).toBeGreaterThan(0);
    const ids = new Set(relayed.map((e) => (e as { agentId?: string }).agentId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^task-\d+$/);
    expect(relayed.some((e) => e.type === "tool_execution_start" && e.toolName === "read")).toBe(
      true,
    );
    const childEnd = relayed.find((e) => e.type === "agent_end");
    expect(childEnd?.type === "agent_end" && childEnd.usage).toEqual({
      prompt_tokens: 15,
      completion_tokens: 5,
    });

    // diff-0 行为锚:父事件流(= 主代理 trace 源)零 agentId 键
    expect(events.some((e) => "agentId" in e)).toBe(false);
    // 父 confirm 恰 1 弹 = task 本体过门(child read 走 skipConfirm 不弹)
    expect(parentConfirm).toHaveLength(1);
  });

  it("child 内 error 假行 → 父收 isError toolResult(含 errorMessage 原文)、父循环照常续到自然停", async () => {
    const errTurn: AsyncIterable<ProviderEvent> = (async function* () {
      yield { type: "start" };
      yield { type: "error", stopReason: "error", errorMessage: "boom 429" };
    })();
    const child: StreamFn = () => errTurn;
    const taskTool = makeTaskTool({ streamFn: child });
    const context: LoopContext = { messages: [{ role: "user", content: "go" }] };
    const events = await collect(
      runLoop(
        scriptedStream([toolCallTurn("c1", "task", { prompt: "x" }), textTurn("recovered")]),
        [taskTool],
        context,
        {},
      ),
    );
    const toolMsg = context.messages.find((m) => m.role === "toolResult");
    expect(toolMsg?.role === "toolResult" && toolMsg.isError).toBe(true);
    expect(toolMsg?.role === "toolResult" && toolMsg.content.map((b) => b.text).join("")).toContain(
      "boom 429",
    );
    const last = events[events.length - 1]!;
    expect(last.type === "agent_end" && last.reason === undefined).toBe(true); // 父不断
    expect(events.filter((e) => e.type === "turn_start")).toHaveLength(2);
  });
});

// AC-4 deny 洞负例:child 工具集经测试注入换假 bash → 人侧零弹窗(child confirm =
// confirmDeny 恒拒)、拒因逐字走 loop 既有 `user rejected: <tool> — <reason>` 格式回喂
// child 模型、父循环照常续。run-loop「缺 confirm = 放行」的洞不随 child 扩权限变越权面。
describe("D4 deny 洞负例:child 含假 bash → headless 拒、不越权不断链", () => {
  it("假 bash 零执行、child 收逐字拒因、父 toolResult 带出拒因、人侧 confirm 仅 task 本体 1 弹", async () => {
    const bashCalls = { n: 0 };
    const fakeBash: Tool = {
      name: "bash",
      matchOf: (a) => (a as { command?: string }).command ?? "",
      matchKind: "shell",
      async run() {
        bashCalls.n += 1;
        return { content: [{ type: "text", text: "boom" }], isError: false };
      },
    };
    // child 第 2 圈捕获自己 messages(拒因行的观测点 = child 侧公共数据,非私有结构)
    let childMsgs: LoopContext["messages"] | undefined;
    let childTurn = 0;
    const bashTurn = toolCallTurn("k1", "bash", { command: "rm -rf /" });
    const child: StreamFn = (context) => {
      if (++childTurn === 1) return bashTurn;
      childMsgs = context.messages;
      return textTurn("final: told to stop");
    };

    const taskTool = makeTaskTool({ streamFn: child, tools: [readTool, fakeBash] });
    const humanPrompts: string[] = [];
    const context: LoopContext = { messages: [{ role: "user", content: "go" }] };
    const events = await collect(
      runLoop(
        scriptedStream([toolCallTurn("c1", "task", { prompt: "x" }), textTurn("parent done")]),
        [taskTool],
        context,
        {
          confirm: (p): ConfirmAnswer => (humanPrompts.push(p), { kind: "yes" }),
        },
      ),
    );

    expect(bashCalls.n).toBe(0); // 拒 = 未执行(不越权)
    expect(humanPrompts).toHaveLength(1); // 人侧只弹过 task 本体,child 假 bash 零弹窗
    // child 侧拒因逐字(loop 既有格式锚:`user rejected: ${tool.name} — ${answer.reason}`)
    const childReject = childMsgs?.find((m) => m.role === "toolResult");
    expect(childReject?.role === "toolResult" && childReject.isError).toBe(true);
    expect(
      childReject?.role === "toolResult" && childReject.content.map((b) => b.text).join(""),
    ).toBe("user rejected: bash — sub-agent headless");
    // 循环不断:child 模型吃到拒因 → 末答照常成父 toolResult
    const toolMsg = context.messages.find((m) => m.role === "toolResult");
    expect(toolMsg?.role === "toolResult" && toolMsg.isError).toBe(false); // child 正常收尾(拒是数据不是故障)
    expect(toolMsg?.role === "toolResult" && toolMsg.content.map((b) => b.text).join("")).toBe(
      "final: told to stop",
    );
    const last = events[events.length - 1]!;
    expect(last.type === "agent_end" && last.reason === undefined).toBe(true);
  });
});

// AC-6 abort 透传(故事 21):父 signal 在 task 在飞时命中 → child 在飞工具吃 signal 被杀、
// child relay 的 agent_end reason=aborted(带 agentId)、父侧该批补位配对完整、父终也 aborted。
describe("D4 abort 透传:父 Ctrl+C 一并杀 child", () => {
  it("child 在飞工具被 signal 杀 + 双层 agent_end reason=aborted + 父 toolResult 补位 isError 配对", async () => {
    const controller = new AbortController();
    const tl: string[] = [];
    const diesOnAbort: Tool = {
      name: "read",
      skipConfirm: true, // 同真 read(只读豁免),否则 child 确认门先拦 = 测不到在飞段
      async run(_a, signal) {
        tl.push("child-run-start");
        await new Promise<never>((_res, rej) => {
          const dead = () => {
            tl.push("child-killed-by-signal");
            rej(new Error("aborted"));
          };
          if (signal?.aborted) dead();
          else signal?.addEventListener("abort", dead);
        });
        throw new Error("unreachable");
      },
    };
    const startOnly: AsyncIterable<ProviderEvent> = (async function* () {
      yield { type: "start" }; // 被 loop 顶格 abort 检查截断(假流 = 真 adapter 收 signal 的替身)
    })();
    let childTurn = 0;
    const bashTurn = toolCallTurn("k1", "read", { path: "x" });
    const child: StreamFn = () => (++childTurn === 1 ? bashTurn : startOnly);
    const relayed: AgentEvent[] = [];
    const taskTool = makeTaskTool({
      streamFn: child,
      tools: [diesOnAbort],
      onEvent: (ev) => {
        relayed.push(ev);
        // abort 正落在 child 工具批开跑时 = 「在飞」窗口(relay start 紧随 run 启动)。
        if (ev.type === "tool_execution_start") controller.abort();
      },
    });

    const context: LoopContext = { messages: [{ role: "user", content: "go" }] };
    const events = await collect(
      runLoop(
        scriptedStream([toolCallTurn("c1", "task", { prompt: "x" }), textTurn("never")]),
        [taskTool],
        context,
        { signal: controller.signal },
      ),
    );

    expect(tl).toEqual(["child-run-start", "child-killed-by-signal"]); // 在飞被杀(signal 到 tool.run)
    // child 双层收尾:relay agent_end reason=aborted 且带 agentId
    const childEnd = relayed.find((e) => e.type === "agent_end");
    expect(childEnd?.type === "agent_end" && childEnd.reason).toBe("aborted");
    expect((childEnd as { agentId?: string }).agentId).toMatch(/^task-\d+$/);
    // 父批补位配对完整:toolCall c1 ⇔ toolResult c1(悬空 = 400 靶心)
    const toolMsg = context.messages.find((m) => m.role === "toolResult");
    expect(toolMsg?.role === "toolResult" && [toolMsg.toolCallId, toolMsg.isError]).toEqual([
      "c1",
      true,
    ]);
    expect(toolMsg?.role === "toolResult" && toolMsg.content.map((b) => b.text).join("")).toContain(
      "task aborted",
    );
    // 父层最终 = aborted(既有 AC-L3-4 路径,零新机制)
    const last = events[events.length - 1]!;
    expect(last.type === "agent_end" && last.reason).toBe("aborted");
  });
});
