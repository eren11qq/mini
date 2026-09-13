# Pi (earendil-works/pi) Agent 架构源码调研

- 仓库:`https://github.com/earendil-works/pi.git`(GitHub API 确认 `full_name=earendil-works/pi`,default branch `main`,描述 "AI agent toolkit: unified LLM API, agent loop, TUI, coding agent CLI")
- 克隆 commit:**`71dca871bc80b6bc97be37f0ca3189399d651fff`**(shallow clone)
- 方法:只读源码。所有引用为 `文件路径:行号 (commit 71dca87)`,路径相对仓库根。下文若无特别说明,commit 均为此 SHA。

---

## 1. 概览

### 1.1 Monorepo 包结构

npm workspaces 根:`package.json:7-14 (commit 71dca87)`。`packages/` 下:

| 包                                                                     | 作用                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ai`(`@earendil-works/pi-ai`)                                 | 统一 LLM API:provider 适配(anthropic-messages / openai-completions / openai-responses / google / bedrock / mistral 等,`src/types.ts:17-27`)、模型目录、auth 解析、token/cost 统计、流式事件协议 |
| `packages/agent`(`@earendil-works/pi-agent-core`)                      | 无状态 `agent-loop.ts` 核心循环 + 有状态 `Agent` 类;另含**新一代 durable harness**(`src/harness/**`,主 CLI 尚未使用,见 §4.6)                                                                    |
| `packages/coding-agent`(`@earendil-works/pi-coding-agent`,bin 名 `pi`) | 编码 CLI harness:`AgentSession`、内置工具、JSONL 会话树、compaction、extensions/skills/prompt-templates/themes、四种运行模式                                                                    |
| `packages/tui`(`@earendil-works/pi-tui`)                               | 差分渲染终端 UI 框架(CSI 2026 同步输出、Component 模型)                                                                                                                                         |
| `packages/protocol` / `client` / `server`                              | 实验性远程服务协议(CBOR 信封、durable Session),README 自述 "Experimental"                                                                                                                       |
| `packages/chord`                                                       | 独立插件组合运行时(facets/services),README 明确"不是 Pi 包",供 experimental 插件系统用                                                                                                          |
| `packages/session-backends/sqlite-node`                                | 新 harness 的 SQLite 会话后端(与 core 解耦)                                                                                                                                                     |
| `packages/telemetry` / `evals`                                         | 遥测契约(纯 callback、无 exporter)/ 行为评测                                                                                                                                                    |

依赖方向:`coding-agent → agent → ai`;`interactive 模式 → tui`。

### 1.2 数据流(一次 prompt 的完整路径)

```
用户输入(TUI/print/RPC)
 → AgentSession.prompt()                      coding-agent/src/core/agent-session.ts:1175
   ├ extension "input" hook 拦截/改写          agent-session.ts:1199
   ├ /skill: 与 prompt template 展开           agent-session.ts:1211-1216
   ├ 构造 user AgentMessage                    agent-session.ts:1269-1277
   └ before_agent_start hook(可改 systemPrompt/注入 custom 消息) agent-session.ts:1286-1314
 → Agent.prompt() → runAgentLoop()             agent/src/agent.ts:350 / agent-loop.ts:96
   → transformContext(extension "context" 事件)→ convertToLlm(AgentMessage[]→Message[])  agent-loop.ts:286-293
   → StreamFn = modelRuntime.streamSimple → provider 适配器   sdk.ts:314-341
   ← AssistantMessageEventStream(start/text_delta/toolcall_delta/done|error)  ai/src/types.ts:546-562
   → 循环消费:partial 消息写入 context.messages 并 emit message_update(驱动 UI 流式渲染) agent-loop.ts:315-358
   → stopReason=toolUse → executeToolCalls(prepare→execute→finalize)  agent-loop.ts:409
   → ToolResultMessage 回填 context → turn_end → prepareNextTurn(内含阈值 compaction 检查) agent-session.ts:557-579
 → 每个 message_end 由 AgentSession 落盘 JSONL:sessionManager.appendMessage  agent-session.ts:669-686
```

---

## 2. 核心 Agent Loop(`packages/agent`)

### 2.1 分层与入口

- **无状态循环**:`runAgentLoop(prompts, context, config, emit, signal, streamFn)`(`agent-loop.ts:96`)与 `runAgentLoopContinue(...)`(`agent-loop.ts:121`,用于 retry,要求最后一条消息可转为 user/toolResult,`agent-loop.ts:128-134`)。对外协程封装 `agentLoop()`/`agentLoopContinue()` 返回 `EventStream<AgentEvent, AgentMessage[]>`(`agent-loop.ts:32-94`)。
- **有状态包装**:`class Agent`(`agent.ts:173`)持有 `AgentState`(messages/tools/systemPrompt/model/thinkingLevel,`types.ts:334-359`,tools/messages 用 accessor 赋值即拷贝),`prompt()`(`agent.ts:350`)、`continue()`(`agent.ts:361`)、`abort()`(`agent.ts:319`)、`waitForIdle()`(`agent.ts:328`)。每轮运行以 `createContextSnapshot()` 拷贝 state 传入循环(`agent.ts:437-443`)。

### 2.2 精确循环结构(状态机)

`runLoop`(`agent-loop.ts:156-273`)是 **双层 while**:

- 外层 `while(true)`(`agent-loop.ts:171`):"agent 本该停止时,检查 follow-up 队列,有则续命"。
- 内层 `while (hasMoreToolCalls || pendingMessages.length > 0)`(`agent-loop.ts:175`):一个 turn = 一次 assistant 响应 + 其全部 tool 调用。

事件序列即状态:`agent_start → turn_start → (message_start → message_update* → message_end)[user] → (message_start → message_update* → message_end)[assistant] → [tool_execution_start → tool_execution_update* → tool_execution_end → toolResult 的 message_start/end]* → turn_end → …循环… → agent_end`。事件联合定义在 `types.ts:431-446`(`AgentEvent`,12 个 type)。

### 2.3 继续 / 停止判定

没有 max-iterations 计数器,**也没有对"总步数"的硬上限**(honest finding)。实际停止条件:

1. **无 tool calls**:assistant 消息 `content.filter(c => c.type === "toolCall")` 为空 → `hasMoreToolCalls=false`,内层退出;两队列均空 → break(`agent-loop.ts:222-241, 261-269`)。
2. **error/aborted**:assistant `stopReason === "error" || "aborted"` → 立即 `turn_end` + `agent_end` 返回(`agent-loop.ts:215-219`)。StreamFn 契约规定 provider 失败必须以编码进流的 error AssistantMessage 呈现,不允许 throw(`agent/src/types.ts:22-31`)。
3. **max tokens(length)**:`stopReason === "length"` 不直接停,但视为"该消息所有 tool call 参数可能被截断",整批全部失败为 error tool result,让模型重发(`agent-loop.ts:230-233` + `failToolCallsFromTruncatedMessage` `agent-loop.ts:379-404`)。
4. **外部 abort**:`AbortSignal` 贯穿 prepare/execute,每个检查点短路(`agent-loop.ts:476-478, 514, 542, 636-661`)。
5. **钩子**:`shouldStopAfterTurn`(`types.ts:223`,turn_end 后询问,真则 `agent_end` 提前退出 `agent-loop.ts:252-255`);tool 批的 **early termination**:当批内每个结果都 `terminate===true` 时 `hasMoreToolCalls=false`(`shouldTerminateToolBatch` `agent-loop.ts:589-591`)。
6. **续跑钩子**:`prepareNextTurn`(`agent-loop.ts:176-190`)可在每 turn 前整体替换 context/model/thinkingLevel(coding-agent 用它做阈值 compaction 与 systemPrompt 刷新,`agent-session.ts:557-579`)。
7. **消息队列注入**:内层每 turn 前 poll `getSteeringMessages`(`agent-loop.ts:194-209, 257`),外层停止点 poll `getFollowUpMessages`(`agent-loop.ts:261-265`);`PendingMessageQueue` 支持 "all"/"one-at-a-time" 排水模式(`agent.ts:125-159`)。

### 2.4 流式事件如何上浮

- Provider 层:`AssistantMessageEvent`(`ai/src/types.ts:546-562`)= `start | text_{start,delta,end} | thinking_{…} | toolcall_{…} | done | error`,每个 delta 携带 `partial: AssistantMessage`(共享的"当前应答快照",非不可变快照,注释见 `types.ts:530-545`)。传输是 `EventStream`(async iterable,`ai/src/utils/event-stream.ts:26`)。
- Agent 层:循环把 provider 事件转译为 `message_update{assistantMessageEvent}`(`agent-loop.ts:333-341`),partial 消息直接占位在 `context.messages` 末位并随 delta 替换(`agent-loop.ts:318-335`)。
- 订阅机制:`Agent.subscribe(listener)` 返回 unsubscribe(`agent.ts:250-253`);listener **按订阅顺序 await** 且计入 run 结算(`agent_end` 后 state 才 idle,`agent.ts:544-590` processEvents 先 reduce 内部 state 再逐个 await listener)。

### 2.5 Agent 状态建模

`AgentState`(`types.ts:334-359`):`systemPrompt / model / thinkingLevel / tools / messages` 可写(accessor 浅拷贝),只读 `isStreaming / streamingMessage / pendingToolCalls / errorMessage`。state 的 mutation 全部由 `processEvents` 从事件流 reduce(`agent.ts:544-582`):`message_end` push 进 messages、`tool_execution_{start,end}` 维护 pendingToolCalls 集合。运行时单次 `activeRun = {promise, resolve, abortController}`(`agent.ts:486-509`),失败时合成一条 stopReason=error/aborted 的 assistant 消息走完事件序列(`handleRunFailure` `agent.ts:511-527`)。

---

## 3. Harness:`packages/coding-agent`(CLI `pi`)

### 3.1 启动与模式

入口 bin `pi → dist/bundle/cli.js`(package.json `bin` 字段);源码入口 `src/main.ts:562 main()`。模式判定 `resolveAppMode`(`main.ts:111-122`):`--rpc` / `--mode json` / `--print` 或非双向 TTY → print;否则 interactive。四模式导出见 `src/modes/index.ts:6-9`(interactive、print(text)、json、rpc);README 另提及 SDK 嵌入(`core/sdk.ts`)。

CLI flags 在 `src/cli/args.ts` 手工解析(无第三方库),帮助文本 `args.ts:297-317`:`--tools/-t`(allowlist)、`--exclude-tools`、`--no-tools`/`--no-builtin-tools`、`--model/--provider/--thinking`、`--models`(Ctrl+P 循环作用域)、`--session/--resume/--continue/--fork/--session-id/--no-session/--session-dir`、`-e` 扩展路径、`--approve/--no-approve`(项目信任)、`--system-prompt/--append-system-prompt`、`--export`、`@file` 参数、未知 flag 透传给扩展 `registerFlag`。

会话选择逻辑 `createSessionManager`(`main.ts:353-444`):fork → `SessionManager.forkFrom`;`--session` 路径/ID 前缀解析(异项目命中会询问是否 fork 到当前 cwd,`main.ts:394-402`);`--resume` → 交互选择器;`--continue` → `continueRecent`。随后组装 services:`createAgentSessionServices`(settingsManager + ModelRuntime + resourceLoader,`main.ts:732-776`)→ `createAgentSessionFromServices`(`main.ts:817`)→ 按模式分发(`main.ts:930-979`)。

### 3.2 System prompt 与项目上下文

`buildSystemPrompt`(`core/system-prompt.ts:28`):默认 prompt 声明 "expert coding assistant operating inside pi"(`system-prompt.ts:127`),包含三块动态内容——① `Available tools` 列表:仅列出带 `promptSnippet` 的激活工具(`system-prompt.ts:80-84`);② `Guidelines`:按激活工具动态生成(`system-prompt.ts:86-125`);③ `<project_context>` 块包裹每个上下文文件为 `<project_instructions path=...>`(`system-prompt.ts:150-158`);尾部附 skills 说明与 `Current working directory`。`--system-prompt` 整体替换默认、`--append-system-prompt` 追加(`system-prompt.ts:48-73`)。

项目上下文文件发现:`loadProjectContextFiles`(`core/resource-loader.ts:119-157`)按优先级候选 `AGENTS.override.md / AGENTS.md / AGENTS.MD / CLAUDE.md / CLAUDE.MD`(`resource-loader.ts:72`)——先 `~/.pi/agent/`(全局 agentDir,`config.ts:528-534`),再从 cwd 逐级向上到文件系统根收集祖先目录副本(近者优先,去重,`resource-loader.ts:140-154`),并有 git worktree 下主仓上下文被嵌套 worktree 遮蔽的处理(`findShadowedContextFile` `resource-loader.ts:101-117`)。

System prompt 重建时机:工具集变化时 `setActiveToolsByName` 内重算(`agent-session.ts:966-983`);每个 turn 前经 `prepareNextTurnWithContext` 把 `_baseSystemPrompt`(或本轮 override)写回 context(`agent-session.ts:563-578`)。

### 3.3 模型 / provider 选择

- `ModelRuntime`(`core/model-runtime.ts`,main.ts 使用处 `main.ts:163, 732-736`)集中管理 auth(`~/.pi/agent/auth.json`)与自定义模型(`models.json`),`sdk.ts:178-180`。provider 适配器注册在 `pi-ai`(`ai/src/types.ts:17-75` 列举 10 种 API、40+ provider id)。
- 解析顺序(`main.ts:461-523` buildSessionOptions + `sdk.ts:196-254`):CLI `--provider/--model`(支持 `provider/pattern` 与 `pattern:thinking` 简写)→ `--models` 作用域首个/已存默认 → settings 默认 → `findInitialModel`;resume 会话优先恢复历史 entry 里的 model(`sdk.ts:200-208`)。thinkingLevel 最终 `clampThinkingLevel` 到模型能力(`sdk.ts:249-254`)。
- 鉴权:每次 LLM 调用前 `_getRequiredRequestAuth`(`agent-session.ts:412-447`);`Agent` 支持 `getApiKey` 逐调用动态取 key(适配短命 OAuth token,`agent/src/types.ts:202-210`,装配于 `sdk.ts:314-341` 的 streamFn 包装)。

### 3.4 Extensions / Skills / Prompt Templates 加载

- 发现顺序(`extensions/loader.ts:761-806`):`<cwd>/.pi/extensions/`(项目本地)→ `<agentDir>/extensions/`(全局)→ `--extensions/-e` 显式路径;目录内三种布局:`*.ts` 裸文件、`*/index.ts`、带 `package.json` `"pi"` 字段声明 manifest 的子包(`loader.ts:715-720, 677-689`)。
- 加载机制:**jiti 运行时 import 用户 TypeScript**(`createJiti(...).import(extensionPath, {default:true})` `loader.ts:501-513`),编译为二进制时用 `virtualModules` 注入打包依赖(内置 `@earendil-works/pi-ai` 等,`loader.ts:17-20, 49-60`)。导出须是 factory 函数。
- API 面(`extensions/types.ts:1252-1366` `ExtensionAPI`):约 30 种事件 `on(...)`(`types.ts:1257-1301`,含 `tool_call/tool_result` 拦截、`input` 改写、`before_agent_start` 改 systemPrompt、`session_before_compact` 接管压缩等)、`registerTool`(`types.ts:1308`)、`registerCommand`(`types.ts:1317`,即 `/name` 斜杠命令,`prompt()` 里优先分发 `agent-session.ts:1183-1190`)、`registerShortcut`、`registerFlag`、`registerMessageRenderer`、`sendMessage` 等。
- Skills = 带 frontmatter 的 markdown 能力包(`/skill:name` 展开成 `<skill>` 块内联进用户消息,`agent-session.ts:1362-1386`);Prompt templates = 文件化 `/template` 展开(`core/prompt-templates.ts`)。扩展可 `reload()` 热重载(`agent-session.ts:2841-2866`)。

### 3.5 工具执行的权限 / 安全

**没有逐次 tool-call 确认**(grep 全 src 无 approve-on-tool-call 机制)——内置工具默认自动执行。安全边界是三层:

1. **项目信任**:仅针对"项目本地文件是否可加载"(extensions/settings 可执行任意代码)。`--approve/--no-approve`(`args.ts:316-317` 帮助文本"Trust project-local files for this run")、`ProjectTrustStore` 持久决定(`main.ts:700-707`)、`resolveProjectTrusted` 在 resourceLoader 解析期询问(`main.ts:740-759`)。
2. **`beforeToolCall` hook**:扩展 `tool_call` handler 返回 `{block:true, reason}` 即禁止执行,循环产出 error tool result(`agent.ts:482-502` → `agent-loop.ts:626-653`);sandbox 示例扩展在 `packages/coding-agent/examples/extensions/sandbox/`。
3. **abort**:Ctrl+C → `Agent.abort()` → signal 贯穿,`killProcessTree` 杀 bash 进程树(`tools/bash.ts:108-110`)。

### 3.6 UI 如何驱动循环

三模式共享 `AgentSession`,各自只做 I/O 层(类头注释 `agent-session.ts:1-14`):

- **interactive**(`modes/interactive/interactive-mode.ts`,~3.5k 行):`session.subscribe` 收 `AgentSessionEvent` 增量渲染 TUI(`interactive-mode.ts:3160`);输入提交 `session.prompt(text)`(`interactive-mode.ts:1113, 1123, 1135, 3128`);流式中输入走 `steer/followUp`(`agent-session.ts:1425-1442`);底层渲染用 `packages/tui` 差分渲染。
- **print/json**(`modes/print-mode.ts`):`session.subscribe` 把事件打 stdout(text 或逐行 JSON,`print-mode.ts:108-124`),`await session.prompt(...)` 后按 `agent_end` 决定退出码(`print-mode.ts:132-139`)。
- **rpc**(`modes/rpc/rpc-mode.ts`):stdin/stdout JSONL 命令协议,`prompt/steer/follow_up/abort/new_session/set_model/compact/bash/...`(`rpc-mode.ts:394-563`),供 IDE/进程集成。

### 3.7 自动重试

`AgentSession` 在 `agent_end` 后检查最后 assistant 消息:`_isRetryableError`(排除 overflow,交 compaction;`agent-session.ts:2876-2880`)→ `_prepareRetry` 指数退避重试(`agent-session.ts:2917+`),外层 `while (await this._handlePostAgentRun()) await this.agent.continue()`(`agent-session.ts:1101-1114`)实现 compact/retry/queued-message 三类续跑。

---

## 4. Tool 系统

### 4.1 工具定义(两层类型)

核心层 `AgentTool`(`agent/src/types.ts:387-412`,含 pi-ai `Tool` 基):

```ts
export interface AgentTool<
  TParameters extends TSchema = TSchema,
  TDetails = any,
> extends Tool<TParameters> {
  label: string;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
  replay?: "never" | "safe";
  executionMode?: ToolExecutionMode; // "sequential" | "parallel"
}
```

`Tool` 基(`ai/src/types.ts:517-522`)= `name / description / parameters(TypeBox TSchema) / constrainedSampling`。返回 `AgentToolResult` = `content(text|image) + details(结构化,给 UI/日志) + usage + addedToolNames + terminate`(`agent/src/types.ts:361-376`)。契约:**失败靠 throw**,循环转 error result(`types.ts:395` 注释 + `agent-loop.ts:708-714`)。

harness 层 `ToolDefinition`(`coding-agent/src/core/extensions/types.ts:451-500`)额外带 `promptSnippet / promptGuidelines / renderCall / renderResult / renderShell / executionMode`,`ctx: ExtensionContext` 多参;`wrapToolDefinition` 把它降格成 AgentTool(`tools/tool-definition-wrapper.ts:5-20`)。

### 4.2 注册进 agent 的路径

内置 8 工具:`read, bash, powershell, edit, write, grep, find, ls`(`tools/index.ts:95-105`),默认激活 `["read","bash","edit","write"]`(`sdk.ts:256, agent-session.ts:2831-2833`;`--tools`/`settings.defaultTools` 可改,`sdk.ts:258-263`)。`_refreshToolRegistry`(`agent-session.ts:2694-2785`)合并 builtin definitions + extension `registerTool` + SDK `customTools`(同名后写覆盖,`definitionRegistry.set` `agent-session.ts:2722`),allow/deny list 过滤,`wrapRegisteredTools` 注入扩展 ctx → `setActiveToolsByName` 写 `agent.state.tools` 并重建 system prompt(`agent-session.ts:966-983`)。工具集变化(扩展加载/reload/active 切换)即改变 LLM 可见面。

### 4.3 解析 / 校验 / 分发

1. assistant 完成后取 `content.filter(c => c.type === "toolCall")`(`agent-loop.ts:222`);`ToolCall` 结构由 provider 适配器在 `toolcall_end` 定稿(`ai/src/types.ts:373-381`)。
2. 模式选择:config `toolExecution`("parallel" 默认,`agent.ts:237`)+ 任一被调工具声明 `executionMode:"sequential"` 则整批串行(`agent-loop.ts:416-424`)。
3. **prepare**(`agent-loop.ts:607-675`):按名查 tool(`context.tools.find`,`agent-loop.ts:614`——查找域是当轮 context 快照)→ `tool.prepareArguments` → `validateToolArguments` → `beforeToolCall` hook(block→error result)。任何 throw(如校验失败)被 catch 成 immediate error result(`agent-loop.ts:668-674`),模型下一 turn 能看到错误并重试——**schema 错误不中断循环**。
4. **校验**(`ai/src/utils/validation.ts:317-350`):TypeBox `Compile`(WeakMap 缓存,`validation.ts:271-280`)+ `Value.Convert` + 自写 JSON-schema 宽化 coercion(`coerceWithJsonSchema` `validation.ts:194-238`,处理模型常见错型 `"3"`→3 等)+ 可选 null 清理(`normalizeOptionalNulls` `validation.ts:240-269`);失败信息含逐条路径 + 原始 args 回显(`validation.ts:341-349`)。
5. **execute**(`agent-loop.ts:677-718`):`tool.execute(id, validatedArgs, signal, onUpdate)`;`onUpdate` 把 partial result 包成 `tool_execution_update` 事件(带节流责任在工具侧,如 bash 的 `BASH_UPDATE_THROTTLE_MS`,`tools/bash.ts:17, 281-294`);settle 后多余 update 被忽略(`agent-loop.ts:690-691`)。
6. **finalize**(`agent-loop.ts:720-765`):`afterToolCall` 可逐字段覆写 content/details/isError/usage/terminate(无深合并,`agent/src/types.ts:84-95`)。
7. **回填**:每个 finalized → `ToolResultMessage`(`role:"toolResult", toolCallId, toolName, content, isError, details`,创建 `agent-loop.ts:784-798`)→ emit `message_start/end` → push 进 `context.messages`(`agent-loop.ts:237-240`)→ 下一 LLM 调用经 `convertToLlm` 原样透传。

### 4.4 流式 partial tool-call 参数

provider 适配器把 `input_json_delta`/`function_call_arguments.delta` 累积为 raw JSON 串,每个 `toolcall_delta` 用 **`parseStreamingJson`**(`ai/src/utils/json-parse.ts:104-124`)尽力解析:`JSON.parse → repairJson → partial-parse → {}`;UI 因此能在参数未完整时实时渲染 `toolcall` 内容(partial AssistantMessage 中的 `arguments` 是"可解析前缀"的结果)。定稿以 `toolcall_end`/`done` 的完整消息为准。**截断防御**:stopReason=length 时整批 tool call 一律拒绝执行(`agent-loop.ts:379-404`),因 salvage 解析可能"看似合法但内容不完整"。

### 4.5 内置工具细节

- **bash**(`tools/bash.ts`):schema `{command, timeout?}`(`bash.ts:37-40`);`BashOperations.exec` 可注入(远程/沙箱替换,`bash.ts:58-76`);本地实现 spawn 分离进程、stdout+stderr 合并流入 `OutputAccumulator`(`bash.ts:79-145, 254-304`);**输出截断**:保留尾部,上限 2000 行或 50KB 先到者(`truncate.ts:11-12`),被截断时完整输出落临时文件并把路径写进结果文本(`bash.ts:234, 316-331`);非零退出码 throw `"...Command exited with code N"`(带已产出输出,`bash.ts:363-365`);timeout/abort 杀进程树(`bash.ts:108-118`)。注入 `PI_SESSION_ID/PI_MODEL/...` 环境元数据(`bash.ts:178-188`)。
- **read**:`{path, offset?, limit?}`(`tools/read.ts:14-18`),行截断复用 truncate;图像 auto-resize 选项(`sdk.ts:292` 区域)。
- **edit**:`{path, edits:[{oldText,newText}...]}` 多锚点替换(`tools/edit.ts:32-40`),应用前 diff 校验(`tools/edit-diff.ts`),写经 `withFileMutationQueue` 串行化同文件变更(`tools/file-mutation-queue.ts`)。
- **write**:`{path, content}`(`tools/write.ts:11-14`),同样走 mutation queue。
- grep/find/ls 为只读辅助工具,默认不激活(`createReadOnlyToolDefinitions` `tools/index.ts:173-180`)。

---

## 5. Memory / Context 管理

### 5.1 持久化格式:append-only JSONL 树(不是线性列表)

- 位置:`~/.pi/agent/sessions/<cwd 编码目录>/<timestamp>_<sessionUuidv7>.jsonl`(`session-manager.ts:476-489` 目录编码,`session-manager.ts:949` 文件名;`config.ts:528-534` agentDir,`PI_AGENT_DIR` 可覆盖)。`--session-dir` / `PI_SESSION_DIR` 可改(`main.ts:671-675`)。
- 首行 header `{type:"session", version:3, id, timestamp, cwd, parentSession?}`(`session-manager.ts:30-39`);其后每行一个 entry,公共字段 `{type, id(8位hex), parentId, timestamp}`(`session-manager.ts:46-51`)——**parentId 指回树中前驱**,逻辑上是一棵 DAG-in-file;当前追加点是 `leafId`。
- Entry 类型(`session-manager.ts:53-153`):`message`(任意 AgentMessage)、`thinking_level_change`、`model_change`、`compaction`、`branch_summary`、`custom`(扩展状态,**不进 context**)、`custom_message`(扩展注入,**进 context**)、`label`(书签)、`session_info`(命名)。
- 写入策略:`_persist` 首次整体 flush(`wx` 打开),此后逐行 `appendFileSync`(`session-manager.ts:1043-1055`);触发点在 `AgentSession._handleAgentEvent` 的 `message_end`(即时落盘,崩溃可恢复,`agent-session.ts:669-686`)。新 session 文件延迟到首条 assistant 消息才创建(`session-manager.ts:1509-1520` 注释)。

### 5.2 上下文重建 / 恢复 / fork

- `buildSessionContext(entries, leafId)`(`session-manager.ts:461-470`):从 leaf 沿 parentId 回溯成路径(`buildSessionPath` `session-manager.ts:334-360`),路径上 `model_change/thinking_level_change`/最后 assistant usage 恢复设置(`session-manager.ts:362-377`),再经 `buildContextEntries` 应用 compaction 窗口(`session-manager.ts:418-454`:保留 compaction entry 本身 + `firstKeptEntryId` 起至 compaction 前的 kept 段 + compaction 后全部),`sessionEntryToContextMessages` 投影为 AgentMessage(`session-manager.ts:383-408`)。
- Resume:`SessionManager.open/continueRecent`(`session-manager.ts:1562, 1589`)→ `sdk.ts:375-386` 把重建的 messages 直接赋回 `agent.state.messages`。
- Fork 两种:① 会话内 `createBranchedSession(leafId)`(`session-manager.ts:1427-1544`)——把根→leaf 路径重链为新文件(剔除 label 中间节点并重建,header 记 `parentSession` 指向旧文件);② CLI `--fork` 的 `SessionManager.forkFrom`(`session-manager.ts:1611-1659`)——复制源文件全部 entries 到新 id 文件。跨会话谱系就是 `parentSession` 链。
- Tree/time-travel:`getTree()` 暴露完整树(`session-manager.ts:158-166`),交互模式可切 leaf;离开旧分支时生成 `branch_summary`(`compaction/branch-summarization.ts:258` `BRANCH_SUMMARY_PROMPT`)注入新分支作为回看摘要。

### 5.3 Context-window 溢出:三条压缩路径 + 触发点

`AgentSession` 集中调度(coding-agent 层,而非 agent-core):

1. **pre-turn 阈值**:每 turn 开始前 `prepareNextTurnWithContext` → `_compactBeforeNextAssistantResponse`,用消息估算 token 对 `contextWindow` 判 `shouldCompact`(`agent-session.ts:538-555`;`compaction/compaction.ts:235-237`:`contextTokens > contextWindow - reserveTokens`;默认 `reserveTokens=16384, keepRecentTokens=20000` `compaction.ts:132-136`)。
2. **post-run 阈值/溢出**:最后 assistant usage 精确计数(`compaction.ts:146-148`),`isContextOverflow`(provider 报的 4xx 溢出)或 `isRecoverableLength` → 删掉失败消息、压缩、`willRetry` 续跑,一次性 compact-and-retry 防死循环(`_overflowRecoveryAttempted` `agent-session.ts:2180-2224`);普通阈值压缩无 retry(`agent-session.ts:2226-2257`)。
3. **手动**:`/compact` → `AgentSession.compact()`(`agent-session.ts:1921+` 区域 `_runDefaultCompaction` 共享)。

压缩执行:沿分支从近到远累计到 `keepRecentTokens` 定切点(`findCutPoint` `compaction.ts:388-429`),切点前旧消息 `serializeConversation` 后交 LLM 生成结构化 checkpoint——提示词就在源码内:`SUMMARIZATION_PROMPT`(`compaction.ts:467-498`,`## Goal / ## Constraints & Preferences / ## Progress(Done/InProgress/Blocked)/ ## Key Decisions / ## Next Steps / ## Critical Context` 固定格式)+ 增量更新版 `UPDATE_SUMMARIZATION_PROMPT`(`compaction.ts:537-539`)+ 系统提示 `SUMMARIZATION_SYSTEM_PROMPT`(`compaction/utils.ts:156`)+ 超长单 turn 的 prefix 摘要(`compaction.ts:835`)。产物作为 `compaction` entry append(`sessionManager.appendCompaction` `agent-session.ts:2379`),随后 `agent.state.messages = buildSessionContext().messages` 热替换(`agent-session.ts:2380-2382`)。扩展可经 `session_before_compact` 提供替代摘要(`agent-session.ts:2296-2328`)。摘要 LLM 调用同样走重试包装与 auth(`_getSummarizationRequestAuth` `agent-session.ts:449-472`)。

### 5.4 长期记忆:**不存在**(这本身是结论)

在 `packages/coding-agent/src` 与 `packages/agent/src` 未发现任何跨会话记忆存储/检索机制(无 MEMORY.md 类文件、无向量检索、无 "remember" 工具)。pi 的"记忆"= 会话树 JSONL + 压缩摘要 + `AGENTS.md/CLAUDE.md` 项目上下文 + skills(按需展开的 markdown 知识包)。`packages/agent/src/harness/session/memory.ts` 的 "memory" 只是新 harness 的**内存态存储后端实现**(测试/无盘模式),`session-backends/sqlite-node` 是其 SQLite 持久化——都属会话持久化而非语义记忆。README 亦自述"跳过 sub-agent / plan mode 这类 feature,让用户自己用扩展造"(`packages/coding-agent/README.md` 引言段)。

### 5.5 两套并行体系(重要,避免误读)

`packages/agent/src/harness/**`(`AgentHarness`、`runtime/drive/**` 的 checkpoint/reconcile/retry/terminal 状态机、`session/jsonl|sqlite` 仓库、effect-gate 工具执行)是**新一代 durable-session 实现**,`src/index.ts:43-79` 虽导出,但发布 CLI 的 `coding-agent/src/core/*` 完全不引用它——引用者仅 `coding-agent/src/experimental/**` 与 `packages/server|client`(grep `AgentHarness` 结果)。复刻时只需第一套:`agent-loop.ts + agent.ts + core/session-manager.ts`。harness 的 drive/reducer 细节本次未逐行精读(honest gap)。

---

## 6. 自己复刻时的最小实现清单

按依赖序,每件都对应上文已验证的实现:

1. **统一 LLM 流式接口**:一个 `streamSimple(model, context, options) → EventStream<AssistantMessageEvent>`;事件集最小 `start / text_delta / thinking_delta / toolcall_delta / done / error`,失败必须编码进流(`ai/src/types.ts:546-562` 契约)。每个 provider 写一个 delta→事件适配器;工具参数用 salvage JSON 解析(`json-parse.ts:104`)。
2. **工具类型**:name + description + JSON Schema(TypeBox)+ `execute(id, args, signal, onUpdate)` + 返回 `{content[], details}`,失败靠 throw(`agent/src/types.ts:387-412`)。
3. **核心循环(~200 行可成型)**:照抄 `runLoop` 双层 while 结构——`streamAssistantResponse`(transformContext → convertToLlm → 流消费 → partial 回填)→ toolCall 批执行(prepare: 查找/校验/before-hook;execute;finalize: after-hook)→ `turn_end` → 停止判定(无 tool call / error / abort / 钩子)→ steering/followUp 队列 drain。emit 回调即事件 API(`agent-loop.ts:156-273`)。
4. **有状态 Agent**:messages/tools/systemPrompt/model 一个 state 对象 + subscribe 列表,事件 reduce 维护状态(`agent.ts:173-591`)。
5. **会话持久化**:JSONL append-only,行内 `{id, parentId, timestamp, type, payload}` 树,leaf 指针;每次 message_end 落盘;resume = 沿 leaf 回溯重建。这比"线性数组 + 定期快照"实现简单且天然支持 fork/branch(`session-manager.ts:30-51, 334-360, 1043-1081` 模式)。
6. **压缩**:token 会计优先用 provider usage(`calculateContextTokens`),阈值 `window - reserve`;沿分支找 keepRecentTokens 切点;用固定格式 checkpoint prompt 生成摘要,写一条 `compaction` entry,`agent.state.messages` 热替换为重建上下文(`compaction.ts:235, 388-429, 467-498` + `agent-session.ts:2379-2382` 流程)。
7. **System prompt 组装器**:静态骨架 + 激活工具 snippet 表 + 项目上下文文件(`<project_context>` 包裹)+ skills 索引;工具集变化即重建(`system-prompt.ts:28-168`)。
8. **harness 薄壳**:CLI 参数 → 会话选择(create/open/continue/fork)→ 组装 Agent+SessionManager → 一个 `prompt()/steer()/followUp()/abort()` 的会话对象;print 模式 = subscribe→stdout;TUI 最后做(`main.ts` + `sdk.ts:173-410` 的结构即全部)。
9. **扩展系统(可选第二期)**:用户 TS 用 jiti 动态 import;暴露 `on(event)` + `registerTool/registerCommand`;`tool_call` hook 返回 `{block}` 即成权限系统(`loader.ts:501-513`、`types.ts:1252-1317`、`agent-loop.ts:643-653`)。
10. **安全底线**:项目本地代码执行前的一次性信任确认 + bash 进程树 kill + 截断 tool call 整批拒执(`main.ts:700-759`、`bash.ts:108-110`、`agent-loop.ts:379-404`)。

刻意**不做**的(源自 pi 的设计取舍):无 max-steps 硬上限(靠模型自然停止 + 队列语义)、无逐工具确认弹窗、无内建 sub-agent/plan-mode/向量记忆——pi 把这些全部下放给扩展。

---

## 附:未验证 / 存疑事项

- `packages/agent/src/harness/runtime/drive/**` 的 durable 状态机细节(checkpoint/reconcile 各文件)未逐行精读,仅确认"主 CLI 不依赖它"。
- `pi-messages`/`radius` 等自有协议 provider 的角色未深究(不影响架构结论)。
- token 估算 `estimateTokens` 的具体启发式(`ai/src/utils/estimate.ts`)未展开。
