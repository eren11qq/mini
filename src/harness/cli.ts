// H1+H2+H3 harness:组装 + 裸 readline + 流式 stdout。AC-H1-3 = 本文件零业务逻辑:
// 停止判定、schema 校验、确认门规则、压缩全在 loop/stream/tools/memory 层;H2 的厂商
// 选择/热切/会话挑选的裁决也全在纯缝里(parseArgs / resolveProvider / resolveModel /
// SessionManager.list —— 均可测)。这里只做「读 flag → 选会话 → 拼参数 → 转事件 → 落盘」
// 的搬运,唯一加工是 provider 工具形态映射(纯)。
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

import { runLoop } from "../loop/run-loop.ts";
import type {
  AgentMessage,
  LoopContext,
  ProviderConfig,
  Tool,
  UserMessage,
} from "../loop/types.ts";
import { buildSummarizePrompt } from "../memory/summarize-prompt.ts";
import { serializeConversation } from "../memory/serialize.ts";
import { SessionManager } from "../memory/session-manager.ts";
import { createStream } from "../stream/openai-completions.ts";
import { bashTool } from "../tools/bash.ts";
import { editTool } from "../tools/edit.ts";
import { readTool } from "../tools/read.ts";
import { writeTool } from "../tools/write.ts";
import { parseArgs } from "./args.ts";
import { findProjectContext } from "./project-context.ts";
import { resolveProvider } from "./providers.ts";
import { resolveModel } from "./resolve-model.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { createRenderer } from "./renderer.ts";

// 出厂厂商(无 --model、无历史 model_change 时)。--model <alias> 与 model_change payload
// 存的都是这个表的 key(alias);dialect 由 createStream 内部派发(S3,上层零改动切方言)。
const DEFAULT_ALIAS = "deepseek";

const TOOLS: Tool[] = [readTool, writeTool, editTool, bashTool];

// provider 侧要 {name, description, parameters};parameters 单源 = tool.schema,不抄第二份。
const providerTools = TOOLS.map((t) => ({
  name: t.name,
  ...(t.description ? { description: t.description } : {}),
  ...(t.schema ? { parameters: t.schema } : {}),
}));

// 密钥只从 env 读(PRD 约束)。缺 → 友好报错返回 false(启动缺 = 退出;热切缺 = 不切)。
function ensureKey(provider: ProviderConfig): boolean {
  if (process.env[provider.key_env]) return true;
  process.stderr.write(`${provider.key_env} 未设置(密钥只从 env 读)。\n`);
  return false;
}

// --resume 编号选择器(S-c list → 打表 → 读号 → 命中项)。选号非法 = 明确拒绝,不静默新开。
async function pickSession(
  ask: (q: string) => Promise<string>,
  baseDir: string,
  cwd: string,
): Promise<SessionManager> {
  const sessions = SessionManager.list({ baseDir, cwd });
  if (sessions.length === 0) {
    process.stdout.write("无可恢复会话,新开一个。\n");
    return new SessionManager({ baseDir, cwd });
  }
  process.stdout.write("恢复哪个会话?\n");
  sessions.forEach((s, i) =>
    process.stdout.write(
      `  ${i + 1}) ${new Date(s.mtimeMs).toISOString().slice(0, 19)} · ${s.model ?? DEFAULT_ALIAS} · ${s.sessionId.slice(0, 8)}\n`,
    ),
  );
  const n = Number((await ask("编号: ")).trim());
  const pick = sessions[n - 1];
  if (!pick) {
    process.stderr.write(`无效编号:${n}(1..${sessions.length})。\n`);
    process.exit(1);
  }
  return SessionManager.open({ baseDir, cwd, sessionId: pick.sessionId });
}

async function main(): Promise<void> {
  let args;
  try {
    args = parseArgs(process.argv.slice(2)); // S-b;坏 --model 缺值在此抛
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }

  const baseDir = join(homedir(), ".mini", "sessions");
  const cwd = process.cwd();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("close", () => process.exit(0)); // Ctrl+D

  // Story 16:Ctrl+C = 中断在跑的那一轮(stream + 工具),空转时 = 退出。
  // 中断语义全在 loop(AC-L3-4/6),这里只按开关。
  let controller: AbortController | null = null;
  rl.on("SIGINT", () => {
    if (controller) controller.abort();
    else process.exit(0);
    process.stdout.write("\n"); // tty 不回显 ^C,补换行让后续输出不粘连
  });
  const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));
  const render = createRenderer((s) => process.stdout.write(s));

  // ---- 选会话(AC-H2-4/5):--resume 编号选择器 > --continue 最近 > 新会话 ----
  let session: SessionManager;
  if (args.resume) session = await pickSession(ask, baseDir, cwd);
  else if (args.continue)
    session = SessionManager.open({ baseDir, cwd }); // 无 sessionId = 最新
  else session = new SessionManager({ baseDir, cwd });

  // ---- 定厂商(AC-H2-2/3):resolveModel 优先级 = --model > 会话末条 model_change > 默认 ----
  const rebuilt = session.rebuild();
  let alias: string;
  let provider: ProviderConfig;
  try {
    alias = resolveModel({
      cliModel: args.model,
      rebuiltModel: rebuilt.model,
      defaultAlias: DEFAULT_ALIAS,
    }); // S-d
    provider = resolveProvider(alias); // S-a;坏 alias 抛
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
    return;
  }
  if (!ensureKey(provider)) process.exit(1);
  // 启动即定厂商:仅当 --model 覆盖了续会话的历史 model 才落 model_change(默认/纯恢复 = 噪音,不写)。
  if (args.model && args.model !== rebuilt.model) {
    session.append({ type: "model_change", payload: { model: alias } });
  }
  let streamFn = createStream(provider);

  // H3 S-c 生产 summarizeFn:buildSummarizePrompt(七段规格) + serializeConversation(对话正文)
  // 喂当前 streamFn = 同厂商同模型(/model 热切后变量已换,闭包取最新)。裁决零在 harness。
  const summarizeFn = async (old: AgentMessage[], previousSummary?: string): Promise<string> => {
    const prompt = `${buildSummarizePrompt(previousSummary)}\n${serializeConversation(old)}`;
    let text = "";
    for await (const ev of streamFn({ messages: [{ role: "user", content: prompt }], tools: [] })) {
      if (ev.type === "text_delta") text += ev.delta;
      else if (ev.type === "error") throw new Error(ev.errorMessage ?? "summarize 流错误");
    }
    return text;
  };

  const projectContext = findProjectContext({ cwd }); // 启动读一次;缺失 = prompt 该段省略

  const context: LoopContext = {
    messages: rebuilt.messages, // M2 rebuild 缝:接回所选会话历史
    tools: providerTools,
  };

  // H3:/compact 手动 = force 跳阈值;自动 = 缺省阈值门(compact 内判,不过 → null 零副作用)。
  // 压缩产物经 rebuild 热替换 context.messages(AC-H3-2"后续消息用压缩后 messages")。
  const runCompact = async (manual: boolean): Promise<void> => {
    try {
      const entry = await session.compact({
        contextWindow: provider.models[0]!.contextWindow,
        summarizeFn,
        force: manual,
      });
      if (!entry) {
        if (manual) process.stdout.write("当前会话无可压缩内容(新会话先聊一轮)。\n");
        return;
      }
      context.messages = session.rebuild().messages;
      process.stdout.write(
        `已${manual ? "手动" : "自动"}压缩 → 上下文 ${context.messages.length} 条(纪要已落盘)。\n`,
      );
    } catch (e) {
      process.stdout.write(`[error] compact: ${(e as Error).message}\n`);
    }
  };

  process.stdout.write(
    `mini · ${alias} (${provider.models[0]!.id}) · ${cwd}\n` +
      `  历史 ${context.messages.length} 条 · /model <alias> 热切 · /compact 手动压缩 · Ctrl+C 中断当前轮 / 空转时退出\n` +
      (projectContext ? `  项目上下文:${projectContext.path}\n` : ""),
  );

  for (;;) {
    const line = (await ask("> ")).trim();
    if (line === "") continue;

    // 会话内热切(AC-H2-3):/model <alias> → 校验+换 provider+落 model_change entry。
    // 只换下一条消息起生效;坏 alias / 缺密钥 → 保持原厂商、不污染 jsonl。
    if (line === "/model" || line.startsWith("/model ")) {
      const next = line.slice("/model".length).trim();
      if (next === "") {
        process.stdout.write("用法:/model <alias>\n");
        continue;
      }
      try {
        const np = resolveProvider(next); // S-a:未知 alias 抛(消息含可选厂商)
        if (!ensureKey(np)) continue; // 缺密钥不切,保留原厂商
        alias = next;
        provider = np;
        streamFn = createStream(provider);
        session.append({ type: "model_change", payload: { model: alias } });
        process.stdout.write(`已切换 → ${alias} (${provider.models[0]!.id})\n`);
      } catch (e) {
        process.stdout.write(`${(e as Error).message}\n`);
      }
      continue;
    }

    // H3 AC-H3-2:/compact = 手动压缩(force 跳阈值;切点/配对/拒压照旧在 memory)。
    if (line === "/compact") {
      await runCompact(true);
      continue;
    }

    const user: UserMessage = { role: "user", content: line };
    context.messages.push(user);
    session.append({ type: "message", payload: user });

    // AC-H3-5:每轮从当前工具集重算 system prompt(纯函数零缓存 = 工具集变即重建)。
    context.systemPrompt = buildSystemPrompt({
      tools: providerTools,
      ...(projectContext ? { projectContext } : {}),
    });

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
    // H3 自动压缩接线(本会话裁决):每轮结束后过阈值门;不过 = null 零副作用,与手动共用 summarizeFn。
    await runCompact(false);
  }
}

await main();
