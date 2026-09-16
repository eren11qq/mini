import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop } from "../loop/run-loop.ts";
import type {
  AgentEvent,
  AssistantMessage,
  ConfirmAnswer,
  LoopContext,
  ToolResultMessage,
} from "../loop/types.ts";
import type { ProviderEvent, StreamFn } from "../stream/protocol.ts";
import type { Rule } from "../loop/rules.ts";
import { readTool } from "./read.ts";
import { editTool } from "./edit.ts";
import { writeTool } from "./write.ts";
import { stat } from "node:fs/promises";
import type { Tool } from "./tool.ts";

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
function confirmSpy(answer: ConfirmAnswer["kind"], reason?: string) {
  const prompts: string[] = [];
  const confirm = (prompt: string) => {
    prompts.push(prompt);
    return { kind: answer, ...(reason !== undefined && { reason }) } as ConfirmAnswer;
  };
  return { prompts, confirm };
}

// C6 AC-2/AC-4:抽弹面规则行 —— 行内式(`…规则: bash  git commit:*`)与列表式(`    bash  git diff:*`)
// 同一条正则:`<tool>` + 两个空格 + 非空 prefix。首行 `Execute: bash({…` 无双空格,不误匹配。
function printedRules(prompt: string): string[] {
  return prompt
    .split("\n")
    .map((l) => /\b(bash|write|edit)\s{2}(\S.*\S)$/.exec(l.trimEnd()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => `${m[1]}  ${m[2]}`);
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
    matchOf: (a) => String((a as { command?: unknown }).command ?? ""),
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

// C2(docs/ISSUES.md):规则匹配从"整串相等"升级为 ruleMatches(token 前缀家族)。
// 判据输入 = 完整命令(matchOf),不再拿 prefixOf 种子串比种子串。
describe("C2 端到端:token 家族规则过确认门", () => {
  it("规则 `git status:*` → `git status -sb` 免弹执行;`git commit -m x` 仍弹", async () => {
    const rulesPath = join(dir, "rules-c2.json");
    await writeFile(rulesPath, JSON.stringify([{ tool: "bash", prefix: "git status:*" }]));
    const calls = { n: 0 };

    const s1 = confirmSpy("no"); // 免弹故应答无意义;若弹 → 拦下 → prompts 1 = 红
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("c1", "bash", { command: "git status -sb" })),
        [fakeBash(calls)],
        { messages: [{ role: "user", content: "s" }] },
        { confirm: s1.confirm, rulesPath },
      ),
    );
    expect(s1.prompts).toHaveLength(0);
    expect(calls.n).toBe(1);

    const s2 = confirmSpy("no");
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("c2", "bash", { command: "git commit -m x" })),
        [fakeBash(calls)],
        { messages: [{ role: "user", content: "c" }] },
        { confirm: s2.confirm, rulesPath },
      ),
    );
    expect(s2.prompts).toHaveLength(1);
    expect(calls.n).toBe(1); // no → 未执行
  });
});

// C1(docs/ISSUES.md):文件类种子 = 规范化 path(`path:` 域),内容变化不再击落规则;
// cwd 外路径 → prefixOf 返 `*` 拒写标记(AC-T2-8 既有机器退化一次性 yes,loop 零新码)。
describe("C1 端到端:write 的 always 必粘 + cwd 外拒粘", () => {
  let cwdTmp: string;
  beforeAll(async () => {
    cwdTmp = await mkdtemp(join(process.cwd(), ".mini-c1-")); // 故意落在 cwd 内
  });
  afterAll(async () => {
    await rm(cwdTmp, { recursive: true, force: true });
  });

  it("同文件两次 write(内容不同)均应答 always → confirm 仅 1 次、两次都落盘", async () => {
    const rulesPath = join(dir, "rules-c1a.json");
    const path = join(cwdTmp, "a.txt"); // cwd 内 → 相对 path: 种子
    const s = confirmSpy("always");
    for (const content of ["V1", "V2"]) {
      await collect(
        runLoop(
          twoTurnStream(toolCallTurn(`w-${content}`, "write", { path, content })),
          [writeTool],
          { messages: [{ role: "user", content }] },
          { confirm: s.confirm, rulesPath },
        ),
      );
    }
    expect(s.prompts).toHaveLength(1); // 现状 bug 在此红:种子=整 JSON,内容变即脱靶
    expect(await readFile(path, "utf8")).toBe("V2");
    const rules: unknown = JSON.parse(await readFile(rulesPath, "utf8"));
    expect(rules).toEqual(
      expect.arrayContaining([
        { tool: "write", prefix: expect.stringMatching(/^path:\.mini-c1-[^/]+\/a\.txt$/) },
      ]),
    );
  });

  it("同文件连续 edit 两次(锚点不同)均 always → confirm 仅首弹,两批锚皆落盘", async () => {
    const rulesPath = join(dir, "rules-c1c.json");
    const path = join(cwdTmp, "e.txt");
    await writeFile(path, "aaa\nbbb");
    const s = confirmSpy("always");
    for (const [id, oldText, newText] of [
      ["e1", "aaa", "AAA"],
      ["e2", "bbb", "BBB"],
    ] as const) {
      await collect(
        runLoop(
          twoTurnStream(toolCallTurn(id, "edit", { path, edits: [{ oldText, newText }] })),
          [editTool],
          { messages: [{ role: "user", content: id }] },
          { confirm: s.confirm, rulesPath },
        ),
      );
    }
    expect(s.prompts).toHaveLength(1);
    expect(await readFile(path, "utf8")).toBe("AAA\nBBB");
  });

  it("cwd 外绝对路径 always → 规则拒写,第二次仍弹(prompts 2)", async () => {
    const rulesPath = join(dir, "rules-c1b.json");
    const path = join(dir, "out.txt"); // /tmp = cwd 外
    const s = confirmSpy("always");
    for (const content of ["A", "B"]) {
      await collect(
        runLoop(
          twoTurnStream(toolCallTurn(`o-${content}`, "write", { path, content })),
          [writeTool],
          { messages: [{ role: "user", content }] },
          { confirm: s.confirm, rulesPath },
        ),
      );
    }
    expect(s.prompts).toHaveLength(2);
    expect(await readFile(rulesPath, "utf8").catch(() => "[]")).toBe("[]");
  });
});

// C5(docs/ISSUES.md):判据输入与种子拆分。cwd 外路径 matchOf 改给 `path:`+绝对
// —— 黑名单(`~/.ssh/**` `~/.aws/**` `**/*.env`)要有料可查;prefixOf 照旧 `*`
// = C1 always 拒写语义不动(现有 "cwd 外…第二次仍弹" 回归即守门)。
describe("C5 判据抽取:matchOf/prefixOf 拆分", () => {
  it("cwd 外 write → matchOf = `path:`+绝对,prefixOf = `*`", () => {
    const out = join(dir, "z.txt");
    expect(writeTool.matchOf!({ path: out })).toBe(`path:${out}`);
    expect(writeTool.prefixOf!({ path: out })).toBe("*");
  });

  it("cwd 内 write → 两者同值 `path:`+相对正斜杠;edit 同式", () => {
    const p = join(process.cwd(), "sub", "a.ts");
    expect(writeTool.matchOf!({ path: p })).toBe("path:sub/a.ts");
    expect(writeTool.prefixOf!({ path: p })).toBe("path:sub/a.ts");
    expect(editTool.matchOf!({ path: p, edits: [] })).toBe("path:sub/a.ts");
  });

  it("write/edit 声明 matchKind = path(黑名单文件路径判定的开关)", () => {
    expect(writeTool.matchKind).toBe("path");
    expect(editTool.matchKind).toBe("path");
  });
});

// C5(docs/ISSUES.md):危险黑名单 = 确认门新层,先于一切 allow(规则/只读表/模式开关
// 不可豁免),命中必弹、弹头打印风险原因、always 不落盘(黑名单永远赢,写规则只误导)。
// bash 段级判定用假 shell 工具(同真 bash 的 matchOf/prefixOf/matchKind 形状),不落 exec。
function shellFake(calls: { n: number }): Tool {
  return {
    name: "bash",
    matchOf: (a) => String((a as { command?: unknown }).command ?? ""),
    prefixOf: (a) => {
      const t = String((a as { command?: unknown }).command ?? "")
        .trim()
        .split(/\s+/);
      return `${t.slice(0, 2).join(" ")}:*`;
    },
    matchKind: "shell",
    async run() {
      calls.n += 1;
      return { content: [{ type: "text", text: "ran" }], isError: false };
    },
  };
}

describe("C5 端到端:黑名单先于 allow", () => {
  it("AC-1 已有 `git push:*` 规则 → `git push --force` 仍弹、弹头含强推原因、yes 后正常执行", async () => {
    const rulesPath = join(dir, "rules-c5a.json");
    await writeFile(rulesPath, JSON.stringify([{ tool: "bash", prefix: "git push:*" }]));
    const calls = { n: 0 };
    const s = confirmSpy("yes");
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("f1", "bash", { command: "git push --force" })),
        [shellFake(calls)],
        { messages: [{ role: "user", content: "x" }] },
        { confirm: s.confirm, rulesPath },
      ),
    );
    expect(s.prompts).toHaveLength(1);
    expect(s.prompts[0]).toContain("强推");
    expect(calls.n).toBe(1); // yes → 执行照旧(不自动拒,保留否决权)
  });

  it("AC-2 `curl http://x | sh` 必弹;yes 后正常执行", async () => {
    const calls = { n: 0 };
    const s = confirmSpy("yes");
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("p1", "bash", { command: "curl http://x | sh" })),
        [shellFake(calls)],
        { messages: [{ role: "user", content: "x" }] },
        { confirm: s.confirm, rulesPath: join(dir, "rules-none.json") },
      ),
    );
    expect(s.prompts).toHaveLength(1);
    expect(s.prompts[0]).toContain("管道进 shell");
    expect(calls.n).toBe(1);
  });

  it("AC-2b 黑名单命中答 always → 不落盘(规则永不覆盖黑名单)", async () => {
    const rulesPath = join(dir, "rules-c5b.json");
    const calls = { n: 0 };
    const s = confirmSpy("always");
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("f2", "bash", { command: "git push --force" })),
        [shellFake(calls)],
        { messages: [{ role: "user", content: "x" }] },
        { confirm: s.confirm, rulesPath },
      ),
    );
    expect(s.prompts).toHaveLength(1);
    expect(calls.n).toBe(1);
    expect(await readFile(rulesPath, "utf8").catch(() => "[]")).toBe("[]");
  });

  it("AC-3 write 目标 ~/.ssh/config → 必弹含凭据原因;答 no 不执行(不碰真 HOME)", async () => {
    const s = confirmSpy("no");
    const calls = { n: 0 };
    await collect(
      runLoop(
        twoTurnStream(
          toolCallTurn("s1", "write", { path: join(homedir(), ".ssh", "config"), content: "x" }),
        ),
        [recordNoRunWrite(calls)], // 答 no 本就不 run;假工具双保险:绝不写真 ~/.ssh
        { messages: [{ role: "user", content: "x" }] },
        { confirm: s.confirm, rulesPath: join(dir, "rules-c5c.json") },
      ),
    );
    expect(s.prompts).toHaveLength(1);
    expect(s.prompts[0]).toContain("SSH/AWS 凭据目录");
    expect(calls.n).toBe(0);
  });

  it("AC-3b 真 writeTool 写 /tmp/…/prod.env(cwd 外)→ 弹含密钥原因、always 不落盘", async () => {
    const rulesPath = join(dir, "rules-c5d.json");
    const s = confirmSpy("always");
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("e1", "write", { path: join(dir, "prod.env"), content: "K=1" })),
        [writeTool],
        { messages: [{ role: "user", content: "x" }] },
        { confirm: s.confirm, rulesPath },
      ),
    );
    expect(s.prompts).toHaveLength(1);
    expect(s.prompts[0]).toContain("*.env 密钥文件");
    expect(await readFile(rulesPath, "utf8").catch(() => "[]")).toBe("[]");
    // seed = `*`(cwd 外)→ always 既有拒粘机器兜住,不写规则也不该写文件成功与否无关。
  });

  it("AC-4 规则写歪(`sudo:*` 预批)仍压不过黑名单 → `sudo ls -la` 必弹", async () => {
    const rulesPath = join(dir, "rules-c5e.json");
    await writeFile(rulesPath, JSON.stringify([{ tool: "bash", prefix: "sudo:*" }]));
    const calls = { n: 0 };
    const s = confirmSpy("yes");
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("u1", "bash", { command: "sudo ls -la" })),
        [shellFake(calls)],
        { messages: [{ role: "user", content: "x" }] },
        { confirm: s.confirm, rulesPath },
      ),
    );
    expect(s.prompts).toHaveLength(1);
    expect(s.prompts[0]).toContain("sudo 提权");
  });

  it("复合段堵洞:有 `git status:*` 规则,`git status && rm -rf ~` 必弹(rm 段)", async () => {
    const rulesPath = join(dir, "rules-c5f.json");
    await writeFile(rulesPath, JSON.stringify([{ tool: "bash", prefix: "git status:*" }]));
    const calls = { n: 0 };
    const s = confirmSpy("no");
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("m1", "bash", { command: "git status && rm -rf ~" })),
        [shellFake(calls)],
        { messages: [{ role: "user", content: "x" }] },
        { confirm: s.confirm, rulesPath },
      ),
    );
    expect(s.prompts).toHaveLength(1);
    expect(s.prompts[0]).toContain("rm -rf 指向根/家目录");
    expect(calls.n).toBe(0);
  });
});

// C5 AC-3 用的记录型假 write:同真 write 的判据/种子/matchKind,run 只计数(不碰真 HOME)。
function recordNoRunWrite(calls: { n: number }): Tool {
  return {
    name: "write",
    matchOf: (a) => `path:${String((a as { path?: unknown }).path ?? "")}`,
    prefixOf: () => "*",
    matchKind: "path",
    async run() {
      calls.n += 1;
      return { content: [{ type: "text", text: "noop" }], isError: false };
    },
  };
}

// C7(docs/ISSUES.md):--auto-accept-edits —— 仅 path 工具 + cwd 内直通;bash/cwd 外/黑名单不豁免。
describe("C7 端到端:auto-accept-edits", () => {
  let cwdTmp: string;
  beforeAll(async () => {
    cwdTmp = await mkdtemp(join(process.cwd(), ".mini-c7-"));
  });
  afterAll(async () => {
    await rm(cwdTmp, { recursive: true, force: true });
  });

  it("flag 开:连续 2 次 cwd 内 write → confirm 零调用、两份都落盘", async () => {
    const s = confirmSpy("no");
    for (const [name, content] of [
      ["a.txt", "1"],
      ["b.txt", "2"],
    ] as const) {
      await collect(
        runLoop(
          twoTurnStream(toolCallTurn(`w-${name}`, "write", { path: join(cwdTmp, name), content })),
          [writeTool],
          { messages: [{ role: "user", content: name }] },
          { confirm: s.confirm, rulesPath: join(dir, "rules-c7a.json"), autoAcceptEdits: true },
        ),
      );
    }
    expect(s.prompts).toHaveLength(0);
    expect(await readFile(join(cwdTmp, "a.txt"), "utf8")).toBe("1");
    expect(await readFile(join(cwdTmp, "b.txt"), "utf8")).toBe("2");
    expect(await readFile(join(dir, "rules-c7a.json"), "utf8").catch(() => "[]")).toBe("[]");
  });

  it("flag 开:cwd 外 write 必弹", async () => {
    const s = confirmSpy("no");
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("w-out", "write", { path: join(dir, "o.txt"), content: "1" })),
        [writeTool],
        { messages: [{ role: "user", content: "x" }] },
        { confirm: s.confirm, autoAcceptEdits: true },
      ),
    );
    expect(s.prompts).toHaveLength(1);
  });

  it("flag 开:bash 不享直通", async () => {
    const s = confirmSpy("no");
    const calls = { n: 0 };
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("b1", "bash", { command: "echo hi" })),
        [shellFake(calls)],
        { messages: [{ role: "user", content: "x" }] },
        { confirm: s.confirm, autoAcceptEdits: true },
      ),
    );
    expect(s.prompts).toHaveLength(1);
    expect(calls.n).toBe(0);
  });

  it("flag 开:cwd 内 *.env 仍被黑名单拦下弹", async () => {
    const s = confirmSpy("no");
    await collect(
      runLoop(
        twoTurnStream(
          toolCallTurn("w-env", "write", { path: join(cwdTmp, "secret.env"), content: "K=1" }),
        ),
        [writeTool],
        { messages: [{ role: "user", content: "x" }] },
        { confirm: s.confirm, autoAcceptEdits: true },
      ),
    );
    expect(s.prompts).toHaveLength(1);
    expect(s.prompts[0]).toContain("*.env 密钥文件");
  });
});

// C6 四档弹窗(AC-1):session 档 = 内存规则,与持久规则同匹配器同短路点,仅生命周期不同。
// 判据:同 run(同一 sessionRules 数组)重跑免弹;rules.json 零新条目 = 不落盘。
describe("C6 AC-1:session 档 —— 同 run 免弹、不落盘", () => {
  it("第 1 次答 session → 执行 + 内存规则含 git push:* + rules.json 无条目;同 sessionRules 第 2 次免弹", async () => {
    const rulesPath = join(dir, "rules-c6a.json");
    const calls = { n: 0 };
    const sessionRules: Rule[] = [];

    const s1 = confirmSpy("session");
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("q1", "bash", { command: "git push" })),
        [shellFake(calls)],
        { messages: [{ role: "user", content: "x" }] },
        { confirm: s1.confirm, rulesPath, sessionRules },
      ),
    );
    expect(s1.prompts).toHaveLength(1);
    expect(calls.n).toBe(1); // session 当次照常执行
    expect(sessionRules).toEqual([{ tool: "bash", prefix: "git push:*" }]);
    expect(await readFile(rulesPath, "utf8").catch(() => "[]")).toBe("[]");

    // 第 2 趟应答故意 no —— 若还弹则 run 被拦、calls 不加 = 红。
    const s2 = confirmSpy("no");
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("q2", "bash", { command: "git push origin main" })),
        [shellFake(calls)],
        { messages: [{ role: "user", content: "x" }] },
        { confirm: s2.confirm, rulesPath, sessionRules },
      ),
    );
    expect(s2.prompts).toHaveLength(0);
    expect(calls.n).toBe(2);
  });

  // AC-1 另一半:session 生命周期止于本 run —— 换新 sessionRules(= 新进程)必复弹。
  it("session 落内存后新 run(新数组)恢复弹;同规则若曾 always 落盘则不弹(对照组)", async () => {
    const rulesPath = join(dir, "rules-c6b.json");
    const calls = { n: 0 };

    // 第 1 趟:session
    const s1 = confirmSpy("session");
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("n1", "bash", { command: "git push" })),
        [shellFake(calls)],
        { messages: [{ role: "user", content: "x" }] },
        { confirm: s1.confirm, rulesPath, sessionRules: [] },
      ),
    );
    expect(s1.prompts).toHaveLength(1);

    // 第 2 趟:新数组(新 run),应答 no → 必弹且被拦
    const s2 = confirmSpy("no");
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("n2", "bash", { command: "git push" })),
        [shellFake(calls)],
        { messages: [{ role: "user", content: "x" }] },
        { confirm: s2.confirm, rulesPath, sessionRules: [] },
      ),
    );
    expect(s2.prompts).toHaveLength(1); // session 未泄漏到下个 run
    expect(calls.n).toBe(1); // 弹后答 no → 未执行
    expect(await readFile(rulesPath, "utf8").catch(() => "[]")).toBe("[]"); // 全程零落盘
  });
});

// C6 AC-2:弹窗印出的规则文案 == rules.json 实际落盘内容,逐字一致(解析断言,非快照)。
// 用户点的就是他批的 —— 印面前 = 落盘面,由同一份建议规则数组渲染,禁止两套字符串。
describe("C6 AC-2:always 印面 == 落盘面", () => {
  it("单段命令 → 弹窗含规则行 `bash  git commit:*`,与落盘 JSON 逐字一致", async () => {
    const rulesPath = join(dir, "rules-c6c.json");
    const calls = { n: 0 };
    const s = confirmSpy("always");
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("a1", "bash", { command: "git commit -m x" })),
        [shellFake(calls)],
        { messages: [{ role: "user", content: "x" }] },
        { confirm: s.confirm, rulesPath },
      ),
    );
    expect(s.prompts).toHaveLength(1);
    const disk = JSON.parse(await readFile(rulesPath, "utf8")) as Rule[];
    expect(printedRules(s.prompts[0] ?? "")).toEqual(disk.map((r) => `${r.tool}  ${r.prefix}`));
    expect(printedRules(s.prompts[0] ?? "")).toEqual(["bash  git commit:*"]);
  });

  // 弹面键位行与 mapConfirm 必须同档:此处钉住印面(测锚),输入流吞行仍归 C8 W 剧本人工跑。
  it("弹面第二行 = 四档键位(1 once / 2 session / 3 always / 4 No)", async () => {
    const calls = { n: 0 };
    const s = confirmSpy("yes");
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("k1", "bash", { command: "git push" })),
        [shellFake(calls)],
        { messages: [{ role: "user", content: "x" }] },
        { confirm: s.confirm, rulesPath: join(dir, "rules-c6f.json") },
      ),
    );
    expect(s.prompts[0]?.split("\n")[1]).toBe(
      "❯ 1 Yes (once)  2 Yes + session  3 Yes + always  4 No",
    );
  });
});

// C6 AC-3:拒 + 理由 → 理由进 toolResult 回喂模型(支撑"拒绝带反馈重试")。
describe("C6 AC-3:no + 理由回喂", () => {
  it("答 4 带理由 → toolResult isError 且文本含理由原文", async () => {
    const calls = { n: 0 };
    const s = confirmSpy("no", "这条会覆盖远端历史");
    const events = await collect(
      runLoop(
        twoTurnStream(toolCallTurn("r1", "bash", { command: "git push" })),
        [shellFake(calls)],
        { messages: [{ role: "user", content: "x" }] },
        { confirm: s.confirm, rulesPath: join(dir, "rules-c6d.json") },
      ),
    );
    const end = events.find((e) => e.type === "tool_execution_end");
    expect(end?.type).toBe("tool_execution_end");
    if (end?.type !== "tool_execution_end") return;
    expect(end.isError).toBe(true);
    expect((end.result as { content: { text: string }[] }).content[0]!.text).toContain(
      "这条会覆盖远端历史",
    );
    expect(calls.n).toBe(0); // 拒 = 不执行
  });
});

// C4(docs/ISSUES.md):内置只读命令白名单 —— 只读 bash 段免弹且不产生规则。整条经 runLoop
// 公共入口 + shellFake(真 bash 的 matchKind/判据形状)判,不落 exec。
describe("C4 端到端:只读白名单免弹 + AC-1 零落盘", () => {
  it("AC-1 `ls -la` / `git diff HEAD` / `git status -sb` → confirm 零调用、rules.json 不落新条目", async () => {
    const rulesPath = join(dir, "rules-c4a.json");
    const calls = { n: 0 };
    let i = 0;
    for (const cmd of ["ls -la", "git diff HEAD", "git status -sb"]) {
      const s = confirmSpy("no"); // 免弹故应答无意义;若弹 → 被 no 拦 → calls 不加 = 红
      await collect(
        runLoop(
          twoTurnStream(toolCallTurn(`c4-${++i}`, "bash", { command: cmd })),
          [shellFake(calls)],
          { messages: [{ role: "user", content: "x" }] },
          { confirm: s.confirm, rulesPath },
        ),
      );
      expect(s.prompts).toHaveLength(0);
    }
    expect(calls.n).toBe(3); // 三条均免弹照常执行
    expect(await readFile(rulesPath, "utf8").catch(() => "[]")).toBe("[]"); // 白名单不产规则
  });

  it("AC-2 出口条件回弹窗流:`cat x > y`(重定向)/ `ls > /tmp/a`(重定向+黑名单)/ `find . -delete`(写 flag)→ 必弹、答 no 不执行", async () => {
    const calls = { n: 0 };
    let i = 0;
    for (const cmd of ["cat x > y", "ls > /tmp/a", "find . -delete"]) {
      const s = confirmSpy("no");
      await collect(
        runLoop(
          twoTurnStream(toolCallTurn(`c42-${++i}`, "bash", { command: cmd })),
          [shellFake(calls)],
          { messages: [{ role: "user", content: "x" }] },
          { confirm: s.confirm, rulesPath: join(dir, "rules-none-c42.json") },
        ),
      );
      expect(s.prompts).toHaveLength(1); // 白名单不覆盖 → 弹
      expect(calls.n).toBe(0); // 答 no → 未执行
    }
  });

  it("AC-3a 白名单命中 ≡ pre-existing 规则命中:均短路 confirm", async () => {
    // 规则命中侧:非只读命令 `git commit -m x` 配 `git commit:*` 规则 → 免弹。
    const rulesPath = join(dir, "rules-c43.json");
    await writeFile(rulesPath, JSON.stringify([{ tool: "bash", prefix: "git commit:*" }]));
    const sRule = confirmSpy("no");
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("c43-r", "bash", { command: "git commit -m x" })),
        [shellFake({ n: 0 })],
        { messages: [{ role: "user", content: "x" }] },
        { confirm: sRule.confirm, rulesPath },
      ),
    );
    expect(sRule.prompts).toHaveLength(0); // 规则短路
    // 白名单命中侧:只读命令无任何规则 → 同一短路效果(见 AC-1)。
  });

  it("AC-3b 白名单短路点在黑名单之后:`ls -la && git push --force` / `sudo ls -la` 必弹", async () => {
    const calls = { n: 0 };
    let i = 0;
    for (const cmd of ["ls -la && git push --force", "sudo ls -la"]) {
      const s = confirmSpy("no");
      await collect(
        runLoop(
          twoTurnStream(toolCallTurn(`c43b-${++i}`, "bash", { command: cmd })),
          [shellFake(calls)],
          { messages: [{ role: "user", content: "x" }] },
          { confirm: s.confirm, rulesPath: join(dir, "rules-none-c43b.json") },
        ),
      );
      expect(s.prompts).toHaveLength(1); // 黑名单赢,只读段不豁免整条
      expect(calls.n).toBe(0);
    }
  });

  it("AC-4 非 shell 假危险工具不受表影响(matchKind 缺省 → parsed=null):matchOf 给 `ls` 仍必弹", async () => {
    let runCalls = 0;
    const fakeDanger: Tool = {
      name: "mystery",
      matchOf: () => "ls -la", // 看着像只读,但无 matchKind:shell → 白名单不适用
      prefixOf: () => "*",
      async run() {
        runCalls += 1;
        return { content: [{ type: "text", text: "boom" }], isError: false };
      },
    };
    const s = confirmSpy("no");
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("c44", "mystery", { anything: 1 })),
        [fakeDanger],
        { messages: [{ role: "user", content: "x" }] },
        { confirm: s.confirm, rulesPath: join(dir, "rules-none-c44.json") },
      ),
    );
    expect(s.prompts).toHaveLength(1); // AC-T2-6 不破:非 shell 工具必过安检
    expect(runCalls).toBe(0);
  });
});

// C6 AC-4:复合命令 always 建议 = 每段一条,打印数 == 落盘数(同源一份数组渲染,不可能漂移)。
describe("C6 AC-4:复合命令逐段建议", () => {
  // 复合命令取非白名单只读 git 段(`git status`/`git diff` 自 C4 起免弹,不能再当"必弹"样棒);
  // rev-parse / ls-files 两家族、无写副作用、非只读表 → 仍走 always 逐段落盘路径。
  it("复合命令 `git rev-parse HEAD && git ls-files` 答 always → 弹面 2 条规则行 == 落盘 2 条", async () => {
    const rulesPath = join(dir, "rules-c6e.json");
    const calls = { n: 0 };
    const s = confirmSpy("always");
    await collect(
      runLoop(
        twoTurnStream(
          toolCallTurn("m1", "bash", { command: "git rev-parse HEAD && git ls-files" }),
        ),
        [shellFake(calls)],
        { messages: [{ role: "user", content: "x" }] },
        { confirm: s.confirm, rulesPath },
      ),
    );
    const disk = JSON.parse(await readFile(rulesPath, "utf8")) as Rule[];
    expect(disk).toEqual([
      { tool: "bash", prefix: "git rev-parse:*" },
      { tool: "bash", prefix: "git ls-files:*" },
    ]);
    expect(printedRules(s.prompts[0] ?? "")).toEqual(disk.map((r) => `${r.tool}  ${r.prefix}`));
    expect(s.prompts[0]).toContain("将落盘 2 条规则");
  });
});

// D3(docs/ISSUES.md)同批两段式:A 段弹检串行(弹窗仍一次一个)、B 段并发执行、
// 回填按调用序。假流一圈吐两个独立 call,run 闭包在时间线上记录起止窗。
describe("D3 同批两段式", () => {
  // 同名两单靠 args.tag 区分;5ms 计时器 = 注册序(A 先注册先收尾)→ 时间线确定。
  function taggedSlowRead(tl: string[]): Tool {
    return {
      name: "read",
      schema: {
        type: "object",
        properties: { tag: { type: "string" } },
        required: ["tag"],
        additionalProperties: false,
      },
      async run(a) {
        const tag = String((a as { tag: string }).tag);
        tl.push(`start:${tag}`);
        await new Promise((r) => setTimeout(r, 5));
        tl.push(`end:${tag}`);
        return { content: [{ type: "text", text: tag }], isError: false };
      },
    };
  }
  function twoCallStream(name: string): StreamFn {
    let turn = 0;
    return () => {
      if (++turn === 1) {
        return (async function* () {
          yield { type: "start" };
          yield { type: "toolcall_delta", id: "c1", name, arguments: { tag: "A" } };
          yield { type: "toolcall_delta", id: "c2", name, arguments: { tag: "B" } };
          yield { type: "done", stopReason: "tool_use" };
        })();
      }
      return (async function* () {
        yield { type: "start" };
        yield { type: "text_delta", delta: "done" };
        yield { type: "done", stopReason: "stop" };
      })();
    };
  }

  it("AC-1 两独立 read call → run 窗重叠(第二 start 早于第一 end),回填序 = 调用序", async () => {
    const tl: string[] = [];
    const context: LoopContext = { messages: [{ role: "user", content: "two reads" }] };
    const events = await collect(runLoop(twoCallStream("read"), [taggedSlowRead(tl)], context, {}));

    expect(tl).toEqual(["start:A", "start:B", "end:A", "end:B"]);

    const idxOf = (type: string, id: string) =>
      events.findIndex((e) => e.type === type && (e as { toolCallId: string }).toolCallId === id);
    // start 在 B 段前按调用序统一发,end 按调用序回填
    expect(idxOf("tool_execution_start", "c1")).toBeLessThan(idxOf("tool_execution_start", "c2"));
    expect(idxOf("tool_execution_start", "c2")).toBeLessThan(idxOf("tool_execution_end", "c1"));
    expect(idxOf("tool_execution_end", "c1")).toBeLessThan(idxOf("tool_execution_end", "c2"));

    const ids = context.messages
      .filter((m): m is ToolResultMessage => m.role === "toolResult")
      .map((m) => m.toolCallId);
    expect(ids).toEqual(["c1", "c2"]);
  });

  it("AC-2 两未预批 call → confirm 恰 2 且串行(弹全部先于任何 run),双 yes 后两 run 并发", async () => {
    const tl: string[] = [];
    const prompts: string[] = [];
    const confirm = (p: string): ConfirmAnswer => {
      prompts.push(p);
      tl.push(`confirm:${prompts.length}`);
      return { kind: "yes" };
    };
    const doit: Tool = {
      name: "doit",
      schema: {
        type: "object",
        properties: { tag: { type: "string" } },
        required: ["tag"],
        additionalProperties: false,
      },
      async run(a) {
        const tag = String((a as { tag: string }).tag);
        tl.push(`start:${tag}`);
        await new Promise((r) => setTimeout(r, 5));
        tl.push(`end:${tag}`);
        return { content: [{ type: "text", text: tag }], isError: false };
      },
    };

    const context: LoopContext = { messages: [{ role: "user", content: "go" }] };
    await collect(runLoop(twoCallStream("doit"), [doit], context, { confirm }));

    expect(prompts).toHaveLength(2);
    // A 段弹窗逐次串行,run 全在弹完之后 = start×2 夹在 confirm×2 与 end×2 之间(并发)
    expect(tl).toEqual(["confirm:1", "confirm:2", "start:A", "start:B", "end:A", "end:B"]);
  });

  it("AC-3a A→B 之间命中 abort → B 不启动、零 tool 事件,整批走既有 aborted 路径", async () => {
    let runN = 0;
    const t: Tool = {
      name: "doit",
      async run() {
        runN += 1;
        return { content: [{ type: "text", text: "x" }], isError: false };
      },
    };
    const controller = new AbortController();
    const prompts: string[] = [];
    const confirm = (p: string): ConfirmAnswer => {
      prompts.push(p);
      if (prompts.length === 2) controller.abort(); // 最后一次 A 段弹答完 = 落在 A→B 缝
      return { kind: "yes" };
    };

    const context: LoopContext = { messages: [{ role: "user", content: "go" }] };
    const events = await collect(
      runLoop(twoCallStream("doit"), [t], context, { confirm, signal: controller.signal }),
    );

    expect(prompts).toHaveLength(2); // A 段两弹均已答(abort 正发生在其间隙后)
    expect(runN).toBe(0); // B 段未启动
    expect(
      events.filter((e) => e.type === "tool_execution_start" || e.type === "tool_execution_end"),
    ).toHaveLength(0);
    const tes = events.filter((e) => e.type === "turn_end");
    expect(tes).toHaveLength(1);
    expect(tes[0]?.type === "turn_end" && tes[0].toolResults).toEqual([]);
    expect(context.messages.filter((m) => m.role === "toolResult")).toHaveLength(0);
    const last = events[events.length - 1]!;
    expect(last.type === "agent_end" && last.reason).toBe("aborted");
  });

  it("AC-3b B 中途 abort 杀 run → 缺位全补 isError,配对完整(toWire 可过)", async () => {
    const controller = new AbortController();
    // 观测 signal 即死的假工具(真 bash 的 Story 16 机制面):reject = 全批 Promise 中的缺位。
    const diesOnAbort: Tool = {
      name: "doit",
      async run(_a, signal) {
        await new Promise<never>((_res, rej) => {
          if (signal?.aborted) return rej(new Error("aborted"));
          signal?.addEventListener("abort", () => rej(new Error("aborted")));
        });
        throw new Error("unreachable");
      },
    };

    const context: LoopContext = { messages: [{ role: "user", content: "go" }] };
    const events: AgentEvent[] = [];
    let starts = 0;
    // 手工驱动:第 2 个 tool_execution_start(= B 段已开跑)后 abort。
    for await (const ev of runLoop(twoCallStream("doit"), [diesOnAbort], context, {
      signal: controller.signal,
    })) {
      events.push(ev);
      if (ev.type === "tool_execution_start" && ++starts === 2) controller.abort();
    }

    const ends = events.filter((e) => e.type === "tool_execution_end");
    expect(ends.map((e) => (e.type === "tool_execution_end" ? e.toolCallId : null))).toEqual([
      "c1",
      "c2",
    ]);
    expect(ends.every((e) => e.type === "tool_execution_end" && e.isError)).toBe(true);
    const msgs = context.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
    expect(
      msgs.map((m) => [m.toolCallId, m.isError, m.content.map((b) => b.text).join("")]),
    ).toEqual([
      ["c1", true, "aborted"],
      ["c2", true, "aborted"],
    ]);
    // 两个 toolCall 全有配对行(悬空 = 400 靶心,D1 前提不破)
    const asst = context.messages[1] as AssistantMessage;
    expect(asst.content.filter((b) => b.type === "toolCall")).toHaveLength(2);
  });

  it("AC-5 并发批含 terminate=true → 全批完成后停,无第二 turn(AC-L3-5 复验)", async () => {
    const tl: string[] = [];
    const t: Tool = {
      name: "doit",
      async run(a) {
        const tag = String((a as { tag: string }).tag);
        tl.push(`start:${tag}`);
        await new Promise((r) => setTimeout(r, tag === "A" ? 9 : 1)); // B 先完 = 完成序 ≠ 调用序
        tl.push(`end:${tag}`);
        return {
          content: [{ type: "text", text: tag }],
          isError: false,
          ...(tag === "A" ? { terminate: true } : {}),
        };
      },
    };

    const context: LoopContext = { messages: [{ role: "user", content: "go" }] };
    const events = await collect(runLoop(twoCallStream("doit"), [t], context, {}));

    expect(tl).toEqual(["start:A", "start:B", "end:B", "end:A"]); // 并发生效
    const ends = events.filter((e) => e.type === "tool_execution_end");
    expect(ends).toHaveLength(2); // 后完的 terminate 不截走先完的 B 回填
    expect(events.filter((e) => e.type === "turn_start")).toHaveLength(1);
    const last = events[events.length - 1]!;
    expect(last.type === "agent_end" && last.reason).toBe("terminate");
  });
});
