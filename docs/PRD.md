# PRD: mini —— pi 式编码 agent(v1 复刻)

- 来源:2026-09-13 grilling 会话(Q1–Q33 全部拍板,决策记录见同目录 `DECISIONS.md`,砍件清单见 `DEFERRED.md`)
- 事实基线:`docs/pi-agent-architecture-research.md`(pi commit 71dca87,30+ 处行号已核对;本目录为快照副本,教学原件在 `~/dqq/research/`)
- 建造顺序:⓪ 假流+loop → ① 真 stream → ② tools → ③ memory → ④ harness(每层开工前必须交验收句,判卷通过才允许发建造指令)

## Problem Statement

终端使用者需要一个能替他在本机干编码活的 agent CLI:流式对话、自动调用 read/write/edit/bash、会话可断点续聊、对话太长不炸。现成的 pi 架构完整但体量与心智负担都超出"我指挥 AI 复刻"的半径;直接魔改 pi 则分不清"AI 建错了"还是"我改的设计"。

## Solution

按 pi 第一套体系(`agent-loop.ts + agent.ts + session-manager.ts` 路线,报告 §5.5)**1:1 复刻一个单包 mini-pi**,只加两类偏离:

1. **安全件**(Claude Code 式):bash/write/edit 执行前终端内联确认 + "always" 前缀规则持久化;max-turns=50 保险丝。
2. **减法**:方言适配器只 2 个、entry 类型只 5 种、无队列/无 TUI/无扩展系统(全部进 DEFERRED.md)。

## User Stories

### ① stream(统一事件流)

1. 作为使用者,我想用 base_url+model+key_env 一行配置直连 deepseek(openai-completions 方言),以便零成本跑通首发
2. 作为使用者,我想新增 glm/kimi 等厂商时只加配置行、不改代码,以便验证"厂商≠方言"抽象
3. 作为使用者,我想让 qwen3.8-flash 走 anthropic-messages 方言的第二适配器且上层代码零感知,以便证明"统一事件流"不是口号
4. 作为使用者,我想密钥永远只从环境变量读取、不进任何仓库文件,以便以后开源不慌
5. 作为使用者,我想逐字看到回复流出,以便确认模型在干活而不是卡死
6. 作为使用者,我想在 tool-call 参数还没吐完时就实时看到可解析前缀(salvage 解析),以便 UI 不空白;而定稿残缺(截断)时整批拒绝执行
7. 作为开发者,我要求 provider 失败以编码进流的 error 事件呈现、禁止 throw,以便 loop 层零 try/catch
8. 作为使用者,我想要 5xx/超时自动重试 1 次、4xx(配额/鉴权)立即停并显示原因,以便 relay 抖动不烦我、真错不骗我
9. 作为开发者,我要求每轮记录 provider 返回的 usage token 数,以便压缩阈值与成本核对有精确依据

### ⓪ loop(核心循环)

10. 作为开发者,我想用假 streamFn 手喂四剧本(纯文本 / 一次 toolCall / 无限 toolCall / 流中途 error)离线驱动循环,以便不花一分钱验收 loop
11. 作为使用者,我想模型回复不含 toolCall 时循环自然停止,以便对话有明确边界
12. 作为使用者,我想模型跑飞(每轮都 toolCall)时循环在 50 turn 强制停并告知,以便半夜不烧钱
13. 作为开发者,我要求停止判定覆盖 pi 五条件:无 toolCall / stopReason=error|aborted / 外部 abort / 钩子叫停 / 整批 terminate
14. 作为开发者,我要求 tool 结果以 role=toolResult + toolCallId 回填 messages,以便模型对上号
15. 作为开发者,我要求流式 partial 消息占位在 context.messages 末位并随 delta 替换,以便 UI 与状态同一来源
16. 作为使用者,我想 Ctrl+C 立即中断当前 LLM 流与在跑工具,以便止损

### ② tools(四件套 + 安检)

17. 作为使用者,我想 read 支持 offset/limit 且超长输出保尾截断,以便大文件不吃爆 context
18. 作为使用者,我想 edit 用多锚点 {edits:[{oldText,newText}]},任一锚点不命中则整批失败报回模型,以便模型自纠而不静默改坏
19. 作为使用者,我想 write 整文件落盘(经同文件写队列串行),以便并发 tool 批不打架
20. 作为使用者,我想 bash 有超时 + abort 杀进程树 + 全量输出落临时文件且把路径写进结果,以便失控命令可停可查
21. 作为开发者,我要求参数 schema 校验失败变成 error toolResult 回喂模型而不中断循环,以便模型下一 turn 重试
22. 作为使用者,我想 bash/write/edit 执行前弹 `Execute: <命令>? ❯1 Yes / 2 Yes, always / 3 No`,read 直接放行,以便零基础也拦得住 rm -rf
23. 作为使用者,我想选 "Yes, always" 后按命令前缀(如 `git:*`)落盘 rules.json、重启仍有效、手删文件即撤销,以便常用命令不重复弹窗且一键 always 永远不可能
24. 作为开发者,我要求确认逻辑实现在 loop 的 beforeToolCall hook 而非工具内部,以便新工具自动过安检

### ③ memory(JSONL 树 + 压缩)

25. 作为使用者,我想会话以 append-only JSONL 树存储(每行 {id,parentId,type,payload}),以便历史永不丢、崩溃可恢复
26. 作为使用者,我想每条 message_end 即时落盘,以便断电重启不丢本轮
27. 作为使用者,我想 `--continue` 接最近会话、`--resume` 列编号挑历史会话,以便断点续聊
28. 作为开发者,我要求 usage 精确计数 > contextWindow − 16384 时自动压缩,并支持终端手动 `/compact`:切点 = 从最近 entry 往回累计 20000 token,刀口不劈开 toolCall/toolResult 配对(遇配对则下移);纪要由同模型按固定七段生成(目的/做到哪了/关键要点/引用文件/关键决定/下一步/关键背景),再压缩时增量合并旧纪要(纪要恒为一份);写 compaction entry(含 firstKeptEntryId)→ 热替换 messages;旧行一条不删;旧段本身超窗 → 拒压并报错提示手动处理

### ④ harness(薄壳)

29. 作为使用者,我想裸 readline 循环 + 流式打印(thinking 淡显),以便没有 TUI 也能干活
30. 作为使用者,我想 `--model` 选择/热切模型并记 model_change entry(resume 时恢复),以便一条线挂了换一条
31. 作为使用者,我想 system prompt = 固定骨架 + 激活工具清单 + 项目上下文(从 cwd 逐级向上找 AGENTS.md/CLAUDE.md,近者优先),以便模型知道我的规矩
32. 作为开发者,我要求 harness 只做 I/O:组装 Agent+SessionManager 后 subscribe→stdout

### 元工作流

33. 作为学习者,我要求每层开工前自己写一句"演示即完成"验收句并判卷通过,以便 AI 交付时有不合格依据
34. 作为学习者,我要求所有砍掉功能连同"日后怎么加回"写入 DEFERRED.md,以便砍掉的不是丢失而是排队

## Module Design

按 deep-module 词汇(接口/缝/深度/适配器)描述 v1 的模块拆分。拆分与建造顺序 ⓪–④ 一一对应,与 `src/{stream,loop,tools,memory,harness}/` 目录分层一致。没代码 = 设计模块的时机,不是障碍:深度是接口的属性,在写码前定。

### 词汇(本节用)

- **接口**:调用者要正确用本模块必须知道的一切 —— 类型签名 + 不变式 + 顺序约束 + 错误模式 + 配置 + 性能特性。比 TS `interface` 宽。
- **缝**:不改该处即可改行为的位置,即接口安身处。
- **深度**:小接口背后藏大量行为 → 深;接口≈实现 → 浅(避)。
- **适配器**:在缝处满足接口的具体物,描述角色不描述内涵。
- **删除测试**:删掉本模块,复杂度消失=纯透传(浅);复杂度散到 N 个调用点=它在挣饭(深)。

### 模块清单

| 模块                                    | 缝                                  | 接口(最小形态)                                                           | 深度来源(藏在背后的复杂度)                                                                                                                                                                                                                                     |
| --------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **loop**                                | `runLoop(...)` 函数                 | `runLoop(streamFn, tools, context, {confirm, maxTurns, clock}) → events` | 假流驱动;五停止条件(无 toolCall / stopReason=error\|aborted / 外部 abort / 钩子叫停 / 整批 terminate) + maxTurns=50 保险丝;同批 toolCall 串行;partial 占位 messages 末位并随 delta 替换;error 编码进流、loop 层零 try/catch;toolResult 以 role+toolCallId 回填 |
| **stream**                              | 适配器满足的统一 ProviderEvent 协议 | `stream(config, context) → AsyncIterable<ProviderEvent>`                 | 两方言(openai-completions / anthropic-messages)翻成同一事件;5xx/超时自动重试 1 次、4xx 即停;toolcall 参数流式 salvage 解析(残缺尽力解析,定稿截断整批拒执);usage 记录;厂商只是配置行                                                                            |
| **tools**                               | 工具注册表 + tool-call 分发         | `tools[name].run(args) → ToolResult`;旁挂 JSON Schema                    | read(offset/limit/保尾截断);bash(超时+abort 杀进程树+全量落临时文件+路径写回结果+2000 行/50KB 保尾);edit(多锚点 {edits:[{oldText,newText}]} 全批原子校验,任一锚点不命中整批失败回喂);write(同文件写队列串行);参数校验失败→error toolResult 不断循环            |
| **memory**                              | `SessionManager` 方法               | `append(entry)` / `rebuild() → messages` / `compact(summarizeFn)`        | JSONL append-only 树 {id,parentId,ts,type};message_end 即时落盘崩溃可恢复;旧行永不删;leaf 沿 parentId 回溯重建;应用 compaction 窗口投影 messages;compaction 切点不劈 toolCall/toolResult 配对;纪要同模型中文固定七段增量合并(纪要恒一份);旧段超窗拒压报错      |
| **confirm**(loop 的内部缝,非独立大模块) | loop 的 `beforeToolCall` 钩子       | `confirm(prompt) → 'yes'\|'always'\|'no'` + 读 rules.json                | Claude Code 式三选项;前缀匹配落 rules.json(项目目录明文,手删即撤销);仅 bash/write/edit 过检,read 放行;新工具自动过安检(逻辑在 loop 钩子不在工具内)                                                                                                             |
| **harness**(故意浅)                     | 组装点                              | `cli()` 组装 Agent+SessionManager 后 subscribe→stdout                    | 故意浅:裸 readline + 流式 stdout(thinking 淡显);flags 仅 --model/--continue/--resume;会话内唯一斜杠 /compact;systemPrompt = 骨架+工具清单+项目上下文(向上找 AGENTS.md/CLAUDE.md 近者优先);工具集变即重建。深了=错位                                            |

### 深度判据(为什么这样分)

- **loop 深**:接口 1 函数,实现藏五停止条件 + 串行 + partial + error 进流。删除测试 —— 删它,这些逻辑散到每个调用点与每个测试,复杂度不消失。挣饭。
- **stream 真缝(非假设)**:两个 adapter(openai-completions / anthropic-messages)满足同一 ProviderEvent 协议 → 真缝,不是假设缝。厂商≠方言(G3):加 glm/kimi 只加配置行不改代码。
- **memory 深**:一个接口三职责(append/重建/压缩)藏同实现 → locality:崩恢复原、切点算法、纪要合并改一处,全调用点受益。
- **confirm 是 adapter 不是独立大模块**:满足 `beforeToolCall`,删了 loop 仍能跑(放行默认)。它填角色,不抢模块位。
- **harness 故意浅**:薄壳不该深。深=I/O 逻辑渗出,错位。

### 固定接口契约(实现照填)

```
ProviderEvent = start | text_delta | thinking_delta | toolcall_delta | done | error
AgentEvent    = 12 个(照抄 pi:agent_start/turn_start/message_start/update/end×2/tool_execution_start/update/end/turn_end/agent_end 一族)
streamFn      = (config, context) => AsyncIterable<ProviderEvent>
confirm       = (prompt: string) => 'yes' | 'always' | 'no'
summarizeFn   = (messages) => summary   // 注入,测试零网络
config        = { dialect, base_url, key_env, models[] }   // 密钥只从 env 读
entry         = header | message | model_change | compaction | session_info   // v1 仅 5 种
```

### 注入原则(测试性)

loop 的全部依赖可替换 —— `streamFn` / `confirm` / `summarizeFn` / 时钟 / 随机源。测试 S1–S4 全在缝处喂假物断言外部行为,零网络、零私函数窥探(对应 Testing Decisions)。

## Implementation Decisions

- **运行时**:node v24 直跑 .ts(原生 type stripping,环境已验证);单 npm 包,src/{stream,loop,tools,memory,harness}/ 按目录分层;无构建步骤
- **事件契约照抄 pi**:provider 层事件 start/text_delta/thinking_delta/toolcall_delta/done/error;agent 层 12 个 AgentEvent(agent_start/turn_start/message_start/update/end/tool_execution_start/update/end/turn_end/agent_end 一族)。error 一律编码进流
- **适配器 2 个,按方言分**:openai-completions(首发 deepseek-chat,凭据实测可用)、anthropic-messages(第二,qwen3.8-flash 经 token-plan relay,实测可用、会吐 thinking 块)。配置结构:{dialect, base_url, key_env, models[]}
- **注入原则**:loop 的全部依赖可替换 —— streamFn / confirm(prompt)→answer / summarizeFn / 时钟/随机源,测试零网络
- **停止判定**:pi 五条件 + maxTurns=50(配置项,唯一故意偏离)
- **工具**:仅 read/bash/edit/write;edit 多锚点全批原子校验;bash 超时+杀进程树+保尾截断(默认值抄 pi:2000 行/50KB);toolcall 参数 salvage 解析(残缺→尽力解析,定稿截断→整批拒执);参数校验失败→error result 不断循环;schema 用 JSON Schema,校验库由建造 AI 选定但契约固定;同批 toolCall 串行执行
- **安检**:beforeToolCall hook 内实现;rules.json 明文放项目目录,条目 {tool, prefix};仅 bash/write/edit 过检
- **memory**:路径 ~/.mini/sessions/<cwd 编码>/<时间>_<uuidv7>.jsonl;首行 header {type:"session",version:1,id,cwd};v1 entry 类型仅 header/message/model_change/compaction/session_info;写策略 = 首建 wx + 逐行 append;重建 = leaf 沿 parentId 回溯 → 应用 compaction 窗口 → 投影 messages
- **compaction**:两数两职 —— 触发 = provider usage 精确计数 > contextWindow − reserve(16384),切点 = 从近往远累计 keepRecent(20000) 处(128k 窗口约 112k 动刀);刀口不劈 toolCall/toolResult 配对;纪要 = 中文固定七段(目的/做到哪了/关键要点/**引用文件**★/关键决定/下一步/关键背景),同模型生成,二次压缩增量合并(UPDATE 式,纪要恒一份);旧段超窗拒压报错,分段兜底进 DEFERRED;支持 `/compact` 手动触发
- **CLI flags 全集(仅 3 个)**:--model / --continue / --resume;会话内斜杠命令唯一一条:/compact
- **system prompt**:骨架 + 工具 snippet + <project_instructions> 包裹的项目上下文,工具集变化即重建

## Testing Decisions

- **好测试定义**:只断言外部行为 —— 喂进去的事件/文件/配置,断言事件序列、messages 终态、磁盘 jsonl 内容;不断言私有函数内部
- **S1(主缝,~90% 测试)**:`runLoop(streamFn, tools, context, {confirm, maxTurns, clock}) → events`。假流四剧本 + confirm 假应答 + 截断拒执 + 校验失败回喂,全在此层。覆盖 ⓪② 两层的验收
- **S2**:`stream(config, context) → 事件流`。离线用录制的真实 SSE fixture 断言两方言适配器输出同一事件协议;一条在线 smoke(deepseek,断言 toolcall_delta 出现),单独 tag、默认不跑
- **S3**:`SessionManager(tempDir)` 写读断言:append-only、崩溃恢复、leaf 重建
- **S4**:`compact(context, summarizeFn)` 注入固定假摘要,断言 firstKeptEntryId 正确、旧行零删除、重建窗口=摘要+保留段+新行
- **harness 不做自动测试**:三 flag + 流式打印由验收句人工演示
- **先例**:pi 自身即"假 streamFn 测 loop"模式;本仓库无既有测试,新建

## Out of Scope

见 `DEFERRED.md`。摘要:steering/followUp 双队列(双层 while 形状保留但不挂队列)、并行 tool 执行、TUI 差分渲染、extensions/skills/jiti 热加载、fork/切分支交互 + branch_summary、custom/custom_message/label/thinking_level_change entry、多轮指数退避重试、超长旧段分段摘要兜底、跨会话语义记忆(pi 亦无)、sub-agent/plan mode(pi 刻意下放)、协议/远程 server。

## Further Notes

- **风险已实测**:token-plan relay 今天 403 摔死过一次,且与本教学会话同源共配额;deepseek 官方直连为主粮,relay qwen 为第二口粮。两条线都不稳时 mini-pi 会先于代码暴露基建问题——这是 feature 不是 bug
- **与 MISSION 的对应**:成功标准 1(讲清循环继续/停止)= 层⓪验收;标准 2(树与 compaction)= 层③;标准 3(拆部件指挥 AI)= 本 PRD + 每层验收句制度;标准 4(读懂几百行)= 每层交付后的读码课
- **密钥纪律**:DEEPSEEK_API_KEY / ANTHROPIC_AUTH_TOKEN 只经 env 读取;.env* 进 .gitignore(仓库还没建,git init 时处理)
