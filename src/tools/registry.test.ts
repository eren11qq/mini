import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop } from "../loop/run-loop.ts";
import type {
  AgentEvent,
  LoopContext,
  ProviderEvent,
  StreamFn,
  ToolResultMessage,
} from "../loop/types.ts";
import { readTool } from "./read.ts";
import { editTool } from "./edit.ts";
import { writeTool } from "./write.ts";
import { stat } from "node:fs/promises";
import type { Tool } from "../loop/types.ts";

// T1 seam 2:注册表分发 = runLoop(streamFn, [readTool], ctx, opts) 公共入口。
// AC-T1-2/3 的 read 经 toolCall 走通整链;AC-T1-4(T1 可测部分):无任何确认 gate,
// 直接执行并回填(beforeToolCall hook 归 T2,届时 read 须恒放行)。

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mini-registry-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function collect(gen: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

// T2 共用:第 1 圈吐一个 toolCall,第 2 圈纯文本停。
function toolCallTurn(id: string, name: string, args: unknown): AsyncIterable<ProviderEvent> {
  return (async function* () {
    yield { type: "start" };
    yield { type: "toolcall_delta", id, name, arguments: args };
    yield { type: "done", stopReason: "tool_use" };
  })();
}
function twoTurnStream(turn1: AsyncIterable<ProviderEvent>, text = "recovered"): StreamFn {
  let n = 0;
  return () => {
    if (++n === 1) return turn1;
    return (async function* () {
      yield { type: "start" };
      yield { type: "text_delta", delta: text };
      yield { type: "done", stopReason: "stop" };
    })();
  };
}
function confirmSpy(answer: "yes" | "always" | "no") {
  const prompts: string[] = [];
  const confirm = (prompt: string) => {
    prompts.push(prompt);
    return answer;
  };
  return { prompts, confirm };
}

describe("T1 注册表分发:toolCall→read→toolResult 整链", () => {
  it("假流吐 toolCall read{offset:10,limit:5} → 回填恰第 10–14 行、id/name 配对、直接执行", async () => {
    const path = join(dir, "f100.txt");
    await writeFile(path, Array.from({ length: 100 }, (_, i) => `L${i + 1}`).join("\n"));

    // 第 1 圈吐 toolCall(交 loop 分发),第 2 圈纯文本(停)。
    const turn1: AsyncIterable<ProviderEvent> = (async function* () {
      yield { type: "start" };
      yield {
        type: "toolcall_delta",
        id: "c1",
        name: "read",
        arguments: { path, offset: 10, limit: 5 },
      };
      yield { type: "done", stopReason: "tool_use" };
    })();
    const turn2: AsyncIterable<ProviderEvent> = (async function* () {
      yield { type: "start" };
      yield { type: "text_delta", delta: "done" };
      yield { type: "done", stopReason: "stop" };
    })();
    let turn = 0;
    const streamFn: StreamFn = () => (++turn === 1 ? turn1 : turn2);

    const context: LoopContext = { messages: [{ role: "user", content: "read f100" }] };
    const events = await collect(runLoop(streamFn, [readTool], context, {}));

    // 分发事件对:start→end,end 载成功 result(= read 直接执行,无确认挂起)
    const start = events.find((e) => e.type === "tool_execution_start");
    const end = events.find((e) => e.type === "tool_execution_end");
    expect(start?.type).toBe("tool_execution_start");
    expect(end?.type).toBe("tool_execution_end");
    if (start?.type !== "tool_execution_start" || end?.type !== "tool_execution_end") return;
    expect([start.toolCallId, start.toolName]).toEqual(["c1", "read"]);
    expect([end.toolCallId, end.isError]).toEqual(["c1", false]);

    // 回填 messages:role=toolResult,toolCallId/toolName 配对,content 恰 10–14 行带行号
    const toolMsg = context.messages.find((m): m is ToolResultMessage => m.role === "toolResult");
    expect(toolMsg).toBeDefined();
    expect([toolMsg?.toolCallId, toolMsg?.toolName, toolMsg?.isError]).toEqual([
      "c1",
      "read",
      false,
    ]);
    expect(toolMsg?.content.map((b) => b.text).join("")).toBe(
      ["10\tL10", "11\tL11", "12\tL12", "13\tL13", "14\tL14"].join("\n"),
    );
  });
});

describe("T2 AC-T2-4: args schema 校验失败 → error result 回喂、不中断", () => {
  it("edit 缺 edits 字段 → invalid arguments error 回填、第 2 turn 照常起、run 未执行", async () => {
    const target = join(dir, "never-created.txt"); // 校验失败应挡在 run 前,连 read 都不到

    const turn1: AsyncIterable<ProviderEvent> = (async function* () {
      yield { type: "start" };
      yield { type: "toolcall_delta", id: "c1", name: "edit", arguments: { path: target } };
      yield { type: "done", stopReason: "tool_use" };
    })();
    const turn2: AsyncIterable<ProviderEvent> = (async function* () {
      yield { type: "start" };
      yield { type: "text_delta", delta: "recovered" };
      yield { type: "done", stopReason: "stop" };
    })();
    let turn = 0;
    const streamFn: StreamFn = () => (++turn === 1 ? turn1 : turn2);

    const context: LoopContext = { messages: [{ role: "user", content: "edit it" }] };
    const events = await collect(runLoop(streamFn, [editTool], context, {}));

    const toolMsg = context.messages.find((m): m is ToolResultMessage => m.role === "toolResult");
    expect(toolMsg).toBeDefined();
    expect([toolMsg?.toolCallId, toolMsg?.isError]).toEqual(["c1", true]);
    expect(toolMsg?.content.map((b) => b.text).join("")).toMatch(/invalid arguments/i);

    // 不中断:第 2 turn 照常起,agent_end 收尾
    expect(events.filter((e) => e.type === "turn_start")).toHaveLength(2);
    expect(events.some((e) => e.type === "agent_end")).toBe(true);
    // run 未执行:目标文件从未被创建
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("T2 AC-T2-5: beforeToolCall confirm yes/no + read 豁免", () => {
  it("yes → 过检后照常执行落盘", async () => {
    const path = join(dir, "c5yes.txt");
    await writeFile(path, "aaa\n");
    const { prompts, confirm } = confirmSpy("yes");

    const context: LoopContext = { messages: [{ role: "user", content: "go" }] };
    await collect(
      runLoop(
        twoTurnStream(
          toolCallTurn("c1", "edit", { path, edits: [{ oldText: "aaa", newText: "AAA" }] }),
        ),
        [editTool],
        context,
        { confirm },
      ),
    );

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/Execute/);
    expect(await readFile(path, "utf8")).toBe("AAA\n");
  });

  it("no → run 不执行、result 标 user rejected、事件对仍配对", async () => {
    const path = join(dir, "c5no.txt");
    await writeFile(path, "aaa\n");
    const { prompts, confirm } = confirmSpy("no");

    const context: LoopContext = { messages: [{ role: "user", content: "go" }] };
    const events = await collect(
      runLoop(
        twoTurnStream(
          toolCallTurn("c1", "edit", { path, edits: [{ oldText: "aaa", newText: "AAA" }] }),
        ),
        [editTool],
        context,
        { confirm },
      ),
    );

    expect(prompts).toHaveLength(1);
    expect(await readFile(path, "utf8")).toBe("aaa\n"); // 未执行
    const end = events.filter((e) => e.type === "tool_execution_end")[0];
    expect(end?.type === "tool_execution_end" && end.isError).toBe(true); // start/end 配对不破
    const toolMsg = context.messages.find((m): m is ToolResultMessage => m.role === "toolResult");
    expect(toolMsg?.content.map((b) => b.text).join("")).toMatch(/user rejected/i);
  });

  it("read 恒放行:confirm 零调用", async () => {
    const path = join(dir, "c5read.txt");
    await writeFile(path, "hello\n");
    const { prompts, confirm } = confirmSpy("no"); // 就算 no 也不该轮到 read

    const context: LoopContext = { messages: [{ role: "user", content: "read it" }] };
    await collect(
      runLoop(twoTurnStream(toolCallTurn("c1", "read", { path })), [readTool], context, {
        confirm,
      }),
    );

    expect(prompts).toHaveLength(0);
    const toolMsg = context.messages.find((m): m is ToolResultMessage => m.role === "toolResult");
    expect(toolMsg?.isError).toBe(false);
  });
});

describe("T3 AC-T3-4: write 过确认(no → 不写文件、result skipped)", () => {
  it("confirm 假应答 no → run 未执行、文件不存在、result 标 user rejected(= skipped 词汇)", async () => {
    const path = join(dir, "t34-never.txt");
    const { prompts, confirm } = confirmSpy("no");

    const context: LoopContext = { messages: [{ role: "user", content: "write it" }] };
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("c1", "write", { path, content: "SECRET" })),
        [writeTool],
        context,
        { confirm },
      ),
    );

    expect(prompts).toHaveLength(1); // write 未声明 skipConfirm → 必过安检
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" }); // 文件不存在
    const toolMsg = context.messages.find((m): m is ToolResultMessage => m.role === "toolResult");
    expect(toolMsg?.isError).toBe(true);
    expect(toolMsg?.content.map((b) => b.text).join("")).toMatch(/user rejected/i);
  });
});

describe("T2 AC-T2-6: 新工具自动过安检(逻辑在 loop hook 不在工具)", () => {
  it("rmrf 只声明 name+run → confirm 仍被调;no → run 零调用", async () => {
    // rmrf 工具源 = 下面这个字面量:零确认代码、零 skipConfirm 声明 → 安检必来自 loop。
    let runCalls = 0;
    const rmrf: Tool = {
      name: "rmrf",
      async run() {
        runCalls += 1;
        return { content: [{ type: "text", text: "boom" }], isError: false };
      },
    };
    const { prompts, confirm } = confirmSpy("no");

    const context: LoopContext = { messages: [{ role: "user", content: "go" }] };
    await collect(
      runLoop(twoTurnStream(toolCallTurn("c1", "rmrf", { target: "/" })), [rmrf], context, {
        confirm,
      }),
    );

    expect(prompts).toHaveLength(1); // 新工具自动过安检
    expect(runCalls).toBe(0); // no → 未执行
    const toolMsg = context.messages.find((m): m is ToolResultMessage => m.role === "toolResult");
    expect([toolMsg?.isError, runCalls]).toEqual([true, 0]);
  });
});

// 假 bash(T4 前占位,走同一条 loop 缝)。prefixOf = 工具声明的"规则种子"抽取器(D3):
// `git push` → `git:*`。免弹判定(相等)与落盘都在 loop,rules 逻辑不外泄。
function fakeBash(calls: { n: number }): Tool {
  return {
    name: "bash",
    prefixOf: (a) => `${String((a as { command?: unknown }).command ?? "").split(/\s+/)[0]}:*`,
    async run() {
      calls.n += 1;
      return { content: [{ type: "text", text: "ok" }], isError: false };
    },
  };
}

describe("T2 AC-T2-7: always → 落 rules.json,同前缀下次免弹", () => {
  it("第 1 次 always → 执行 + rules.json 含 {bash,git:*};第 2 次同前缀 → confirm 零调用仍执行", async () => {
    const rulesPath = join(dir, "rules-t27.json");
    const calls = { n: 0 };

    // —— 第 1 趟:应答 always
    const s1 = confirmSpy("always");
    const ctx1: LoopContext = { messages: [{ role: "user", content: "push it" }] };
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("c1", "bash", { command: "git push" })),
        [fakeBash(calls)],
        ctx1,
        { confirm: s1.confirm, rulesPath },
      ),
    );
    expect(s1.prompts).toHaveLength(1);
    expect(calls.n).toBe(1);
    expect(JSON.parse(await readFile(rulesPath, "utf8"))).toEqual(
      expect.arrayContaining([{ tool: "bash", prefix: "git:*" }]),
    );

    // —— 第 2 趟:应答故意设 no —— 若还弹 confirm,run 被拦,calls 不加 → 红。
    const s2 = confirmSpy("no");
    const ctx2: LoopContext = { messages: [{ role: "user", content: "push again" }] };
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("c2", "bash", { command: "git push origin main" })),
        [fakeBash(calls)],
        ctx2,
        { confirm: s2.confirm, rulesPath },
      ),
    );
    expect(s2.prompts).toHaveLength(0); // rules 命中,免弹
    expect(calls.n).toBe(2); // 照常执行
  });
});

describe("T2 AC-T2-8: 手删 rules.json 即撤销 + 无一键全允许", () => {
  it("always 落盘后手删文件 → 下次同前缀重新弹 confirm", async () => {
    const rulesPath = join(dir, "rules-t28a.json");
    const calls = { n: 0 };

    const s1 = confirmSpy("always");
    const ctx1: LoopContext = { messages: [{ role: "user", content: "push" }] };
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("c1", "bash", { command: "git push" })),
        [fakeBash(calls)],
        ctx1,
        { confirm: s1.confirm, rulesPath },
      ),
    );
    expect(s1.prompts).toHaveLength(1);
    await readFile(rulesPath); // 已落盘(存在性由 T2-7 证,这里只为删前确认)

    await rm(rulesPath); // 手删 = 撤销

    const s2 = confirmSpy("yes");
    const ctx2: LoopContext = { messages: [{ role: "user", content: "push 2" }] };
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("c2", "bash", { command: "git push" })),
        [fakeBash(calls)],
        ctx2,
        { confirm: s2.confirm, rulesPath },
      ),
    );
    expect(s2.prompts).toHaveLength(1); // 撤销生效:重新弹
    expect(calls.n).toBe(2); // yes 后照常执行
  });

  it("prefixOf 返 `*` 的工具应答 always → 规则拒写,下次仍弹(loop 无一键全允许)", async () => {
    const rulesPath = join(dir, "rules-t28b.json");
    const calls = { n: 0 };
    const star: Tool = {
      name: "bash",
      prefixOf: () => "*",
      async run() {
        calls.n += 1;
        return { content: [{ type: "text", text: "ok" }], isError: false };
      },
    };

    const s1 = confirmSpy("always");
    const ctx1: LoopContext = { messages: [{ role: "user", content: "yolo" }] };
    await collect(
      runLoop(twoTurnStream(toolCallTurn("c1", "bash", { command: "rm -rf /" })), [star], ctx1, {
        confirm: s1.confirm,
        rulesPath,
      }),
    );
    expect(s1.prompts).toHaveLength(1); // 弹过
    expect(calls.n).toBe(1); // always 当次仍执行(一次性 yes 语义)
    await expect(stat(rulesPath)).rejects.toMatchObject({ code: "ENOENT" }); // 但规则没落盘

    const s2 = confirmSpy("yes");
    const ctx2: LoopContext = { messages: [{ role: "user", content: "yolo 2" }] };
    await collect(
      runLoop(twoTurnStream(toolCallTurn("c2", "bash", { command: "rm -rf /" })), [star], ctx2, {
        confirm: s2.confirm,
        rulesPath,
      }),
    );
    expect(s2.prompts).toHaveLength(1); // 永远要问 = 没有全允许
  });
});
