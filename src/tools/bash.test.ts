import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop } from "../loop/run-loop.ts";
import type { AgentEvent, LoopContext, ProviderEvent, StreamFn } from "../loop/types.ts";
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
          return "no";
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
