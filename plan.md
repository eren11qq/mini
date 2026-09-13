# plan.md —— mini v1 垂直切片(18 条,可验证 AC)

来源:`docs/PRD.md` + `docs/DECISIONS.md`。按 PRD 建造顺序 ⓪–④,每条薄 tracer bullet,AC 用 intent-driven 可观察格式(scenario/action/expected/must-not/verification/priority)。每切片首条 AC = W1 验收句(开工前自写,助教判卷通过才发建造指令)。

**技术事实(从仓库核实)**:node v24 直跑 .ts 无构建;`npm test` = vitest run;`npm run typecheck` = tsc --noEmit;src/ 目前仅占位 index.ts+index.test.ts。离线测试用录制的真实 SSE fixture(合成/脱敏);在线 smoke 单独 tag、默认不跑、需 env 密钥。harness 无自动测试 → 人工演示为验证法。

**产品/业务约束(来自 PRD,非从代码推断)**:v1 = 1:1 复刻 pi + 安全件;maxTurns=50 唯一故意偏离;密钥只 env;deepseek 直连主粮、relay qwen 第二口粮(两条线不稳是 feature)。

依赖链:loop(L1–L3)先;stream(S1–S4)与 tools(T1–T4)与 memory 前段(M1–M2)在 L3 后并行;memory 后段(M3–M4)需 S1 usage 计数;harness(H1–H3)最后。同层内按序号顺序。

---

# ⓪ loop 层

## L1 — runLoop 骨架 + AgentEvent 协议 + 场景①纯文本1圈停

- **Type**:AFK
- **Blocked by**:None — 立即开工
- **User stories**:11、13(部分)
- **What to build**:`runLoop(streamFn, tools, context, {confirm, maxTurns, clock})` 骨架。streamFn 注入假物只吐纯文本(无 toolCall)。双层 while(steering/followUp 队列不挂)。事件协议照抄 pi 10 个 AgentEvent(实测 `packages/agent/src/types.ts:428-443`)。

### AC-L1-1: W1 验收句

- Scenario:切片开工前
- Action:自写"怎么演示算完"验收句
- Expected:助教判卷通过(有不合格依据)
- Verification:人工 — 验收句文本入 plan.md 并标注判卷通过
- Priority:Required
- **验收句**:调 `runLoop` 喂一个只吐 `text_delta`、done 的 `stopReason` 非 `tool_use` 的假 streamFn,收到的 AgentEvent 序列恰为 `agent_start→turn_start→message_start→(message_update*)→message_end→turn_end→agent_end` 七段、`agent_end` 后再无 `turn_start`,且 `context.messages` 末位恰一条 assistant message 含本轮全部拼回的文本 —— 这就算 L1 完。
- **判卷**:通过(2026-09-13)— 已由 AC-L1-2 / AC-L1-3 红→绿验证(typecheck 干净、3/3 测试过、loop 源零 try/catch)

### AC-L1-2: 纯文本一轮停

- Scenario:假 streamFn 只吐 text_delta 序列(无 toolCall)
- Action:调 runLoop
- Expected:流出事件序列含 agent_start→turn_start→message_start→update→message_end→turn_end→agent_end(10 类照抄 pi);context.messages 末位一条 assistant message 含本轮全部 text;循环停止
- Must not:loop 层出现 try/catch(grep `try\s*{` 或 `catch\s*\(` 在 loop 源文件零命中)
- Verification:vitest — 喂假 text_delta 序列断言事件序列与 messages 终态
- Priority:Required

### AC-L1-3: 无 toolCall 停止判定

- Scenario:假 streamFn done 事件 stopReason 非 tool_use
- Action:调 runLoop
- Expected:turn 结束后不再开新 turn(事件流以 agent_end 收尾)
- Verification:vitest — 断言 agent_end 后无 turn_start
- Priority:Required

---

## L2 — toolCall + toolResult 回填 + 注册表缝 + 同批串行 + maxTurns 保险丝

- **Type**:AFK
- **Blocked by**:L1
- **User stories**:12、14、15(部分)

### AC-L2-1: W1 验收句

- Verification:人工 — 验收句判卷通过
- Priority:Required
- **验收句**:调 runLoop 喂假 streamFn:第 1 圈吐 toolcall_delta(done stopReason=tool_use)→ loop 按名查注册表、串行执行工具、吐 tool_execution_start/end、把 role=toolResult+toolCallId 配对回填 messages,第 2 圈纯文本停;再设 maxTurns=3 喂每圈恒 tool_use 的流 → 恰 3 个 turn_start 后 agent_end 带 reason="maxTurns"。toolCallId 不配对 / 同批并发交错 / 超 maxTurns 三者任一即判失败。
- **判卷**:通过(2026-09-13)— seams 已与用户确认(toolcall_delta 改 {id,name,arguments};Tool[] 注册表;agent_end reason?;loop 零 try/catch)

### AC-L2-2: 单次 toolCall 两圈停

- Scenario:假 streamFn 第 1 圈吐 toolcall_delta(done stopReason=tool_use),第 2 圈吐纯文本(stopReason 非 tool_use);tools 注册表含假工具 echo(args)=>args
- Action:调 runLoop
- Expected:第 1 圈 message_start→update(toolcall)→message_end→tool_execution_start→update→tool_execution_end→turn_end;第 2 圈纯文本;停。context.messages 终态含三条:user、assistant(含 toolCall id=X)、role=toolResult+toolCallId=X
- Must not:toolCallId 不匹配(assistant.toolCall.id ≠ toolResult.toolCallId 判失败)
- Verification:vitest — 断言事件序列、messages 三条、toolCallId 配对相等
- Priority:Required

### AC-L2-3: 同批多 toolCall 串行

- Scenario:假 streamFn 一圈吐两个 toolCall(A,B);两假工具各自记录执行时间戳
- Action:调 runLoop
- Expected:A 的 tool_execution_end 事件早于 B 的 tool_execution_start;无交错
- Must not:A、B 并发执行(时间戳重叠)
- Verification:vitest — 断言事件序 A.start<A.end<B.start<B.end
- Priority:Required

### AC-L2-4: maxTurns=50 保险丝

- Scenario:假 streamFn 每圈都吐 toolCall(stopReason 恒 tool_use)
- Action:调 runLoop({maxTurns:50})
- Expected:第 50 turn 后强制停,流出告知事件(含 "maxTurns"/"50" 字样);不再有 turn_start
- Must not:超过 50 turn
- Verification:vitest — 计数 turn_start 事件 = 50,断言告知事件存在
- Priority:Required

### AC-L2-5: maxTurns 可配

- Scenario:同 AC-L2-4
- Action:调 runLoop({maxTurns:3})
- Expected:第 3 turn 后停
- Verification:vitest — 计数 turn_start = 3
- Priority:Required

---

## L3 — error 进流不崩 + partial 占位 + 剩余停止条件

- **Type**:AFK
- **Blocked by**:L1
- **User stories**:7、13、15、16

### AC-L3-1: W1 验收句

- Verification:人工
- Priority:Required
- **验收句**:调 runLoop 喂假流五剧本各一例:①stream 中途吐 error 事件(stopReason=error)→ agent_end 带 reason="error"、context.messages 末位含本轮已收 partial text、`await runLoop(...)` 不 reject;②stream 吐多条 text_delta 未到 message_end → messages 末位恒 1 条 partial assistant、其 text 随 delta 累积、末位条数不增;③注入 AbortSignal 并 abort → agent_end 带 reason="aborted" 且其后无 turn_start;④一批 toolCall 中某 ToolResult.terminate=true → 该批 tool_execution_end 全完后 agent_end;⑤done 事件 stopReason=error(及 =aborted)各一例 → 该 turn 停、无后续 turn_start。五剧本任一不满足即判失败;loop 源文件零 try/catch(grep 零命中)。
- **判卷**:通过(2026-09-14)— 五剧本红→绿全过(AC-L3-2/L3-3/L3-4/L3-5/L3-6 各一 vitest);typecheck 干净;loop 源零 try/catch(grep 零命中);12/12 loop 测试绿

### AC-L3-2: 流中途 error 进流不崩

- Scenario:假 streamFn 吐 text_delta 后中途吐 error 事件
- Action:调 runLoop
- Expected:error 事件进事件流;runLoop 返回(不 throw);context.messages 含本轮已收到的 partial text
- Must not:loop 源文件出现 try/catch(grep 零命中);runLoop 不 throw 中断调用者
- Verification:vitest — 调用方 `await runLoop(...)` 不 reject;断言事件流含 error 事件
- Priority:Required

### AC-L3-3: partial 占位随 delta 替换

- Scenario:假 streamFn 吐多条 text_delta,中途未到 message_end
- Action:调 runLoop 并观察 context.messages 末位
- Expected:messages 末位恒为 1 条 partial assistant message;其 text 随 delta 累积(message_end 前快照内容 = 已收 delta 拼接)
- Must not:每个 delta 新增一条 message(末位条数恒 1)
- Verification:vitest — 每收一条 delta 后断言 messages.length 不增、末位 text 含已收 delta
- Priority:Required

### AC-L3-4: 外部 abort 信号

- Scenario:runLoop 运行中,注入外部 abort 信号
- Action:触发 abort
- Expected:当前 turn 立即停;流出 abort 相关停止事件;不再有新 turn_start
- Verification:vitest — 注入 abort,断言 agent_end 后无 turn_start
- Priority:Required

### AC-L3-5: 整批 terminate

- Scenario:某批 toolCall 中一个标 terminate
- Action:调 runLoop
- Expected:该批后停
- Verification:vitest — 断言 terminate 后 agent_end
- Priority:Required

### AC-L3-6: stopReason=error|aborted 停

- Scenario:假 streamFn done 事件 stopReason=error(或 =aborted)
- Action:调 runLoop
- Expected:该 turn 停,不再开新 turn
- Verification:vitest — stopReason=error 与 =aborted 各一例断言无后续 turn_start
- Priority:Required

---

# ① stream 层

## S1 — openai-completions 适配器 + salvage 解析 + usage 记录

- **Type**:AFK(离线 fixture)
- **Blocked by**:L1

### AC-S1-1: W1 验收句

- Verification:人工
- Priority:Required
- **验收句**:调 `createStream(deepseekConfig)` 拿到 StreamFn,喂进 `runLoop` 一段只含 `text_delta`+`done(stopReason="stop", usage={prompt_tokens,completion_tokens})` 的脱敏 SSE fixture(经假 transport 回放),收到的 ProviderEvent 序列恰为 `start→text_delta*→done`、`done.usage` 两数与 fixture 对齐;再喂一段含 `toolcall_delta`(参数分多 delta)的 fixture → 中途每条 `toolcall_delta.arguments` 非空、定稿合法时产 `done(stopReason="tool_use")`;再喂一段定稿 JSON 截断 fixture → 流出 `error` 事件且该 toolCall 无合法 `done`。三剧本任一不满足即判失败;源码零真实密钥(grep `sk-` 零命中)。
- **seams(已确认 2026-09-14)**:`createStream(config): StreamFn`(loop 缝不变,config 绑 adapter);Transport 注入缝 `deps.transport`;`ProviderEvent.done.usage?` 扩字段;`ProviderConfig={dialect,base_url,key_env,models:[{id,contextWindow}]}`;salvage 尽力解析前缀 / 定稿截断整批拒执。
- **判卷**:通过(2026-09-14)— seams 与用户确认;AC-S1-2..S1-7 红→绿验证

### AC-S1-2: 协议映射

- Scenario:录制一段 deepseek 真实 SSE(脱敏存 fixture)
- Action:`stream(config, context)` 喂 fixture
- Expected:输出 ProviderEvent 序列仅含 start/text_delta/toolcall_delta/done/error;字段与协议契约一致
- Verification:vitest — 断言事件类型集合 ⊆ 契约六类
- Priority:Required

### AC-S1-3: usage 记录

- Scenario:fixture 含 `usage:{prompt_tokens,completion_tokens}`
- Action:stream
- Expected:done 事件 payload 含 usage,prompt+completion token 数 = fixture 值
- Verification:vitest — 断言 done.usage 与 fixture 对齐
- Priority:Required

### AC-S1-4: 密钥只 env

- Scenario:config.key_env="DEEPSEEK_API_KEY"
- Action:stream
- Expected:从 process.env 读取;不在 config/仓库文件留密钥值
- Must not:任何源文件或 fixture 含真实密钥(grep `sk-`/`DEEPSEEK_API_KEY=` 赋值零命中)
- Verification:`npm run format:check`+grep;fixture 用合成 key 占位
- Priority:Required

### AC-S1-5: 厂商配置行换厂商

- Scenario:新增 glm 配置行(base_url+model+key_env)
- Action:仅改配置
- Expected:stream 走新 base_url;适配器代码无改动
- Verification:vitest — 断言配置 diff = 1 行,适配器源文件 diff = 0
- Priority:Required

### AC-S1-6: salvage 残缺尽力解析

- Scenario:fixture 的 toolcall 参数分多 delta,中途前缀不完整
- Action:stream
- Expected:toolcall_delta 实时流出已可解析前缀(UI 不空白)
- Verification:vitest — 断言中途 toolcall_delta payload 非空
- Priority:Required

### AC-S1-7: salvage 定稿截断整批拒执

- Scenario:fixture toolcall 定稿时参数 JSON 截断不可解析
- Action:stream
- Expected:流出 error 事件(标该 toolCall 拒执);不产合法 toolcall_delta done
- Must not:循环崩;拒执后 runLoop 仍返回
- Verification:vitest — 断言 error 事件 + 该 toolCall 无合法 done
- Priority:Required

---

## S2 — 重试:5xx/超时 1 次、4xx 即停

- **Type**:AFK
- **Blocked by**:S1

### AC-S2-1: W1 验收句

- Verification:人工
- Priority:Required
- **验收句**:调 `createStream(config)` 拿 StreamFn,经假 transport 四剧本各一例:①transport 第1次抛 `TransportError(503)`、第2次回放正常 SSE → 收 ProviderEvent 序列含 text_delta+done(无 error)、transport 被调恰好 2 次;②transport 恒抛 `TransportError(503)` → 流出 error 事件含 "503" 字样、`for await` 不 reject;③transport 抛 `TransportError(401)` → 不重试、transport 被调恰好 1 次、流出 error 含 "401";④transport 抛 `TransportError(isTimeout=true)` → 走重试路径(同①/②语义)。四剧本任一不满足即判失败;源零真实密钥(grep `sk-` 零命中)。
- **seams(已确认 2026-09-14)**:`withRetry(transport, retries)` 包 Transport 缝;`TransportError{status?,isTimeout?}` 区分 5xx/timeout(重试)vs 4xx(透传);`createStream` 默认包一层;`defaultTransport` 改抛 `TransportError`。
- **判卷**:通过(2026-09-14)— seams 与用户确认;AC-S2-2..S2-5 红→绿验证

### AC-S2-2: 5xx 重试 1 次成功

- Scenario:mock fetch 第 1 次 503、第 2 次 200+正常 SSE
- Action:stream
- Expected:重试 1 次,流出正常事件流
- Verification:vitest — 断言 fetch 调用 2 次、事件正常
- Priority:Required

### AC-S2-3: 5xx 二次仍败

- Scenario:mock fetch 恒 503
- Action:stream
- Expected:流出 error 事件(含 503/原因);不 throw 中断 runLoop
- Verification:vitest — 断言 error 事件、stream 不 reject
- Priority:Required

### AC-S2-4: 4xx 即停

- Scenario:mock fetch 401
- Action:stream
- Expected:不重试,立即流出 error 事件(含 401+原因)
- Must not:fetch 调用 >1 次
- Verification:vitest — 断言 fetch 调用 = 1、error 事件含 401
- Priority:Required

### AC-S2-5: 超时同 5xx

- Scenario:mock fetch 超过 timeout
- Action:stream
- Expected:走重试路径(同 AC-S2-2/S2-3)
- Verification:vitest — 超时 fixture 走重试断言
- Priority:Required

---

## S3 — anthropic-messages 第二适配器 + thinking_delta + 厂商配置行

- **Type**:AFK(离线 fixture)
- **Blocked by**:S1

### AC-S3-1: W1 验收句

- Verification:人工
- Priority:Required
- **验收句**:调 `createStream({dialect:"anthropic-messages",...})` 喂一段含 thinking 块 + text 块 + toolcall 块的脱敏 anthropic SSE fixture(经假 transport)→ 收 ProviderEvent 序列含 thinking_delta、text 块成 text_delta、toolcall 块成 toolcall_delta、收尾 done(stopReason=tool_use)、类型 ⊆ 契约六类(start/thinking_delta/text_delta/toolcall_delta/done/error);再仅改 config.dialect 为 openai-completions → `src/loop/` 源文件 diff = 0;再加一条同 anthropic 方言的厂商配置行 → 适配器源文件 diff = 0。三剧本任一不满足即判失败;源零真实密钥。
- **seams(已确认 2026-09-14)**:`createStream(config, deps)` 改派发器(dialect 分支);anthropic 解析入新文件 `src/stream/anthropic-messages.ts`,复用 salvage;thinking 块 → thinking_delta;input_json_delta 累积 → toolcall_delta;usage(input→prompt,output→completion);withRetry 两边包;S1 测试不变。
- **判卷**:通过(2026-09-14)— seams 与用户确认;AC-S3-2..S3-4 红→绿验证

### AC-S3-2: thinking_delta 映射

- Scenario:录制 anthropic SSE(含 thinking 块,脱敏)
- Action:stream(config dialect=anthropic-messages)
- Expected:thinking 块翻成 thinking_delta 事件;其余 text/toolcall 同 S1 协议
- Verification:vitest — 断言 thinking_delta 出现、事件类型 ⊆ 契约
- Priority:Required

### AC-S3-3: 上层零改动切方言

- Scenario:同一 context,仅 config.dialect 改 openai-completions↔anthropic-messages
- Action:调 stream
- Expected:runLoop/上层代码源文件 diff = 0
- Verification:git diff 上层文件 = 0
- Priority:Required

### AC-S3-4: 加厂商只配置行

- Scenario:加 glm/kimi(同方言)厂商
- Action:仅加配置行
- Expected:适配器源文件 diff = 0
- Verification:vitest + git diff — 断言源文件 0 改动
- Priority:Required

---

## S4 — 在线 smoke(deepseek)

- **Type**:HITL(需密钥、默认不跑)
- **Blocked by**:S1

### AC-S4-1: W1 验收句

- Verification:人工
- Priority:Required

### AC-S4-2: 在线 smoke 跑通

- Scenario:env 有 DEEPSEEK_API_KEY
- Action:`vitest run --tag smoke`
- Expected:deepseek 真实流;text_delta 与 toolcall_delta 均出现
- Verification:`vitest run --tag smoke` 绿(人工触发)
- Priority:Required

### AC-S4-3: 默认零网络

- Scenario:无密钥/CI
- Action:`npm test`
- Expected:不触发在线 smoke(tag 隔离);零网络调用
- Must not:`npm test` 发任何 HTTP 请求
- Verification:`npm test` 绿 + 无 fetch 到外网(可断言 mock 未命中外网)
- Priority:Required

---

# ② tools 层

## T1 — read(offset/limit/保尾截断)+ 注册表分发

- **Type**:AFK
- **Blocked by**:L2

### AC-T1-1: W1 验收句

- Verification:人工
- Priority:Required

### AC-T1-2: offset/limit 切片

- Scenario:临时文件 100 行,每行 "L<行号>"
- Action:read({path, offset:10, limit:5})
- Expected:ToolResult 返回第 10–14 行;行号/内容对齐
- Verification:vitest — 临时文件 + 断言返回行集合
- Priority:Required

### AC-T1-3: 超长保尾截断

- Scenario:临时文件远超 limit(如 10000 行)
- Action:read 不带 limit 或超大 limit
- Expected:返回保尾(末 N 行);返回体 ≤ 截断阈值(行数/字节)
- Must not:返回体超阈值(可量如 >2000 行 或 >50KB)
- Verification:vitest — 断言返回行数 ≤ 阈值且含末行
- Priority:Required

### AC-T1-4: read 放行不经确认

- Scenario:beforeToolCall hook 已实装(T2),read 调用
- Action:read
- Expected:不触发确认;直接执行返回
- Verification:vitest — 断言 confirm 未被调用(或调用即放行)
- Priority:Required

---

## T2 — edit 多锚点原子 + 校验失败回喂 + beforeToolCall 确认 hook + rules.json always

- **Type**:AFK
- **Blocked by**:L2、L3

### AC-T2-1: W1 验收句

- Verification:人工
- Priority:Required

### AC-T2-2: edit 全批命中落盘

- Scenario:文件含 "aaa" 与 "bbb";edit({edits:[{oldText:"aaa",newText:"AAA"},{oldText:"bbb",newText:"BBB"}]})
- Action:edit
- Expected:落盘后文件含 "AAA"+"BBB";ToolResult 成功
- Verification:vitest — 读写临时文件断言
- Priority:Required

### AC-T2-3: 任一锚点不命中整批失败

- Scenario:文件含 "aaa" 不含 "bbb"
- Action:edit({edits:[{oldText:"aaa",newText:"AAA"},{oldText:"bbb",newText:"BBB"}]})
- Expected:整批失败,ToolResult 为 error;文件保持原样(仍只含 "aaa",无 "AAA")
- Must not:部分落盘(无 "AAA" 写入)
- Verification:vitest — 断言文件未变 + result.error
- Priority:Required

### AC-T2-4: 参数校验失败回喂不中断

- Scenario:edit args 缺字段(schema 校验失败)
- Action:runLoop 喂假流触发该 edit
- Expected:产出 error toolResult(role=toolResult+toolCallId)回喂 messages;下一 turn 继续
- Must not:循环崩/中断
- Verification:vitest — 断言 error result 回填 + 第 2 turn 开起
- Priority:Required

### AC-T2-5: beforeToolCall 三选项

- Scenario:edit/write/bash 触发;confirm 假应答 yes/always/no
- Action:各应答一轮
- Expected:yes→执行;no→不执行返回 skipped;always→执行并落 rules
- Must not:read 触发 confirm(读类放行)
- Verification:vitest — 假 confirm 各应答断言执行/跳过
- Priority:Required

### AC-T2-6: 新工具自动过安检

- Scenario:注册一假危险工具 `rmrf`;confirm 假应答 no
- Action:runLoop 喂假流触发 rmrf
- Expected:confirm 被调用(逻辑在 hook);no→不执行
- Must not:rmrf 工具内部自带确认(证明逻辑在 loop hook)
- Verification:vitest — 断言 rmrf.run 未被调;hook 被调
- Priority:Required

### AC-T2-7: always 落 rules.json

- Scenario:对 bash 命令 `git push` 选 always,前缀 `git:*`
- Action:选 always
- Expected:项目目录 rules.json 落盘,含 {tool:"bash",prefix:"git:*"};下次 `git push` 不弹 confirm
- Verification:vitest — 断言 rules.json 存在且内容;第 2 次 confirm 未被调
- Priority:Required

### AC-T2-8: 手删即撤销 + 无全允许

- Scenario:rules.json 存在
- Action:删 rules.json 文件后再次 `git push`
- Expected:重新弹 confirm
- Must not:UI 提供"所有命令 always"选项;always 必须带 prefix
- Verification:vitest — 删文件后再触发断言 confirm 被调
- Priority:Required

---

## T3 — write 整文件 + 同文件写队列串行 + 确认过检

- **Type**:AFK
- **Blocked by**:T2

### AC-T3-1: W1 验收句

- Verification:人工
- Priority:Required

### AC-T3-2: 落盘内容

- Scenario:临时路径 path
- Action:write({path,content:"X\nY"})
- Expected:文件存在,内容字节级 = "X\nY"
- Verification:vitest — 读回断言
- Priority:Required

### AC-T3-3: 并发同文件串行

- Scenario:两批 write 同 path,内容 A 与 B
- Action:并发触发两批
- Expected:最终文件内容 = A 或 B 之一(完整),非交错损坏
- Must not:文件内容含 A/B 交错(部分 A 部分 B)
- Verification:vitest — 多次并发,断言内容 ∈ {A,B}
- Priority:Required

### AC-T3-4: write 过确认

- Scenario:confirm 假应答 no
- Action:write
- Expected:不写文件;返回 skipped
- Verification:vitest — 断言文件不存在 + result skipped
- Priority:Required

---

## T4 — bash 超时 + abort 杀进程树 + 全量落临时文件 + 保尾截断

- **Type**:AFK
- **Blocked by**:T2

### AC-T4-1: W1 验收句

- Verification:人工
- Priority:Required

### AC-T4-2: 超时杀进程树

- Scenario:bash 命令 `sleep 10`;timeout=100ms;命令派生子进程
- Action:bash
- Expected:100ms 后 abort;主进程与子进程均结束(无僵尸)
- Must not:留下运行中的 sleep 进程
- Verification:vitest — 超时后 `pgrep -f sleep` 为空(或等价断言)
- Priority:Required

### AC-T4-3: 全量输出落临时文件

- Scenario:bash 命令产生大量 stdout
- Action:bash
- Expected:ToolResult 含临时文件路径;文件含全量 stdout
- Verification:vitest — 读临时文件断言内容
- Priority:Required

### AC-T4-4: 保尾截断

- Scenario:stdout 超 2000 行或 50KB
- Action:bash
- Expected:ToolResult 内联输出保尾(末 N 行/KB);≤ 阈值
- Verification:vitest — 断言内联输出 ≤ 阈值且含末行
- Priority:Required

### AC-T4-5: bash 过确认

- Scenario:confirm 假应答 no
- Action:bash
- Expected:不执行命令
- Verification:vitest — 断言无进程产生
- Priority:Required

---

# ③ memory 层

## M1 — SessionManager + append JSONL 树 + 即时落盘 + model_change entry

- **Type**:AFK
- **Blocked by**:L1

### AC-M1-1: W1 验收句

- Verification:人工
- Priority:Required

### AC-M1-2: 落盘格式

- Scenario:SessionManager 新建会话(cwd=临时目录)
- Action:append 一条 message entry
- Expected:文件 `~/.mini/sessions/<cwd 编码>/<时间>_<uuidv7>.jsonl` 存在;首行 header {type:"session",version:1,id,cwd};第 2 行 message entry 含 id/parentId/ts/type
- Verification:vitest — 读文件断言首行 + 第 2 行字段
- Priority:Required

### AC-M1-3: message_end 即时落盘

- Scenario:append 一条 message
- Action:append 后立即读文件(不等待进程结束)
- Expected:文件已含该行(flush 到磁盘)
- Verification:vitest — append 后立即 fs.readFile 断言含该行
- Priority:Required

### AC-M1-4: entry 类型限制

- Scenario:append 一条 type="custom"(非 5 种之一)
- Action:append
- Expected:拒绝/报错;不写入文件
- Verification:vitest — 断言抛错 + 文件无该行
- Priority:Required

### AC-M1-5: model_change entry

- Scenario:切模型
- Action:append model_change entry
- Expected:落盘 type=model_change;rebuild 后 messages 反映切后模型
- Verification:vitest — 断言落盘 + rebuild 含切后模型字段
- Priority:Required

---

## M2 — rebuild 回溯 + 崩溃恢复 + 旧行永不删

- **Type**:AFK
- **Blocked by**:M1

### AC-M2-1: W1 验收句

- Verification:人工
- Priority:Required

### AC-M2-2: leaf 回溯重建

- Scenario:append 若干 entry 形成多分支(parentId 链)
- Action:rebuild() 从某 leaf
- Expected:messages = 该 leaf 沿 parentId 回溯到根的路径投影
- Verification:vitest — 构造多分支,断言 rebuild = 选中分支路径
- Priority:Required

### AC-M2-3: rebuild 喂 loop

- Scenario:rebuild 结果
- Action:把 rebuild 的 messages 喂 runLoop(假流)
- Expected:loop 接受,无类型/结构错误
- Verification:vitest — runLoop 不抛 + 正常一轮
- Priority:Required

### AC-M2-4: 崩溃恢复

- Scenario:append 一条 message 后立即模拟 kill(不再 flush 后续)
- Action:新进程 SessionManager 打开同文件 rebuild
- Expected:已 flush 的 entry 全在;无丢失
- Verification:vitest — 模拟 kill(直接读文件)断言 entry 数 ≥ 已 flush 数
- Priority:Required

### AC-M2-5: 旧行永不删

- Scenario:多次 append + compact 触发(占位)
- Action:任一操作前后比文件行数
- Expected:旧行数不减(append-only)
- Must not:任何操作删行
- Verification:vitest — 行数单调非减断言
- Priority:Required

---

## M3 — compaction 触发 + 切点 + firstKeptEntryId + 热替换

- **Type**:AFK
- **Blocked by**:M2、S1

### AC-M3-1: W1 验收句

- Verification:人工
- Priority:Required

### AC-M3-2: 触发阈值

- Scenario:context.messages 累计 usage > contextWindow − 16384(假 contextWindow=50000,假 usage=40000)
- Action:compact(summarizeFn)
- Expected:触发压缩
- Verification:vitest — 假阈值断言触发/不触发两例
- Priority:Required

### AC-M3-3: 切点 firstKeptEntryId

- Scenario:注入固定假摘要;近段累计 keepRecent=20000
- Action:compact
- Expected:写 compaction entry 含 firstKeptEntryId(=切点 entry id);rebuild 后 messages = 摘要 + 保留段 + 新行
- Must not:旧行被删(文件行数不减)
- Verification:vitest — 断言 firstKeptEntryId 值 + rebuild 结构 + 行数不减
- Priority:Required

### AC-M3-4: 切点不劈配对

- Scenario:构造 toolCall/toolResult 配对横跨候选切点
- Action:compact
- Expected:切点下移到配对之前(不劈开);保留段含完整配对
- Verification:vitest — 断言切点在配对前、保留段 toolCall/toolResult 成对
- Priority:Required

---

## M4 — 纪要七段 + 二次压缩增量合并 + 旧段超窗拒压

- **Type**:AFK
- **Blocked by**:M3

### AC-M4-1: W1 验收句

- Verification:人工
- Priority:Required

### AC-M4-2: 纪要七段中文

- Scenario:summarizeFn 注入返回固定七段中文
- Action:compact
- Expected:纪要含七段:目的/做到哪了/关键要点/引用文件/关键决定/下一步/关键背景;中文
- Verification:vitest — 断言纪要含七段标题
- Priority:Required

### AC-M4-3: 二次压缩增量合并

- Scenario:已有一份纪要;再 compact
- Action:第二次 compact
- Expected:旧纪要 + 新段 → 合并为一份纪要(恒一份);不堆叠两份
- Must not:产生多份纪要 entry
- Verification:vitest — 断言纪要 entry 数 = 1、含合并内容
- Priority:Required

### AC-M4-4: 旧段超窗拒压

- Scenario:旧段本身 token 超过窗口(无法保留+摘要)
- Action:compact
- Expected:拒压;流出 error 事件/报错提示手动处理
- Must not:静默删旧行;静默压
- Verification:vitest — 断言 error + 行数不减
- Priority:Required

### AC-M4-5: summarizeFn 注入零网络

- Scenario:测试
- Action:compact(summarizeFn=假函数)
- Expected:测试不发网络调用
- Verification:vitest — 无 fetch mock 命中
- Priority:Required

---

# ④ harness 层

## H1 — cli 组装 + 裸 readline + 流式 stdout(thinking 淡显)

- **Type**:HITL(人工演示,无自动测试)
- **Blocked by**:L3、S1、T4、M2

### AC-H1-1: W1 验收句

- Verification:人工
- Priority:Required

### AC-H1-2: 流式逐字打印

- Scenario:`mini` 启动(配 deepseek)
- Action:输入"说 hello",回车
- Expected:终端逐字流出回复(非整块);thinking 段淡色显示
- Verification:人工演示 — 截图/录屏逐字流出
- Priority:Required

### AC-H1-3: harness 无业务逻辑

- Scenario:harness 源文件
- Action:静态审阅
- Expected:harness 只含组装 + readline + stdout;无 loop/compaction/校验逻辑
- Verification:人工 + grep — harness 不含 runLoop/compact/schema 关键字
- Priority:Required

---

## H2 — flags:--model 选/热切 + --continue + --resume

- **Type**:HITL
- **Blocked by**:H1、M1

### AC-H2-1: W1 验收句

- Verification:人工
- Priority:Required

### AC-H2-2: --model 启动

- Scenario:`mini --model glm`
- Action:启动 + 输入消息
- Expected:走 glm 配置;回复流出
- Verification:人工演示 — 走 glm base_url(可配合日志)
- Priority:Required

### AC-H2-3: 会话内热切 + resume 恢复

- Scenario:会话中切到 glm
- Action:热切 → 退出 → `mini --resume` 选该会话
- Expected:model_change entry 落盘;resume 后使用切后模型(glm)
- Verification:人工演示 + 查 jsonl 含 model_change
- Priority:Required

### AC-H2-4: --continue 接最近

- Scenario:有历史会话
- Action:`mini --continue`
- Expected:进入最近会话;历史可读、可续聊
- Verification:人工演示 — 续聊上下文连贯
- Priority:Required

### AC-H2-5: --resume 列编号

- Scenario:多个历史会话
- Action:`mini --resume`
- Expected:列出编号清单;选号进入该会话
- Verification:人工演示 — 列表 + 选号进入
- Priority:Required

---

## H3 — /compact 手动触发 + systemPrompt 组装

- **Type**:HITL
- **Blocked by**:H1、M4

### AC-H3-1: W1 验收句

- Verification:人工
- Priority:Required

### AC-H3-2: /compact 触发

- Scenario:会话中
- Action:输入 `/compact`
- Expected:触发压缩;compaction entry 落盘;后续消息用压缩后 messages(上下文仍连贯)
- Verification:人工演示 + 查 jsonl 含 compaction entry(firstKeptEntryId)
- Priority:Required

### AC-H3-3: systemPrompt 组装

- Scenario:cwd 含 AGENTS.md 或 CLAUDE.md(上层目录)
- Action:`mini` 启动
- Expected:发给 provider 的 system prompt 含:固定骨架 + 工具清单 + `<project_instructions>` 包裹的项目上下文
- Verification:人工 — 抓取发出的 system prompt(日志/mock)断言三部分存在
- Priority:Required

### AC-H3-4: 项目上下文向上近者优先

- Scenario:cwd=/a/b/c;/a/CLAUDE.md 与 /a/b/AGENTS.md 都存在
- Action:启动
- Expected:用 /a/b/AGENTS.md(近者)
- Verification:人工 — 日志显示近者文件内容
- Priority:Required

### AC-H3-5: 工具集变即重建

- Scenario:工具集从 [read] 变 [read,edit]
- Action:变更后下一 turn
- Expected:system prompt 工具清单含 edit(重建)
- Verification:人工 — 比对两次 system prompt 工具段
- Priority:Required

---

## 元工作流(跨切片,不单独发 issue)

- W1:每切片开工前自写验收句、助教判卷、不过不许发建造指令 → 已写进每切片首条 AC
- W2:S1–S4 测试缝(harness 纯人工)→ 各切片 AC 已标 verification
- W3:砍掉功能 + 加回路径写 `docs/DEFERRED.md` → 已存在,随砍随补

## 切片汇总(18 条)

| 层        | 切片                             | Type | Blocked by  | 主验证法                     |
| --------- | -------------------------------- | ---- | ----------- | ---------------------------- |
| ⓪ loop    | L1 骨架+协议+场景①               | AFK  | None        | vitest                       |
| ⓪ loop    | L2 toolCall+回填+串行+maxTurns   | AFK  | L1          | vitest                       |
| ⓪ loop    | L3 error+partial+剩余停止        | AFK  | L1          | vitest                       |
| ① stream  | S1 openai+salvage+usage          | AFK  | L1          | vitest(离线 fixture)         |
| ① stream  | S2 重试 5xx/4xx                  | AFK  | S1          | vitest(mock fetch)           |
| ① stream  | S3 anthropic 适配器              | AFK  | S1          | vitest(离线 fixture)         |
| ① stream  | S4 在线 smoke                    | HITL | S1          | vitest --tag smoke(人工触发) |
| ② tools   | T1 read+注册表                   | AFK  | L2          | vitest                       |
| ② tools   | T2 edit+确认hook+rules.json      | AFK  | L2,L3       | vitest                       |
| ② tools   | T3 write 串行                    | AFK  | T2          | vitest                       |
| ② tools   | T4 bash+abort                    | AFK  | T2          | vitest                       |
| ③ memory  | M1 append+即时落盘+model_change  | AFK  | L1          | vitest                       |
| ③ memory  | M2 rebuild+崩溃恢复              | AFK  | M1          | vitest                       |
| ③ memory  | M3 compaction 触发+切点          | AFK  | M2,S1       | vitest                       |
| ③ memory  | M4 纪要七段+增量合并             | AFK  | M3          | vitest                       |
| ④ harness | H1 cli 组装+readline             | HITL | L3,S1,T4,M2 | 人工演示                     |
| ④ harness | H2 flags --model/continue/resume | HITL | H1,M1       | 人工演示                     |
| ④ harness | H3 /compact+systemPrompt         | HITL | H1,M4       | 人工演示                     |

## 可验证性自检(pass/fail rubric)

- [x] 每条 Required AC 含 scenario / action / expected / verification(四要素)
- [x] 模糊词("正确""不崩""对得上")替换为可观察证据(事件序列/字段值/grep/行数/文件内容)
- [x] 产品约束(maxTurns=50、密钥 env、主/副口粮)标为来自 PRD,非从代码推断
- [x] scope 显式(每切片 What to build + Out = DEFERRED.md)
- [x] HITL 切片(harness + 在线 smoke)用人工演示为验证法,不强行自动化
- [x] 密钥/真实 payload 不入 AC,fixture 用合成值
