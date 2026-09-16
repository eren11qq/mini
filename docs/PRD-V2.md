# PRD V2: mini —— 生产运行加固(MAF 图案移植批)

- 来源:2026-09-16 调研对话([microsoft/agent-framework](https://github.com/microsoft/agent-framework) v1.0 GA 对照,结论 = 无 TS SDK,只移植图案不引代码;对照表见会话档)
- 基线:v1(`docs/PRD.md`)⓪–④ 层全绿,C1–C21 已合/在途;本批新卡走 **D 系列**,落 `docs/ISSUES.md`
- 缝裁决(用户确认 2026-09-16;D5 收口 2026-09-16):复用 S1(`runLoop`)+ S3(`SessionManager`)+ harness 组装点;新纯叶 = journal.ts / trace.ts / task.ts;契约扩 = 两个可选字段一处交叉(`AgentEvent` 全 10 类 `agentId?` + `agent_end.usage?` = child usage 合计唯一载体,原句"仅一处"被 D4 实际落法修订)
- **先行 bug(D1 的靶心)**:toolResult 从未落盘 —— cli.ts 只订阅 `message_end` 落盘,而 runLoop 对 toolResult 不发 message_* 事件(只随 `turn_end` 携带)。带工具的会话 `--continue` = 末条 assistant 悬空 toolCall、配对 toolResult 全缺 → 两方言序列化后 provider 必 400。故事 26 字面成立、语义已破

## Problem Statement

终端使用者拿 mini 干真活时撞四面墙:① 会话只要用过工具,断点续聊直接 400(现行 bug);② run 中进程死 = 该轮已执行工具的结果全丢,重启后模型不知道哪些副作用已经发生,盲目重跑 bash;③ 同批多个 toolCall 串行累加,三个 read 也要排三次队;④ 事件流不落盘,跨天排查"它当时为什么这么干"= 黑盒;⑤ 探索型杂活没有便宜的读-only 子代理可派,主会话上下文被中间过程灌爆,压缩越来越早。

## Solution

把 MAF 的生产运行图案逐个手术移植成 TS 零依赖形态,四片竖切:

1. **D1 journal + 配对修复**(≈ MAF checkpoint/superstep):工具结果按 `tool_execution_end` 落盘(D3 后粒度 = 批级,allSettled 批齐按调用序发,D5 收口见故事 1);rebuild 后对悬空 toolCall 注入"结果未知"合成 toolResult;maxTurns 跨 resume 从消息重建续计
2. **D2 trace 导出**(≈ MAF OpenTelemetry):AgentEvent → JSONL 全事件落盘,按会话同目录
3. **D3 同批并行**(≈ superstep fan-out/fan-in):确认仍逐弹(对人),run 并发,回填按调用序
4. **D4 task 子代理**(≈ workflow-as-agent):runLoop 递归包成普通 Tool,首版只读工具白名单 + headless 拒答 confirm + 深度 1

不做:图引擎、异步审批上抛、MCP、云托管(触发条件记 Out of Scope)。

## User Stories

### D1 —— 工具日志落盘 + resume 配对修复

1. 作为使用者,我想每批工具跑完后结果按调用序落盘,以便进程崩了不丢已完成批次的事实;在飞批被杀 = 该批缺位统一由 repairDangling 补"结果未知"(D5 裁决 2026-09-16:D3 合并后即时性 = 批级,call 级即时落盘入 DEFERRED 候选)
2. 作为使用者,我想 `--continue`/`--resume` 一个用过工具的会话不再收到 provider 400,以便断点续聊真正成立(修现行 bug)
3. 作为使用者,我想崩溃时机批里悬空的 toolCall 被自动补 `{isError}`"中断,结果未知 —— 副作用可能已发生,先核实再重试"的 toolResult,以便模型不盲目重跑 `bash rm/git commit` 这类有副作用的命令
4. 作为开发者,我要求 事件→entry 映射(journal)与悬空修复(repair)都是纯函数,以便零网络零 fs 钉死单测
5. 作为使用者,我想 maxTurns 保险丝跨 resume 续计(从重建 messages 末条 user 之后的 assistant 数派生),以便跑飞循环杀了重开不能洗白计数
6. 作为开发者,我要求 entry 类型零新增(仍 5 类,toolResult 走现有 `message` payload),以便固定接口契约不破

### D2 —— 事件 trace 落盘

7. 作为使用者,我想每场运行的全部 AgentEvent 带毫秒戳落 JSONL(`~/.mini/sessions/<cwd编码>/<会话>.trace.jsonl` 同名旁挂),以便成本、时延、事故有据可查
8. 作为使用者,我想缺省即开、`--no-trace` 可关,以便记录不背人又可不落
9. 作为开发者,我要求 trace.ts = `(event, clock) → line` reducer 纯叶,落盘动作住 cli 接线处,以便 harness 故意浅不破
10. 作为学习者,我想行形状保留事件名与字段原样(仅加 `ts`/`agentId`),以便日后转 OTLP 不改格式

### D3 —— 同批 toolCall 并行

11. 作为使用者,我想同批多个 toolCall 并发执行,以便三个独立 read 不排队三倍时长
12. 作为使用者,我想弹窗仍一次一个逐 call 出(确认判定串行),以便审批体验与现在逐字节一致
13. 作为开发者,我要求并行后 toolResults 仍按 toolCalls 原调用序进 messages 与落盘,以便 provider 配对与快照语义稳定
14. 作为开发者,我要求 abort 命中 = 在飞工具吃 signal 被杀 + 该批照常合成缺位 toolResult + 走既有 aborted 路径,以便 Ctrl+C 语义不分叉
15. 作为开发者,我要求 write/edit 的文件互斥仍靠既有 per-path 写队列,以便并行不开新竞态面
16. 作为使用者,我想 terminate 语义不变(批内任一 terminate → 全批完成后再停),以便子代理/退出工具行为可预期

### D4 —— task 子代理

17. 作为使用者,我想模型能把探索/查答案类任务派给只读子代理(首版工具白名单 = read),以便主会话上下文只见结论不见 30 次 read 的中间过程
18. 作为开发者,我要求 task 是普通 Tool:`makeTaskTool(deps)` 工厂注入 streamFn/工具集/深度,内部递归 `runLoop`,以便 loop 对"子代理"零特判
19. 作为开发者,我要求 child 的 confirm = headless-deny 叶(凡未 preapproved 答 `{kind:"no", reason:"sub-agent headless"}`),以便 `run-loop.ts` "缺 confirm = 放行"的洞不随 child 扩权限变成越权面
20. 作为开发者,我要求 child 工具集永不含 task(maxDepth=1),以便子代理不递归繁殖
21. 作为使用者,我想父 Ctrl+C 一并杀 child(signal 透传),child 有独立更小 maxTurns(首版 20),以便失控止于子内
22. 作为使用者,我想 TUI 见到一行"▸ task 运行中"级进行提示,以便知道谁在干活(全量归属渲染进 DEFERRED 候选,首版不展开)
23. 作为开发者,我要求 child 会话不另建 session 文件,其事件流带 `agentId` 进 D2 trace,以便多代理调试在同一个文件里
24. 作为学习者,我要求 DEFERRED.md:66"sub-agent 不做"与"并行 tool 执行"两行翻案同步记 DECISIONS ★修订(照 H2/C15 先例),以便 spec 不打架

### 元

25. 作为学习者,我要求每卡带验收句 + 离线剧本(假 streamFn 剧本族先例),判卷通过才合,以便 v1 制度延续
26. 作为使用者,我要求本批新增 npm 依赖恒零,以便 mini 命根不断

## Implementation Decisions

- **范围**:D1→D4 按序(D3 独立;D4 的 trace 归属吃 D2、并发 N 个 task 吃 D3,故排最后);P5/P6/P7 不立项
- **journal.ts**(memory 家,纯):`eventToEntries(event): entry[]` —— `message_end`(assistant)照旧一条;新增 `tool_execution_end` → `{type:"message", payload: ToolResultMessage}`;cli 订阅环从硬编码 if 改查 journal 分发表,落盘动作与顺序不变(append = 事件到达序,assistant 的 message_end 天然先于同批 toolResults)
- **repairDangling**(journal.ts 同文件,纯):`repairDangling(messages): {messages, injected}` —— 只对**末条** assistant(`stopReason==="tool_use"`)的 toolCall id 集 − 其后已存在 toolResult 的 toolCallId 集;合成 `{isError:true, text:"interrupted before result was persisted — 副作用可能已发生,先核实(bash 重跑前查盘)再重试"}`;接入点 = `SessionManager.rebuild()` 出口(memory 侧),loop/cli 零感知;配对回退判据有先例 = compaction 刀口(session-manager.ts);补位插入位置 = 该批末条已有结果之后而非数组尾(D1 红测捞出:尾插在续聊落盘后 rebuild 会把 tool 行吊在新 user 行之后,openai 方言必 400 —— wire 硬要求 tool 紧跟带 tool_calls 的 assistant,D5 收口)
- **maxTurns 续计**:cli 组装 options 前从 `context.messages` 派生"末条 user 之后的 assistant 数"作偏移 → loop 零改动(接口已有 `maxTurns`,偏移在 harness 算,裁决仍是纯函数级)
- **trace.ts**(harness 家,纯 reducer + 落盘分离):`traceLine(event, clock): string`;cli 订阅环 appendFile;行 = `{ts, agentId?, ...event}`(agentId 提升为 ts 后首键,D2 卡裁;缺省零键 = 主代理行 diff-0);`--no-trace` = parseArgs 新 flag(纯缝先例 args.ts);旁挂共存两修(D2 红测捞出,D5 收口):`open()`/`list()` 扫描排除 `.trace.jsonl` 后缀(mtime 最新恒被吞 / --resume 选择器出假会话)+ 新增 `SessionManager.traceFile(): string | null` getter(会话名含 uuidv7 且延迟首建,类外不可知;纯路径推衍零碰盘,"落盘动作住 cli"不破)
- **AgentEvent 契约扩**:全 10 类可选 `agentId?: string`,缺省 = 主代理;落法 = `union & { agentId?: string }` 交叉一行非逐变体 ×10,判别窄化不受影响(D4 裁);取值 = `task-N`(N = task.ts 工厂闭包计数,并行 N child 各拿独立 id,D3 superstep 自动生效);另加 `agent_end.usage?: Usage`(见缝裁决行);先例注记照 types.ts 头("照抄 pi + maxTurns 偏离")追加一行
- **并行两段式**(run-loop.ts 工具批区):A 段 = 逐 call 串行完成 validate/danger/rules/confirm(收集 `writable`、落盘规则),B 段 = `Promise.allSettled` 并发已过门 runs,`tool_execution_start` 于 B 段按调用序先全发,results 与 `tool_execution_end` 均按调用序回填/发出(allSettled 批齐后 = 落盘粒度批级,D1 卡预留退路,D5 收口进故事 1,call 级即时 = DEFERRED 候选);A→B 之间查 signal(既有 aborted 缝保留);allSettled 后仍有缺位(abort 杀死)→ 合成 `{isError:true,"aborted"}` 补位,不破配对
- **task.ts**(tools 家):`makeTaskTool({streamFn, maxTurns=20}) → Tool`;args schema = `{prompt: string}`;child context = 新 messages + 精简 systemPrompt(任务说明 + read 工具清单);child tools = `[read]`(skipConfirm 已有);child options = `{confirm: headless-deny, maxTurns: 20, signal: 父signal透传}`(不传 rulesPath/sessionRules = 无 always 落盘面);结果 = child 末条 assistant text 进 `content`;child usage 合计进 trace 一条 `agent_end` 行(载 `usage`);child 事件管道 = `onEvent` 直连 cli trace append、**不进父事件流** ⇒ journal/TUI 天然零见 child = 故事 23「不另建会话文件」免费成立(D4 裁,D5 收口);TUI 首版仅"▸ task 运行中(只读子代理)"一行(tui.ts 经 tool_execution_start 派生,agentId 全量归属渲染 = DEFERRED 候选)
- **headless-deny**:纯叶 `confirmDeny(prompt) → {kind:"no", reason:"sub-agent headless"}`(住家 = `tools/task.ts`,D4 卡内定,D5 收口)
- **接线纪律**:三处接线(journal 分发 / trace append / task 注册)全在 cli.ts 订阅区,裁决零渗 harness;"确认逻辑在 loop 不在工具"(故事 24)不变
- **rules.json 语义**:child 不读不写(白名单只 read 本不弹;deny 叶是未来扩 child 工具集时的地基);父 rules 仍是唯一审批面

## Testing Decisions

- 好测试定义照 v1:只断外部行为 —— 喂事件/文件/配置,断事件序列、messages 终态、盘上 JSONL 行、假 provider 收到的请求体
- **纯叶锚测**(先例 rules.test / bash-parse.test / connect-flow.test 表驱动):journal 映射全事件种类、repairDangling 边界(无悬空/半悬空/末条非 tool_use/多 toolCall 缺 N)、traceLine 形状、confirmDeny
- **D1 本体** = S3 临时目录:append 全剧本 → 新进程 open/rebuild → 断注入行 + provider 序列化(`toWire`)出体无悬空 tool_use(openai/anthropic 两方言各一例,fixture 先例 S2 离线)
- **D1 e2e 剧本**:plain 慢喂管道起真 cli,假流让 agent 跑 `bash sleep 30`(会话 yes),执行中 kill -9 → 重启 `--continue` 发消息 → 断模型收到"结果未知"行(脚本留 `/tmp`,C18 sleep 逐行防 EOF 教训沿用)
- **D3**:registry.test.ts 假流家族 —— 假工具闭包记 `start[]/end[]` 时间线,断并发窗口重叠、回填序 = 调用序、confirm 弹次数 = 未预批数且逐弹、abort 批补位配对完整;`clock` 现 loop 未消费,不引入新计时依赖(用闭包序即可)
- **D4**:S1 双层套娃(父假剧本吐 toolCall task → child 假剧本独立注入),断父 messages 终态配对、child 事件带 agentId、deny 洞负例(child 工具集换成含假 bash → 收 `user rejected: ... sub-agent headless` 且循环不断)、深度守卫(child 工具面无 task)
- harness 人工剧本续 W 系列:trace 文件真机产生、task 真模型跑一次(真 key,判卷人跑)
- 门 = 全仓 vitest 绿 + typecheck + eslint + prettier(pre-commit 全仓门先例)

## Out of Scope

- **P5 HITL 异步审批上抛**(MAF pause+checkpoint):触发 = child 拿写权限或远程审批需求真出现;届时 confirm 缝改 pause/resume 形
- **P6 MCP 工具源**:MAF 无 TS SDK 帮不上,自写 client 独立批
- **P7 图引擎**(executor/edge/state/event):触发 = 多阶段自动管线(spec→impl→review 回跳)/ 并发 sub-agent 汇总裁决 / 第二循环拓扑,任一出现立卡
- 并行多 task 的 TUI 全量归属渲染、child 写权限、child 会话独立文件、跨会话记忆、云托管/Foundry
- steering/followUp 双队列、fork 交互 —— v1 DEFERRED 原样不动

## Further Notes

- MAF 对照一页结论:移植 = superstep journal / HITL-pause 形态(预研)/ workflow-as-agent / OTel 事件面 / 并行 superstep;不抄 = 图引擎、托管、middleware 链;mini 领先处 = rules 四档确认门、path glob、复合命令拆段(MAF tool-approval 无对位)
- 风险:D4 子代理 token 费对使用者不直观 → trace 必含 child usage 汇总;首版只读集是刻意的钱包保险
- 文档义务(卡内 AC 携带):DEFERRED.md 划掉"并行 tool 执行""sub-agent"两行;DECISIONS.md ★修订表加行;PRD.md 不回填(行号锚定死教训 C8)
- MAF 原文备查(P5/P7 触发再挖,本批零依赖这些链接成立):checkpoint 语义 = learn.microsoft.com/en-us/agent-framework/workflows/checkpoints;HITL pause 形态 = 同域 /workflows/human-in-the-loop;workflow-as-agent = 同域 /workflows/as-agents;本仓库无 `.codegraph` 级 MAF 源码档,复刻一律以本 PRD 措辞为准,勿回头抄 API 形状
