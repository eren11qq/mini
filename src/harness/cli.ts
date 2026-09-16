// H1+H2+H3+P2 harness:组装 + ChatIO 聊天框(TTY=TUI 变体 A,非 TTY=旧 readline 回落,tui.ts)。AC-H1-3 = 本文件零业务逻辑:
// 停止判定、schema 校验、确认门规则、压缩全在 loop/stream/tools/memory 层;H2 的厂商
// 选择/热切/会话挑选的裁决也全在纯缝里(parseArgs / resolveProvider / resolveModel /
// SessionManager.list —— 均可测)。这里只做「读 flag → 选会话 → 拼参数 → 转事件 → 落盘」
// 的搬运,零加工(卡 4:provider 工具形态映射已随 LoopContext.tools 敲实归方言)。
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { runLoop } from "../loop/run-loop.ts";
import type { Rule } from "../loop/rules.ts";
import type { LoopContext, UserMessage } from "../loop/types.ts";
import { makeSummarizeFn } from "../memory/compaction.ts";
import { eventToEntries, turnsSinceLastUser } from "../memory/journal.ts";
import { SessionManager } from "../memory/session-manager.ts";
import { createStream } from "../stream/core.ts";
import type { ProviderConfig, StreamFn } from "../stream/protocol.ts";
import { bashTool } from "../tools/bash.ts";
import { editTool } from "../tools/edit.ts";
import { readTool } from "../tools/read.ts";
import { makeSkillTool } from "../tools/skill.ts";
import { makeTaskTool } from "../tools/task.ts";
import { writeTool } from "../tools/write.ts";
import type { Tool } from "../tools/tool.ts";
import { localDate } from "../util/time.ts";
import { parseArgs } from "./args.ts";
import { loadConfig, saveModel } from "./config.ts";
import { loadKeys, resolveKey, saveKey } from "./keys.ts";
import { findProjectContext } from "./project-context.ts";
import { buildSkillCommands, scanSkills } from "./skills.ts";
import { PROVIDERS, resolveProvider } from "./providers.ts";
import { resolveModel } from "./resolve-model.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { matchCommand, splitModelArg, type SlashCommand } from "./commands.ts";
import { createPlainIO, createTui, type ChatIO } from "./tui.ts";
import { traceLine } from "./trace.ts";

// C24:出厂默认厂商已废。--model <alias> 与 model_change payload 存的都是 providers 表的
// key(alias);上次的选择持久到 ~/.mini/config.json(resolveModel 第三优先级),三源皆无 =
// 无模型可跑,REPL 照常起、warn 引导 /connect(发送门拦轮,缺 key 同款软路先例 C15)。
const CONFIG_PATH = join(homedir(), ".mini", "config.json");

// D1 刀3:maxTurns 续计基数。口径 = run-loop.ts `options.maxTurns ?? 50` 的缺省 50 ——
// loop 零改动(卡片裁决),故两处同值:改 run-loop 缺省必须同步这里。
const MAX_TURNS = 50;

const TOOLS: Tool[] = [readTool, writeTool, editTool, bashTool];

// C15 密钥来源 = env > 0600 落盘 store(~/.mini/keys.json;C18 后写盘入口唯一 = `/connect`)。
// 合流后回填 process.env[key_env](只补缺不覆盖 env 原值)= stream 适配器逐请求读 env,下游零改动。
// 缺不再硬退:返回 false + warn 进帧。启动缺 = REPL 照常(发送门拦轮),热切缺 = 不切。
const KEYS_PATH = join(homedir(), ".mini", "keys.json");
async function ensureKey(io: ChatIO, alias: string, provider: ProviderConfig): Promise<boolean> {
  const k = resolveKey({
    alias,
    keyEnv: provider.key_env,
    env: process.env,
    store: await loadKeys(KEYS_PATH),
  });
  if (k !== undefined) {
    process.env[provider.key_env] ??= k;
    return true;
  }
  io.warn(`未配置 ${alias} 的 API key:/connect 配置,或 export ${provider.key_env}。`);
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
      `  ${i + 1}) ${new Date(s.mtimeMs).toISOString().slice(0, 19)} · ${s.model ?? "未配置"} · ${s.sessionId.slice(0, 8)}`,
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
  // C6 AC-1:session 档规则容器 —— 进程作用域,跨每轮的多次 runLoop 存活(= "本 run 有效"),
  // 永不落盘;进程退出即失效(新 run 复弹)。撤销语义仍只有一条路:手删 rules.json(C2 不变式)。
  const sessionRules: Rule[] = [];
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

  // ---- 定厂商(AC-H2-2/3,C24 改):resolveModel 优先级 = --model > 会话末条 model_change >
  // 全局 config(~/.mini/config.json)—— 出厂默认已废,三源皆无 = 无模型 ----
  const rebuilt = session.rebuild();
  // D1 刀3:崩溃前那轮已烧的 turn(--continue 接回的历史里末条 user 之后的 assistant 数),
  // 本进程每轮 runLoop 以 50 − 已烧 为预算续计(故事 5;runCompact 的热替换不改此偏移 =
  // 偏移锚在启动 rebuild,压缩只折叠更早窗口)。
  const turnBudget = Math.max(0, MAX_TURNS - turnsSinceLastUser(rebuilt.messages));
  let alias: string | undefined;
  let provider: ProviderConfig | null = null;
  let streamFn: StreamFn | null = null;
  try {
    const picked = resolveModel({
      cliModel: args.model,
      rebuiltModel: rebuilt.model,
      configModel: (await loadConfig(CONFIG_PATH)).model,
    }); // S-d:C24 起可 undefined(零默认厂商)
    if (picked === undefined) {
      io.warn("未配置模型:/connect 配置,或 --model <alias> 启动。");
    } else {
      alias = picked;
      provider = resolveProvider(picked); // S-a;坏 alias 抛
      streamFn = createStream(provider);
    }
  } catch (e) {
    io.warn(`${(e as Error).message}`);
    io.stop();
    process.exit(1);
    return;
  }
  // C15:启动缺 key 不再 stop+exit(TUI 帧未画即退 = 零反应秒退的根);warn 已入帧可见,REPL 照常,发送门拦轮。
  if (alias !== undefined && provider !== null) await ensureKey(io, alias, provider);
  // 启动即定厂商:仅当 --model 覆盖了续会话的历史 model 才落 model_change(默认/纯恢复 = 噪音,不写)。
  if (args.model && args.model !== rebuilt.model) {
    session.append({ type: "model_change", payload: { model: args.model } });
  }
  // C24:显式 --model(过了 resolveProvider 校验,坏值已在上面硬退)= 全局意图,持久。
  if (args.model) await saveModel(CONFIG_PATH, args.model);
  // TUI 顶栏第二行 = 真模型 id;历史条目 = 所选会话 rebuild(plain 模式两者皆 no-op)。
  io.setModel(provider ? provider.models[0]!.id : "未配置");
  io.loadHistory(rebuilt.messages);

  // 热切转发箭头(C24 起 streamFn 可空 = 未配模型末位防线;REPL 发送门已先拦)。
  // H3 生产 summarizeFn = memory 缝(卡 3 / ADR-004):七段配方拼接、对话正文序列化、流排空、
  // error 上抛全在 memory/compaction.ts。这里只做箭头转发 = /model 热切换掉 streamFn 后自动取最新。
  const callStream: StreamFn = (context, signal) => {
    if (streamFn === null) throw new Error("未配置模型,无法发起请求(/connect)。");
    return streamFn(context, signal);
  };
  const summarizeFn = makeSummarizeFn(callStream);

  const projectContext = findProjectContext({ cwd }); // 启动读一次;缺失 = prompt 该段省略
  // C22 段1:技能扫描 = 启动一次(项目 > 用户,重名前 dir 赢;缺目录 = 空)。
  const skills = scanSkills({
    dirs: [join(cwd, ".mini", "skills"), join(homedir(), ".mini", "skills")],
  });

  // D4(docs/ISSUES.md)task 子代理注册:streamFn 箭头晚绑定(/model 热切自动跟新厂商,
  // 先例 = summarizeFn);child 事件已带 agentId,直挂 trace append(故事 23,同文件)。
  // tracePath 每轮在 D2 处更新 —— 闭包读可变引用,零轮次耦合。
  let currentTracePath: string | null = null;
  const tools: Tool[] = [
    ...TOOLS,
    // C22 段3:零 skill = 不注册(prompt 也不出表)→ 无技能目录的今日行为逐字节不变。
    ...(skills.length > 0 ? [makeSkillTool({ skills })] : []),
    makeTaskTool({
      streamFn: callStream,
      onEvent: (ev) => {
        if (currentTracePath !== null) {
          appendFileSync(currentTracePath, traceLine(ev, Date.now) + "\n");
        }
      },
    }),
  ];

  const context: LoopContext = {
    messages: rebuilt.messages, // M2 rebuild 缝:接回所选会话历史
    tools,
  };

  // H3:/compact 手动 = force 跳阈值;自动 = 缺省阈值门(compact 内判,不过 → null 零副作用)。
  // 压缩产物经 rebuild 热替换 context.messages(AC-H3-2"后续消息用压缩后 messages")。
  const runCompact = async (manual: boolean): Promise<void> => {
    if (provider === null) {
      // C24:无模型 = 无 contextWindow 可算,自动路恒不过(no-model 时发送门已拦轮,进不来这)。
      if (manual) io.warn("未配置模型(/connect),无可压缩。");
      return;
    }
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
  // C18:key 入口唯一 = /connect。inline-key 旧形态(C15)收掉 —— 第二 token 一律判多余,
  // 不落盘不回显;切换只走 env/已存 key 的既有校验路。
  const switchModel = async (rest: string): Promise<void> => {
    const { alias: name, extra } = splitModelArg(rest);
    if (name === "") {
      io.note("用法:/model <alias>");
      return;
    }
    if (extra) {
      io.warn("多余参数:/model 只收 <alias>,key 配置请用 /connect");
      return;
    }
    let np: ProviderConfig;
    try {
      np = resolveProvider(name); // S-a:未知 alias 抛(消息含可选厂商)
    } catch (e) {
      io.warn(`${(e as Error).message}`);
      return;
    }
    if (!(await ensureKey(io, name, np))) return; // 缺密钥不切,保留原厂商
    alias = name;
    provider = np;
    streamFn = createStream(provider);
    session.append({ type: "model_change", payload: { model: alias } });
    await saveModel(CONFIG_PATH, name); // C24:切换成功即持久全局 —— 下次启动不再掉回别家
    io.setModel(provider.models[0]!.id); // 顶栏第二行跟着热切走。
    io.note(`已切换 → ${alias} (${provider.models[0]!.id})`);
  };

  // C9 登记(晚绑定补齐):分发段只查表,不认具体命令。
  COMMANDS.push(
    { name: "compact", description: "手动压缩上下文", run: () => runCompact(true) },
    { name: "model", description: "切换厂商模型", usage: "<alias>", run: switchModel },
    // C17 /connect:向导数据在此组装(表驱动,渲染层零业务),effect 消费 = saveKey → switchModel
    // 同款校验 + 热切(resolveKey 现读盘 = 落盘即生效,单进程无 kilo 的 dispose/bootstrap)。
    {
      name: "connect",
      description: "配置厂商 API key",
      run: async () => {
        const store = await loadKeys(KEYS_PATH);
        const vendors = Object.entries(PROVIDERS).map(([a, p]) => ({
          alias: a,
          modelId: p.models[0]!.id,
          configured:
            resolveKey({ alias: a, keyEnv: p.key_env, env: process.env, store }) !== undefined,
          hint: `${p.base_url} · key 在厂商控制台获取`,
        }));
        const got = await io.connectPrompt(vendors);
        if (!got) return; // Esc/未知/空 = 零落盘(Esc 任意步取消语义)
        await saveKey(KEYS_PATH, got.alias, got.key);
        await switchModel(got.alias);
      },
    },
  );

  if (io.mode === "plain")
    io.note(
      `mini · ${alias ?? "未配置模型(/connect)"} (${provider?.models[0]!.id ?? "-"}) · ${cwd}`,
    );
  if (projectContext) io.note(`项目上下文:${projectContext.path}`);
  // C7:flag 开启显式来源 —— 直通免弹必须让用户知道为什么没弹。
  if (args.autoAcceptEdits)
    io.note("auto-accept-edits on —— cwd 内 write/edit 直通免弹(bash/黑名单照常弹)");

  // C24:单轮用户消息处理 = 原 for(;;) 循环体搬入(REPL 与技能注入路共用,调用序 diff-0)。
  const runTurn = async (line: string): Promise<void> => {
    // C24 无模型门:三源皆空启动 → warn 拦下(缺 key 同款软路)。
    if (alias === undefined || provider === null || streamFn === null) {
      io.warn("未配置模型:/connect 配置,或 --model <alias> 启动。");
      return;
    }
    const fn = streamFn; // 快照收窄(热切只发生在命令处理里,本轮内稳定)
    // C15 发送门:当前厂商无 key(env+盘全缺)→ warn 拦下,不空 key 打 API。
    if (!(await ensureKey(io, alias, provider))) return;

    const user: UserMessage = { role: "user", content: line };
    context.messages.push(user);
    session.append({ type: "message", payload: user });
    // D2:会话文件已由上一行 append 首建 → 旁挂路径本轮定死(--no-trace = null,零落盘)。
    // D4:同值喂 task child 事件旁挂(onEvent 读此可变引用)。
    const tracePath = args.trace ? session.traceFile() : null;
    currentTracePath = tracePath;

    // AC-H3-5:每轮从当前工具集重算 system prompt(纯函数零缓存 = 工具集变即重建)。
    // env 每轮现取(日期跨天热更新);仍走 opts,纯函数零状态不破。
    context.systemPrompt = buildSystemPrompt({
      tools,
      skills, // C22 段2:空数组 = 渲染层自省略(S5 diff-0 锚),无需条件展开
      env: {
        platform: process.platform,
        date: localDate(), // 本地日期:toISOString 是 UTC,东八区晚 8 点后跨天错一天
        cwd,
      },
      ...(projectContext ? { projectContext } : {}),
    });

    controller = new AbortController();
    try {
      for await (const event of runLoop(fn, tools, context, {
        signal: controller.signal, // SIGINT → loop 停该轮(工具侧 bash 杀进程组)
        maxTurns: turnBudget, // D1:保险丝续计(全新会话 = 50 = 现行缺省,行为零变化)
        rulesPath: join(cwd, "rules.json"), // T2/D4:生产规则落 <cwd>/rules.json
        confirm: (prompt) => io.confirm(prompt), // 四档答案映射在 tui.ts(mapConfirm)
        autoAcceptEdits: args.autoAcceptEdits, // C7:cli flag → loop 直通判据(默认 false = 零变化)
        sessionRules, // C6:答 2 = 规则进此数组(内存,本 run 免弹,不落盘)
      })) {
        io.render(event);
        // D2:trace 逐事件旁挂落盘(缺省开,--no-trace 关)。先写 trace 再进 journal:
        // trace = 观测面,appendFileSync 即写即刷,下游抛错不吞事件行(故事 7「有据可查」)。
        if (tracePath !== null) {
          appendFileSync(tracePath, traceLine(event, Date.now) + "\n");
        }
        // D1:查 journal 分发表落盘(从前此处硬编码只认 message_end → toolResult 从不进
        // JSONL,--continue 悬空 toolCall 必 400)。append = 事件到达序,assistant 的
        // message_end 天然先于同批 tool_results,顺序语义与 M1 即时落盘一致。
        for (const entry of eventToEntries(event)) {
          session.append(entry);
        }
      }
    } finally {
      controller = null;
    }
    // H3 自动压缩接线(本会话裁决):每轮结束后过阈值门;不过 = null 零副作用,与手动共用 summarizeFn。
    await runCompact(false);
  };

  // C24(用户裁决:装了 skill 的 / 菜单只有 3 条命令):每个扫到的 skill 追加注册为斜杠
  // 命令 —— 选中即「正文+参数」经 runTurn 走标准发送路(落会话/trace/渲染全复用)。重名
  // 裁决 = 已注册命令赢(缝3 纯函数内剔)。晚绑定先例照旧;登记在核心三条之后 = 弹层展示序。
  // 发送门/落盘/渲染全走标准路;await 到本轮结束才回提示符(分发处 await run 透传)。
  COMMANDS.push(
    ...buildSkillCommands(skills, new Set(COMMANDS.map((c) => c.name)), async (t) => {
      await runTurn(t);
    }),
  );

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
    await runTurn(line);
  }
}

await main();
