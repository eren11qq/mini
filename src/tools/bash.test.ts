import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop } from "../loop/run-loop.ts";
import type { AgentEvent, LoopContext } from "../loop/types.ts";
import type { ProviderEvent, StreamFn } from "../stream/protocol.ts";
import { bashTool } from "./bash.ts";

// T4 seam:bashTool via Tool.run(types.ts:110 公共接口)。进程表 = 唯一真相源。
// AC-T4-2:超时杀进程树 —— shell 与其派生子进程皆亡,无僵尸。

function textOf(r: { content: { text: string }[] }): string {
  return r.content.map((b) => b.text).join("\n");
}

function pgrep(pattern: string): string {
  const r = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  return (r.stdout ?? "").trim();
}

// SIGKILL 已发但内核收尾有微窗:短轮询判"终会消失",区别于"永不在杀"(必红)。
async function pgrepGone(pattern: string, budgetMs = 2000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (pgrep(pattern) === "") return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// 落盘路径在 result 文本里以 `full output: <path>` 形式声明(测试据此提取,不猜命名)。
describe("T4 bash:超时杀进程树", () => {
  it("AC-T4-2 timeout=100ms → 秒级返回 isError:true;99101(后台子)与 99102(前台壳)皆无存活", async () => {
    const t0 = Date.now();
    // `&` 后台 sleep = 壳的直接子进程:只 kill 壳则它存活 → pgrepGone 恒 false → 红。
    const result = await bashTool.run({ command: "sleep 99101 & sleep 99102", timeout: 100 });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(3000);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/timed out/);
    // Must not:留下运行中的 sleep 进程(整组:pgid 杀)。
    expect(await pgrepGone("sleep 9910")).toBe(true);
  });
});

describe("T4 bash:全量输出落临时文件", () => {
  it("AC-T4-3 seq 1 50 → result 含临时文件路径,文件 = 全量 stdout(1..50 + 尾换行)", async () => {
    const result = await bashTool.run({ command: "seq 1 50" });

    expect(result.isError).toBe(false);
    const m = textOf(result).match(/full output: (\S+)/);
    expect(m).not.toBeNull();
    // seq 的输出 = 已知-good 字面:1..50 每行一个,尾换行。非按实现反推。
    expect(await readFile(m![1]!, "utf8")).toBe(
      Array.from({ length: 50 }, (_, i) => `${i + 1}`).join("\n") + "\n",
    );
  });
});

describe("T4 bash:保尾截断", () => {
  it("AC-T4-4 seq 1 6000 → 内联输出 ≤2000 行且 ≤50KB、含截断提示与末行 6000;临时文件仍全量", async () => {
    const result = await bashTool.run({ command: "seq 1 6000" });
    expect(result.isError).toBe(false);

    // 结果体约定:第 1 行 exit code,第 2 行 `full output: <path>`,其后 = 内联输出(可截断)。
    const lines = textOf(result).split("\n");
    const body = lines.slice(2).join("\n");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(50 * 1024);
    expect(lines.slice(2).length).toBeLessThanOrEqual(2000);
    expect(body).toMatch(/\[truncated: showing last \d+ of 6000 lines\]/);
    expect(body.endsWith("6000")).toBe(true);

    const m = lines[1]?.match(/full output: (\S+)/);
    expect(m).not.toBeNull();
    const full = await readFile(m![1]!, "utf8");
    expect(full.split("\n").filter(Boolean)).toHaveLength(6000);
    expect(full.endsWith("\n6000\n")).toBe(true);
  });
});

// AC-T4-5:确认逻辑在 loop(story 24)。真 bashTool 不置 skipConfirm → 必过门;"no" 则命令不执行。
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function collect(gen: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

function bashCallTurn(id: string, args: unknown): AsyncIterable<ProviderEvent> {
  return (async function* () {
    yield { type: "start" };
    yield { type: "toolcall_delta", id, name: "bash", arguments: args };
    yield { type: "done", stopReason: "tool_use" };
  })();
}

function twoTurnText(turn1: AsyncIterable<ProviderEvent>): StreamFn {
  let n = 0;
  return () => {
    if (++n === 1) return turn1;
    return (async function* () {
      yield { type: "start" };
      yield { type: "text_delta", delta: "ok" };
      yield { type: "done", stopReason: "stop" };
    })();
  };
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mini-bash-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("T4 bash:过 loop 确认门", () => {
  it("AC-T4-5 confirm=no → 弹 1 次、touch marker 未执行、回喂 isError:true user rejected", async () => {
    const marker = join(dir, "marker");
    const prompts: string[] = [];
    const ctx: LoopContext = { messages: [{ role: "user", content: "make marker" }] };

    const events = await collect(
      runLoop(twoTurnText(bashCallTurn("c1", { command: `touch ${marker}` })), [bashTool], ctx, {
        confirm: (p) => {
          prompts.push(p);
          return { kind: "no" as const };
        },
      }),
    );

    // 真 bashTool 自动过安检:门确实在 loop 侧弹了。
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("bash");
    // Must not:命令未执行 = marker 不存在(若绕过门直接 run,99% 概率已建 → 红)。
    expect(await exists(marker)).toBe(false);
    const end = events.find((e) => e.type === "tool_execution_end");
    expect(end?.type === "tool_execution_end" && end.isError).toBe(true);
    expect(
      end?.type === "tool_execution_end" &&
        (end.result as { content: { text: string }[] }).content[0]!.text,
    ).toContain("user rejected");
  });
});

// C3(docs/ISSUES.md):复合命令拆段、逐段过检 —— 任一段不命中即弹,弹展示完整原命令。
describe("C3 复合命令逐段过检(真 bashTool 过 loop 门)", () => {
  it("AC-C3-1 有 `git status:*` 规则:`git status && touch m` 弹(答 no → marker 不建);单 `git status` 免弹", async () => {
    const rulesPath = join(dir, "rules-c31.json");
    await writeFile(rulesPath, JSON.stringify([{ tool: "bash", prefix: "git status:*" }]));
    const marker = join(dir, "c31-marker");
    const prompts: string[] = [];
    const confirm = (p: string) => {
      prompts.push(p);
      return { kind: "no" as const };
    };

    const ctx1: LoopContext = { messages: [{ role: "user", content: "chained" }] };
    await collect(
      runLoop(
        twoTurnText(bashCallTurn("c1", { command: `git status && touch ${marker}` })),
        [bashTool],
        ctx1,
        { confirm, rulesPath },
      ),
    );
    expect(prompts).toHaveLength(1); // rm 类比:第二段无规则 → 必弹
    expect(prompts[0]).toContain("git status && touch"); // 弹窗展示完整原命令
    expect(await exists(marker)).toBe(false); // 弹后答 no → 整条未执行

    const ctx2: LoopContext = { messages: [{ role: "user", content: "single" }] };
    await collect(
      runLoop(twoTurnText(bashCallTurn("c2", { command: "git status" })), [bashTool], ctx2, {
        confirm,
        rulesPath,
      }),
    );
    expect(prompts).toHaveLength(1); // 单段命中既有规则 → 免弹,不加新弹
  });

  // AC-C3-2 原文 `git add -A && git commit -m x` 在 cwd(= 本仓库)有写副作用。曾换用只读
  // git 段(`git status`/`git diff`)保同形;但 C4 起该两段进只读白名单免弹、不再走 always 落盘,
  // 故再换 `git rev-parse`/`git ls-files`:两段、两家族、无写副作用、非白名单 → always 落两条、重跑 0 弹。
  it("AC-C3-2 复合 always → 每段一条规则落盘,重跑 0 弹", async () => {
    const rulesPath = join(dir, "rules-c32.json");
    const cmd = { command: "git rev-parse HEAD && git ls-files" };
    const prompts: string[] = [];
    const confirm = (answer: "always" | "no") => (p: string) => {
      prompts.push(p);
      return { kind: answer };
    };

    const ctx1: LoopContext = { messages: [{ role: "user", content: "a" }] };
    await collect(
      runLoop(twoTurnText(bashCallTurn("c1", cmd)), [bashTool], ctx1, {
        confirm: confirm("always"),
        rulesPath,
      }),
    );
    expect(prompts).toHaveLength(1);
    expect(JSON.parse(await readFile(rulesPath, "utf8"))).toEqual([
      { tool: "bash", prefix: "git rev-parse:*" },
      { tool: "bash", prefix: "git ls-files:*" },
    ]);

    // 第 2 趟:应答故意 no —— 若还弹,run 被拦、prompts 加 → 红。
    const ctx2: LoopContext = { messages: [{ role: "user", content: "b" }] };
    await collect(
      runLoop(twoTurnText(bashCallTurn("c2", cmd)), [bashTool], ctx2, {
        confirm: confirm("no"),
        rulesPath,
      }),
    );
    expect(prompts).toHaveLength(1); // 两段各命中自家规则 → 免弹
  });

  it("AC-C3-4 未闭合引号:有 `echo:*` 规则仍必弹;答 always 不落盘,重跑再弹不崩", async () => {
    const rulesPath = join(dir, "rules-c34.json");
    const seedRules = [{ tool: "bash", prefix: "echo:*" }];
    await writeFile(rulesPath, JSON.stringify(seedRules));
    const prompts: string[] = [];
    const confirm = (p: string) => {
      prompts.push(p);
      return { kind: "always" as const };
    };
    const cmd = { command: 'echo "oops' };

    for (const id of ["c1", "c2"]) {
      const ctx: LoopContext = { messages: [{ role: "user", content: "quote" }] };
      await collect(
        runLoop(twoTurnText(bashCallTurn(id, cmd)), [bashTool], ctx, { confirm, rulesPath }),
      );
    }
    expect(prompts).toHaveLength(2); // 两趟都弹(解析失败 = 必弹兜底)
    expect(JSON.parse(await readFile(rulesPath, "utf8"))).toEqual(seedRules); // always 未落新规则
  });
});
