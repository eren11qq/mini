// H1+H2+H3+P2 harness:组装 + ChatIO 聊天框(TTY=TUI 变体 A,非 TTY=旧 readline 回落,tui.ts)。AC-H1-3 = 本文件零业务逻辑:
// 停止判定、schema 校验、确认门规则、压缩全在 loop/stream/tools/memory 层;H2 的厂商
// 选择/热切/会话挑选的裁决也全在纯缝里(parseArgs / resolveProvider / resolveModel /
// SessionManager.list —— 均可测)。这里只做「读 flag → 选会话 → 拼参数 → 转事件 → 落盘」
// 的搬运,零加工(卡 4:provider 工具形态映射已随 LoopContext.tools 敲实归方言)。
import { homedir } from "node:os";
import { join } from "node:path";

import { runLoop } from "../loop/run-loop.ts";
import type { LoopContext, UserMessage } from "../loop/types.ts";
import { makeSummarizeFn } from "../memory/compaction.ts";
import { SessionManager } from "../memory/session-manager.ts";
import { createStream } from "../stream/core.ts";
import type { ProviderConfig } from "../stream/protocol.ts";
import { bashTool } from "../tools/bash.ts";
import { editTool } from "../tools/edit.ts";
import { readTool } from "../tools/read.ts";
import { writeTool } from "../tools/write.ts";
import type { Tool } from "../tools/tool.ts";
import { localDate } from "../util/time.ts";
import { parseArgs } from "./args.ts";
import { findProjectContext } from "./project-context.ts";
import { resolveProvider } from "./providers.ts";
import { resolveModel } from "./resolve-model.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { matchCommand, type SlashCommand } from "./commands.ts";
import { createPlainIO, createTui, type ChatIO } from "./tui.ts";

// 出厂厂商(无 --model、无历史 model_change 时)。--model <alias> 与 model_change payload
// 存的都是这个表的 key(alias);dialect 由 createStream 内部派发(S3,上层零改动切方言)。
const DEFAULT_ALIAS = "deepseek";

const TOOLS: Tool[] = [readTool, writeTool, editTool, bashTool];

// 密钥只从 env 读(PRD 约束)。缺 → 友好报错返回 false(启动缺 = 退出;热切缺 = 不切)。
function ensureKey(io: ChatIO, provider: ProviderConfig): boolean {
  if (process.env[provider.key_env]) return true;
  io.warn(`${provider.key_env} 未设置(密钥只从 env 读)。`);
  return false;
}

// --resume 编号选择器(S-c list → 打表 → 读号 → 命中项)。选号非法 = 明确拒绝,不静默新开。
async function pickSession(io: ChatIO, baseDir: string, cwd: string): Promise<SessionManager> {
  const sessions = SessionManager.list({ baseDir, cwd });
  if (sessions.length === 0) {
    io.note("无可恢复会话,新开一个。");
    return new SessionManager({ baseDir, cwd });
  }
  io.note("恢复哪个会话?");
  sessions.forEach((s, i) =>
    io.note(
      `  ${i + 1}) ${new Date(s.mtimeMs).toISOString().slice(0, 19)} · ${s.model ?? DEFAULT_ALIAS} · ${s.sessionId.slice(0, 8)}`,
    ),
  );
  const n = Number((await io.ask("编号: ")).trim());
  const pick = sessions[n - 1];
  if (!pick) {
    io.warn(`无效编号:${n}(1..${sessions.length})。`);
    io.stop();
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

  // C9 命令注册表:TUI 补全与主循环分发共读这张表;handler 闭包晚绑定(runCompact 等在其后定义),
  // 故先建空数组、到齐再 push —— 加命令 = 只登记,分发段零改动。
  const COMMANDS: SlashCommand[] = [];

  // P2 聊天框缝:TTY = 全屏 TUI(变体 A);非 TTY/管道 = 旧 H1 readline 通道,行为零变。
  const io: ChatIO =
    process.stdout.isTTY && process.stdin.isTTY
      ? createTui({ cwd, commands: COMMANDS })
      : createPlainIO();
  io.start();

  // Story 16:Ctrl+C = 中断在跑的那一轮(stream + 工具),空转时 = 退出。
  // 中断语义全在 loop(AC-L3-4/6),这里只按开关。
  let controller: AbortController | null = null;
  io.onInterrupt(() => {
    if (controller) controller.abort();
    else {
      io.stop();
      process.exit(0);
    }
  });

  // ---- 选会话(AC-H2-4/5):--resume 编号选择器 > --continue 最近 > 新会话 ----
  let session: SessionManager;
  if (args.resume) session = await pickSession(io, baseDir, cwd);
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
    io.warn(`${(e as Error).message}`);
    io.stop();
    process.exit(1);
    return;
  }
  if (!ensureKey(io, provider)) {
    io.stop();
    process.exit(1);
  }
  // 启动即定厂商:仅当 --model 覆盖了续会话的历史 model 才落 model_change(默认/纯恢复 = 噪音,不写)。
  if (args.model && args.model !== rebuilt.model) {
    session.append({ type: "model_change", payload: { model: alias } });
  }
  let streamFn = createStream(provider);
  // TUI 顶栏第二行 = 真模型 id;历史条目 = 所选会话 rebuild(plain 模式两者皆 no-op)。
  io.setModel(provider.models[0]!.id);
  io.loadHistory(rebuilt.messages);

  // H3 生产 summarizeFn = memory 缝(卡 3 / ADR-004):七段配方拼接、对话正文序列化、流排空、
  // error 上抛全在 memory/compaction.ts。这里只做箭头转发 = /model 热切换掉 streamFn 后自动取最新。
  const summarizeFn = makeSummarizeFn((context, signal) => streamFn(context, signal));

  const projectContext = findProjectContext({ cwd }); // 启动读一次;缺失 = prompt 该段省略

  const context: LoopContext = {
    messages: rebuilt.messages, // M2 rebuild 缝:接回所选会话历史
    tools: TOOLS,
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
        if (manual) io.note("当前会话无可压缩内容(新会话先聊一轮)。");
        return;
      }
      context.messages = session.rebuild().messages;
      io.note(
        `已${manual ? "手动" : "自动"}压缩 → 上下文 ${context.messages.length} 条(纪要已落盘)。`,
      );
    } catch (e) {
      io.warn(`[error] compact: ${(e as Error).message}`);
    }
  };

  // 会话内热切(AC-H2-3):/model <alias> → 校验+换 provider+落 model_change entry。
  // 只换下一条消息起生效;坏 alias / 缺密钥 → 保持原厂商、不污染 jsonl。
  const switchModel = (next: string): void => {
    if (next === "") {
      io.note("用法:/model <alias>");
      return;
    }
    try {
      const np = resolveProvider(next); // S-a:未知 alias 抛(消息含可选厂商)
      if (!ensureKey(io, np)) return; // 缺密钥不切,保留原厂商
      alias = next;
      provider = np;
      streamFn = createStream(provider);
      session.append({ type: "model_change", payload: { model: alias } });
      io.setModel(provider.models[0]!.id); // 顶栏第二行跟着热切走。
      io.note(`已切换 → ${alias} (${provider.models[0]!.id})`);
    } catch (e) {
      io.warn(`${(e as Error).message}`);
    }
  };

  // C9 登记(晚绑定补齐):分发段只查表,不认具体命令。
  COMMANDS.push(
    { name: "compact", description: "手动压缩上下文", run: () => runCompact(true) },
    { name: "model", description: "切换厂商模型", usage: "<alias>", run: switchModel },
  );

  if (io.mode === "plain") io.note(`mini · ${alias} (${provider.models[0]!.id}) · ${cwd}`);
  if (projectContext) io.note(`项目上下文:${projectContext.path}`);

  for (;;) {
    const line = (await io.ask()).trim();
    if (line === "") continue;

    // C9:斜杠分发 = 查注册表(语义见 commands.ts;首 token 命中,余下 trim 作 args)。
    // 未命中(含一切非 "/" 行)照旧走用户消息回喂流,H3 AC-H3-2 手动压缩即此表的 /compact 行。
    const hit = matchCommand(COMMANDS, line);
    if (hit) {
      await hit.command.run(hit.args);
      continue;
    }

    const user: UserMessage = { role: "user", content: line };
    context.messages.push(user);
    session.append({ type: "message", payload: user });

    // AC-H3-5:每轮从当前工具集重算 system prompt(纯函数零缓存 = 工具集变即重建)。
    // env 每轮现取(日期跨天热更新);仍走 opts,纯函数零状态不破。
    context.systemPrompt = buildSystemPrompt({
      tools: TOOLS,
      env: {
        platform: process.platform,
        date: localDate(), // 本地日期:toISOString 是 UTC,东八区晚 8 点后跨天错一天
        cwd,
      },
      ...(projectContext ? { projectContext } : {}),
    });

    controller = new AbortController();
    try {
      for await (const event of runLoop(streamFn, TOOLS, context, {
        signal: controller.signal, // SIGINT → loop 停该轮(工具侧 bash 杀进程组)
        rulesPath: join(cwd, "rules.json"), // T2/D4:生产规则落 <cwd>/rules.json
        confirm: (prompt) => io.confirm(prompt), // 答案映射在 tui.ts(与旧逐字等价)
      })) {
        io.render(event);
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
