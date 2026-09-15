// T4 bash 工具:seam = Tool 公共接口(types.ts:110)。
// AC-T4-2:timeout 到 → SIGKILL 整个进程组(detached 使壳 = 组长,kill(-pid) 连子带壳)。
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolResult } from "./tool.ts";
import { tailTruncate } from "./read.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
let fileSeq = 0;

function fail(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command with /bin/sh -c and return its combined stdout/stderr. Optional `timeout` in ms; a timeout or interrupt kills the whole process group. Long output is tail-truncated.",
  // H1 装配发现:bash 原先无 schema → provider 收不到 parameters,只能猜 command 键名。
  schema: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout: { type: "integer", minimum: 1 },
    },
    required: ["command"],
    additionalProperties: false,
  },
  // 规则种子 = 命令首 token(与 loop 侧 T2 假 bash 同式);不置 skipConfirm → 过确认门。
  prefixOf: (a) =>
    `${
      String((a as { command?: unknown }).command ?? "")
        .trim()
        .split(/\s+/)[0]
    }:*`,
  // C2:判据输入 = 整条命令,ruleMatches 按 token 家族/git status:* 级规则免弹。
  matchOf: (a) => String((a as { command?: unknown }).command ?? "").trim(),
  // C3:输入是 shell 命令 → loop 拆段逐段过检(`git status && rm …` 不再借首段家族放行整条)。
  matchKind: "shell",
  async run(args: unknown, loopSignal?: AbortSignal): Promise<ToolResult> {
    // 契约:失败转 isError 回喂,run 不 throw。
    try {
      const a = args as { command?: unknown; timeout?: unknown };
      const command = String(a.command);
      const timeout = Number(a.timeout ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

      const child = spawn("/bin/sh", ["-c", command], {
        detached: true, // 自成进程组 → kill(-pid) 杀整树
        stdio: ["ignore", "pipe", "pipe"],
      });

      let timedOut = false;
      const killTree = () => {
        if (child.pid == null) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* 组已不存在 */
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeout);
      // loop 透传的 abort 与超时同路:杀树。
      const onLoopAbort = () => killTree();
      if (loopSignal) {
        if (loopSignal.aborted) killTree();
        else loopSignal.addEventListener("abort", onLoopAbort, { once: true });
      }

      // AC-T4-3:全量 stdout+stderr 收集,落临时文件,路径写进结果。
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.stderr.on("data", (c: Buffer) => err.push(c));
      const close = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      clearTimeout(timer);
      if (loopSignal) loopSignal.removeEventListener("abort", onLoopAbort);

      const dumpPath = join(tmpdir(), `mini-bash-${Date.now()}-${fileSeq++}.log`);
      const merged = Buffer.concat([...out, ...err]).toString("utf8");
      await writeFile(dumpPath, merged, "utf8");

      if (timedOut) {
        return fail(
          `bash timed out after ${timeout}ms; process tree killed\nfull output: ${dumpPath}`,
        );
      }
      // AC-T4-4:内联只带保尾截断后的输出(2000 行/50KB,read.ts 同源);exit/path 行在前,永不切。
      const inline = merged.trimEnd() === "" ? "" : tailTruncate(merged.trimEnd().split("\n"));
      return {
        content: [
          {
            type: "text",
            text: `exit code ${close}\nfull output: ${dumpPath}${inline ? `\n${inline}` : ""}`,
          },
        ],
        isError: false,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(`bash failed: ${msg}`);
    }
  },
};
