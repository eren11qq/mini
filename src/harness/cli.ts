// H1 harness:组装 + 裸 readline + 流式 stdout。AC-H1-3 = 本文件零业务逻辑:
// 停止判定、schema 校验、确认门规则、压缩全在 loop/stream/tools/memory 层,
// 这里只做「拼参数 → 转事件 → 落盘」,唯一的加工是 provider 工具形态映射(纯搬运)。
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

import { runLoop } from "../loop/run-loop.ts";
import type { LoopContext, ProviderConfig, Tool, UserMessage } from "../loop/types.ts";
import { SessionManager } from "../memory/session-manager.ts";
import { createStream } from "../stream/openai-completions.ts";
import { bashTool } from "../tools/bash.ts";
import { editTool } from "../tools/edit.ts";
import { readTool } from "../tools/read.ts";
import { writeTool } from "../tools/write.ts";
import { createRenderer } from "./renderer.ts";

// H1 只有一行配置(选厂商 = H2 --model)。密钥只从 env 读(PRD 约束)。
const PROVIDER: ProviderConfig = {
  dialect: "openai-completions",
  base_url: "https://api.deepseek.com/v1",
  key_env: "DEEPSEEK_API_KEY",
  models: [{ id: "deepseek-chat", contextWindow: 64000 }],
};

const TOOLS: Tool[] = [readTool, writeTool, editTool, bashTool];

// provider 侧要 {name, description, parameters};parameters 单源 = tool.schema,不抄第二份。
const providerTools = TOOLS.map((t) => ({
  name: t.name,
  ...(t.description ? { description: t.description } : {}),
  ...(t.schema ? { parameters: t.schema } : {}),
}));

async function main(): Promise<void> {
  if (!process.env[PROVIDER.key_env]) {
    process.stderr.write(`${PROVIDER.key_env} 未设置(密钥只从 env 读)。\n`);
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("close", () => process.exit(0)); // Ctrl+D

  // Story 16:Ctrl+C = 中断在跑的那一轮(stream + 工具),空转时 = 退出。
  // 中断语义全在 loop(AC-L3-4/6:stopReason="aborted" → agent_end(reason)),这里只按开关。
  let controller: AbortController | null = null;
  rl.on("SIGINT", () => {
    if (controller) controller.abort();
    else process.exit(0);
    process.stdout.write("\n"); // tty 不回显 ^C,补换行让后续输出不粘连
  });
  const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));
  const render = createRenderer((s) => process.stdout.write(s));

  const cwd = process.cwd();
  const session = SessionManager.open({ baseDir: join(homedir(), ".mini", "sessions"), cwd });
  const context: LoopContext = {
    // 接回最近会话历史(M2 rebuild 缝);挑会话 = H2 --continue/--resume 的事。
    messages: session.rebuild().messages,
    tools: providerTools,
  };
  const streamFn = createStream(PROVIDER);

  process.stdout.write(
    `mini · ${PROVIDER.models[0]!.id} · ${cwd}\n` +
      `  历史 ${context.messages.length} 条 · Ctrl+C 中断当前轮 / 空转时退出\n`,
  );

  for (;;) {
    const line = (await ask("> ")).trim();
    if (line === "") continue;

    const user: UserMessage = { role: "user", content: line };
    context.messages.push(user);
    session.append({ type: "message", payload: user });

    controller = new AbortController();
    try {
      for await (const event of runLoop(streamFn, TOOLS, context, {
        signal: controller.signal, // SIGINT → loop 停该轮(工具侧 bash 杀进程组)
        rulesPath: join(cwd, "rules.json"), // T2/D4:生产规则落 <cwd>/rules.json
        confirm: async (prompt) => {
          const answer = (await ask(`${prompt} `)).trim().toLowerCase();
          if (answer === "1" || answer === "y" || answer === "yes") return "yes";
          if (answer === "2" || answer.startsWith("always")) return "always";
          return "no";
        },
      })) {
        render(event);
        if (event.type === "message_end") {
          session.append({ type: "message", payload: event.message }); // M1 即时落盘
        }
      }
    } finally {
      controller = null;
    }
  }
}

await main();
