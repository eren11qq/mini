import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { traceLine } from "./trace.ts";
import { runLoop } from "../loop/run-loop.ts";
import type {
  AgentEvent,
  AssistantMessage,
  LoopContext,
  ToolResultMessage,
  UserMessage,
} from "../loop/types.ts";
import type { ProviderEvent, StreamFn } from "../stream/protocol.ts";
import { eventToEntries } from "../memory/journal.ts";
import { SessionManager } from "../memory/session-manager.ts";
import { readTool } from "../tools/read.ts";

// D2(docs/ISSUES.md)纯叶锚测:AgentEvent → trace JSONL 单行 reducer(故事 7/9/10)。
// 行形状 = {ts, agentId?, ...event}:事件名与字段原样保留,日后转 OTLP 不改格式(故事 10)。
// ts = 注入 clock(零内部计时);键序稳定 = 逐字节可断。fs 不在叶内 —— append 住 cli 订阅环。

const msg: AssistantMessage = {
  role: "assistant",
  content: [
    { type: "text", text: "hi" },
    { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" } },
  ],
  stopReason: "tool_use",
  usage: { prompt_tokens: 10, completion_tokens: 2 },
};
const res: ToolResultMessage = {
  role: "toolResult",
  toolCallId: "c1",
  toolName: "read",
  content: [{ type: "text", text: "ok" }],
  isError: false,
};
const resErr: ToolResultMessage = { ...res, toolCallId: "c2", isError: true };

const EVENTS: AgentEvent[] = [
  { type: "agent_start" },
  { type: "agent_end", messages: [msg], reason: "complete" },
  { type: "turn_start" },
  { type: "turn_end", message: msg, toolResults: [res, resErr] },
  { type: "message_start", message: msg },
  { type: "message_update", message: msg },
  { type: "message_end", message: msg },
  { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a.txt" } },
  {
    type: "tool_execution_update",
    toolCallId: "c1",
    toolName: "read",
    args: { path: "a.txt" },
    partialResult: { content: [], isError: false },
  },
  {
    type: "tool_execution_end",
    toolCallId: "c1",
    toolName: "read",
    result: { content: [{ type: "text", text: "ok" }], isError: false },
    isError: false,
  },
];

const T = 1700000000123;

describe("D2 traceLine — 10 类事件全覆盖", () => {
  it("事件种表 = AgentEvent 判别面全 10 类", () => {
    expect(EVENTS.map((e) => e.type)).toEqual([
      "agent_start",
      "agent_end",
      "turn_start",
      "turn_end",
      "message_start",
      "message_update",
      "message_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
    ]);
  });

  it("每类一行:parse 回来 = {ts, ...event} 语义逐字段无损(故事 10 字段原样)", () => {
    for (const ev of EVENTS) {
      const line = traceLine(ev, () => T);
      expect(JSON.parse(line)).toEqual({ ts: T, ...ev });
    }
  });

  it("单行铁律:行内零换行(一事件 = 恰一行)", () => {
    for (const ev of EVENTS) {
      expect(traceLine(ev, () => T)).not.toContain("\n");
    }
  });
});

describe("D2 traceLine — ts 与 clock 注入", () => {
  it("ts = clock 返回值;一次 traceLine 恰调 clock 一次", () => {
    let calls = 0;
    const line = traceLine({ type: "agent_start" }, () => ++calls);
    expect(calls).toBe(1);
    expect((JSON.parse(line) as { ts: number }).ts).toBe(1);
  });

  it("ts 固定为首键(键序 = ts, type, ...)", () => {
    const line = traceLine({ type: "turn_start" }, () => T);
    expect(Object.keys(JSON.parse(line) as Record<string, unknown>)).toEqual(["ts", "type"]);
  });
});

describe("D2 traceLine — 键序稳定逐字节可断(先例注:缺 agentId 行零该键 = D4 diff-0 锚位)", () => {
  it("agent_start 行逐字节", () => {
    expect(traceLine({ type: "agent_start" }, () => T)).toBe(`{"ts":${T},"type":"agent_start"}`);
  });

  it("tool_execution_end 行逐字节(键序 = 事件字面序)", () => {
    expect(
      traceLine(
        {
          type: "tool_execution_end",
          toolCallId: "c1",
          toolName: "bash",
          result: { content: [{ type: "text", text: "hi" }], isError: false },
          isError: false,
        },
        () => T,
      ),
    ).toBe(
      `{"ts":${T},"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","result":{"content":[{"type":"text","text":"hi"}],"isError":false},"isError":false}`,
    );
  });

  it("turn_end 行逐字节:messages/toolResults 序列化完整(usage/stopReason/双侧信道不丢)", () => {
    expect(traceLine({ type: "turn_end", message: msg, toolResults: [res, resErr] }, () => T)).toBe(
      `{"ts":${T},"type":"turn_end","message":${JSON.stringify(msg)},"toolResults":[${JSON.stringify(res)},${JSON.stringify(resErr)}]}`,
    );
  });

  it("agent_end reason 缺省 → 零该键(可选键不膨胀)", () => {
    expect(traceLine({ type: "agent_end", messages: [] }, () => T)).toBe(
      `{"ts":${T},"type":"agent_end","messages":[]}`,
    );
  });

  it("事件自带 agentId → 随行落盘且紧跟 ts(D4 契约面预钉,零特判)", () => {
    const ev = { type: "agent_start", agentId: "sub-1" } as AgentEvent;
    expect(traceLine(ev, () => T)).toBe(`{"ts":${T},"agentId":"sub-1","type":"agent_start"}`);
  });
});

// —— D2 AC3:双写离线端到端(假流 S1 + 临时目录 S3 = 隔离 HOME,零网络)。
// cli.ts 顶层 await main() = 不可 import → 此处逐字复刻其订阅环接线(render 为纯展示省略);
// 真进程剧本走 /tmp e2e 判卷(D1 先例)。两文件互不吞行 = 各断「每行可 parse 且 type ∈ 各自集合」。
describe("D2 双写端到端:trace.jsonl 与会话 jsonl", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mini-trace-e2e-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function* turn1(path: string): AsyncGenerator<ProviderEvent> {
    yield { type: "start" };
    yield { type: "toolcall_delta", id: "c1", name: "read", arguments: { path } };
    yield { type: "done", stopReason: "tool_use" };
  }
  async function* turn2(): AsyncGenerator<ProviderEvent> {
    yield { type: "start" };
    yield { type: "text_delta", delta: "read done" };
    yield { type: "done", stopReason: "stop" };
  }

  // trace 开关 = cli 的 args.trace 位;先 trace 后 journal = 记录面最早落(渲染/journal 抛错不吞 trace)。
  async function scriptedRun(cwdTag: string, trace: boolean): Promise<AgentEvent[]> {
    const cwd = join(dir, cwdTag);
    mkdirSync(cwd, { recursive: true });
    const target = join(cwd, "a.txt");
    writeFileSync(target, "hello trace");
    const sm = new SessionManager({ baseDir: dir, cwd });
    const userMsg: UserMessage = { role: "user", content: "read a.txt" };
    const context: LoopContext = { messages: [userMsg] };
    sm.append({ type: "message", payload: userMsg });

    let n = 0;
    const streamFn: StreamFn = () => (++n === 1 ? turn1(target) : turn2());
    const events: AgentEvent[] = [];
    for await (const ev of runLoop(streamFn, [readTool], context, {})) {
      events.push(ev);
      if (trace) appendFileSync(sm.traceFile()!, traceLine(ev, Date.now) + "\n");
      for (const entry of eventToEntries(ev)) sm.append(entry);
    }
    return events;
  }

  const linesOf = (f: string): string[] => readFileSync(f, "utf8").trimEnd().split("\n");

  it("含工具对话一场:trace 行数 = 事件数、逐行 type 对序;会话文件双写互不吞行", async () => {
    const events = await scriptedRun("on", true);
    const sm = SessionManager.open({ baseDir: dir, cwd: join(dir, "on") });
    const tracePath = sm.traceFile()!;
    // 会话文件 = 旁挂兄弟位(字节关系已在 session-manager.test D2 组锚死,此处直接用)
    const sessionFile = tracePath.replace(/\.trace\.jsonl$/, ".jsonl");

    // 事件面覆盖两类以上关键种(证剧本真跑了工具批,非空转)
    expect(events.map((e) => e.type)).toContain("tool_execution_end");
    expect(events.length).toBeGreaterThan(5);

    const tLines = linesOf(tracePath);
    expect(tLines).toHaveLength(events.length);
    tLines.forEach((l, i) => {
      const obj = JSON.parse(l) as { ts: number; type: string };
      expect(obj.type).toBe(events[i]!.type);
      expect(typeof obj.ts).toBe("number");
    });

    // 会话文件每行 = header/entry,零事件名混入;D1 配对语义完好(trace 接线没踩坏它)
    const sLines = linesOf(sessionFile);
    const entryTypes = new Set([
      "session",
      "message",
      "model_change",
      "compaction",
      "session_info",
    ]);
    for (const l of sLines)
      expect(entryTypes.has((JSON.parse(l) as { type: string }).type)).toBe(true);
    const roles = sm.rebuild().messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });

  it("--no-trace 剧本:零 trace 文件,会话照常完整落盘", async () => {
    const events = await scriptedRun("off", false);
    expect(events.length).toBeGreaterThan(5);
    const sub = join(dir, "off");
    const sm = SessionManager.open({ baseDir: dir, cwd: sub });
    // 真落盘目录 = encodeCwd 子目录(非 cwd 本身),从 getter 路径回溯定位
    expect(
      readdirSync(join(sm.traceFile()!, "..")).filter((f) => f.endsWith(".trace.jsonl")),
    ).toEqual([]);
    sm.append({ type: "message", payload: { role: "user", content: "x" } });
    expect(existsSync(sm.traceFile()!)).toBe(false); // 旁挂路径照推 —— 只是从没人写过它
    const roles = SessionManager.open({ baseDir: dir, cwd: sub })
      .rebuild()
      .messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "toolResult", "assistant", "user"]);
  });
});
