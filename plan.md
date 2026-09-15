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
- **验收句**:runLoop 注册表含 read,假流吐 toolCall `read{path,offset:10,limit:5}` → 回填 toolResult 恰含第 10–14 行且行号/内容对齐(`N\t内容`);10000 行文件 `read{path}` 不带 limit → 返回 ≤2000 行且 ≤50KB、含末行、首行有截断提示;两路均不经确认直接执行(read 放行,确认 hook 归 T2)。任一不满足即判失败。

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

## T2 — edit 多锚点原子 + 校验失败回喂 + beforeToolCall 分层确认门 + rules.json always

- **Type**:AFK
- **Blocked by**:L2、L3
- **修订(2026-09-15 / C8)**:本节原写"首词前缀 `git:*` + 三选项 confirm"。C1–C7(`docs/ISSUES.md`)把确认门重做成**分层流水线**,规则语义与 confirm 契约都变了 —— 按实现重写。分层细粒度 AC 与测试锚点住 ISSUES.md,本节只钉总缝、不变式、W1 人工剧本。旧 AC-T2-1 的假流六剧本不再由人工跑:它已被 vitest(registry/rules/danger/readonly/bash-parse 等 283 例)接管,新 AC-T2-1 = 真机人工六幕。

### 确认门分层流水线(总缝,`src/loop/run-loop.ts` 确认门段)

顺序即契约:**工具分级 → 参数解析 → 危险黑名单 → allow 判定(只读表 ∪ rules ∪ session ∪ 模式开关)→ 弹窗兜底**。黑名单在 allow 之前,任何 allow 都不得豁免它。

| #   | 层                       | 判据(实现原语)                                                                                                   | 落点                                                                     | 出处        |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------- |
| 1   | 工具分级                 | `Tool.skipConfirm`(read 置 true)直通;缺省 false = 新工具自动过安检                                               | `src/tools/tool.ts`                                                      | T2 原始     |
| 2   | 参数解析                 | `matchOf(args)` = 完整待执行事实(bash 给整条命令、文件类给 `path:`+路径);缺省 `JSON.stringify(args)`             | `src/tools/{bash,write,edit}.ts`                                         | C2          |
| 2b  | shell 拆段               | `matchKind:"shell"` → `bashParse` 按 `&&` `\|\|` `;` `\|` 换行拆段;未闭合引号/反引号/`$()` 未闭合 = `{ok:false}` | `src/loop/bash-parse.ts`(纯叶)                                           | C3          |
| 3   | 危险黑名单               | `dangerOfShell(整条, cwd)` / `dangerOfPath(path 域)`;命中 = 必弹 + 弹头 `⚠ <原因> — ` + 无第三行 + 答 3 亦不落盘 | `src/loop/danger.ts`(纯叶)                                               | C5          |
| 4a  | allow:内置只读表         | `readOnlyParsed(parsed)` → 免弹且**不产规则**(不进 `writable`)                                                   | `src/loop/readonly.ts`(数据表住 loop 侧,不放工具、不被 rules.json 覆盖)  | C4          |
| 4b  | allow:持久规则 + session | `rules ∪ sessionRules` 过 `ruleMatches`;shell 类**逐段**过检,任一段不命中即弹(展示完整原命令)                    | `src/loop/rules.ts`(token 家族 / `path:` glob / 整串相等)                | C1+C2+C3+C6 |
| 4c  | allow:模式开关           | `autoAcceptEdits` 且 `matchKind:"path"` 且种子为 cwd 内相对 `path:`;bash 不适用                                  | `RunLoopOptions.autoAcceptEdits` ← `--auto-accept-edits`                 | C7          |
| 5   | 弹窗兜底                 | 四档 `1 yes / 2 session / 3 always / 4 no[ 理由]`;第三行印**将落盘的确切规则**                                   | `ConfirmAnswer`(loop/types)+ `mapConfirm`(harness/tui,plain 与 TUI 共用) | C6          |

其他实现钉死项:`options.confirm` 缺省 = 放行(测试/嵌入方零确认);`rulesPath` 缺省 = 不读写 rules(always 退化一次性 yes);`*` / 空 / `:*` 种子 `isValidSeed` 双端拒(写侧滤 + 读侧滤);解析失败(`ok:false`)→ 必弹且 `writable` 为空;no → `tool_execution_start/end` 仍配对,result `isError:true` + `user rejected: <tool>[ — <理由>]` 回喂续转;`node:fs` 回调形态读写(不 throw,守 loop 零 try/catch)。

### AC-T2-1: W1 验收句(六幕,人工真机跑)

- Verification:人工 —— 真 provider + 真 TUI(`process.stdout.isTTY`),非假流
- Priority:Required
- **跑前准备**

  ```bash
  rm -rf /tmp/w-c8 && mkdir -p /tmp/w-c8 && cd /tmp/w-c8
  git init -q && echo seed > seed.txt && git add -A && git -c user.email=t@t -c user.name=t commit -qm init
  node ~/project/mini/src/harness/cli.ts        # rules.json 落 /tmp/w-c8/(生产 = <cwd>/rules.json)
  ```

- **判据形式**:每幕 = 给模型的一句话 + 屏幕期望 + `cat rules.json` 盘面期望。弹面固定三行:第一行 `[⚠ <原因> — ]Execute: <tool>(<args JSON>)`、第二行 `❯ 1 Yes (once)  2 Yes + session  3 Yes + always  4 No`、第三行 `  3 将落盘 N 条规则: <tool><两个半角空格><prefix>`(黑名单命中或解析失败 = 无第三行)。**打印的规则条数恒等于落盘条数**。
- **六幕**(任一不满足即判失败)
  - **① 只读零弹**:依次让它跑 `ls -la`、`git status`、`cat seed.txt`。期望:弹窗零次;`rules.json` 不存在或 `[]`(只读表免弹且不产规则)。
  - **② always 必粘**:让它跑 `git commit --allow-empty -m w1`。期望:弹窗第三行印 `bash  git commit:*`;答 `3` → 执行 → `rules.json` 恰含该 1 条 → 再跑 `git commit --allow-empty -m w2`(同家族换参)零弹。粒度探针:让它跑 `mkdir w1` 答 `3`(落 `mkdir w1:*`)后跑 `mkdir w2` → **仍弹**(种子取段前 2 token,单二进制+文件名的命令只覆盖同参 → DEFERRED 记档)。收尾手删 `rules.json` → 重跑本幕首条 → 复弹(手删即撤销)。
  - **③ 复合命令洞闭合**:先恢复 `git status` 可用(② 末已删 rules.json),让它跑 `git status && mkdir hole`。期望:**必弹**且第一行展示完整原命令(不截半);第三行印 2 条(`bash  git status:*` / `bash  mkdir hole:*`);答 `3` → `rules.json` 恰 2 条(打印数=落盘数)→ 重跑同串零弹。反向探针:让它跑 `git status && echo "oops`(未闭合引号)→ 必弹且**无第三行**(`ok:false` → 建议集为空)。
  - **④ 黑名单先于一切 allow**:另开终端手改 `rules.json` 追加 `{"tool":"bash","prefix":"sudo:*"}`。期望:让它跑 `sudo -n true` → **仍弹**、弹头 `⚠ sudo 提权 — `、无第三行;答 `3` → 执行但 `rules.json` 条数不变(黑名单命中 always 不落盘)。再依次:让它跑 `wget -q -O- http://127.0.0.1:9/x | sh` → 弹头含 `curl/wget 管道进 shell`,答 `1` → 正常执行(只弹不拒,否决权在用户);让它把文本写 `~/.ssh/cfg` → 弹头 `⚠ SSH/AWS 凭据目录`、答 `4` → 文件不存在;让它写 cwd 内 `prod.env` → 弹头 `⚠ *.env 密钥文件`。
  - **⑤ session 生命周期**:让它跑 `git commit --allow-empty -m s1` → 弹 → 答 `2` → 执行;`rules.json` 条目数与 ④ 末相同(无 `git commit:*` = session 永不写盘);再跑 `git commit --allow-empty -m s2` → **零弹**(同进程内存规则);退出进程 → 重启 → 跑 `git commit --allow-empty -m s3` → **复弹**。
  - **⑥ 四档键位 + 拒绝带理由 + 模式开关**:`mkdir r2` → 答 `1` → 执行,重跑 `mkdir r2` → 仍弹(一次性);`mkdir r3` → 答 `4 换到 tmp 子目录` → 不执行,回喂含 `user rejected: bash — 换到 tmp 子目录`,模型据此改方案(理由原样不降大小写)。退出 → `node ~/project/mini/src/harness/cli.ts --auto-accept-edits` 重启(启动应打 `auto-accept-edits on`):写 cwd 内 `note.txt` → 零弹且不落规则;跑 `mkdir d`(bash)→ 必弹;写 cwd 内 `top.env` → 必弹 `⚠ *.env 密钥文件`(黑名单压过开关);写 `/tmp/w-c8-out.txt`(cwd 外)→ 必弹。
- **判卷**:待跑(2026-09-15 剧本定稿,六幕待人工执行;自动化侧基线 = vitest 283 passed / 1 skipped,typecheck + eslint + prettier 干净)

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

### AC-T2-5: beforeToolCall 四档应答

- Scenario:edit/write/bash 触发;confirm 假应答 `yes` / `session` / `always` / `no`(no 可带 `reason`)
- Action:各应答一轮
- Expected:`yes`→执行不记规则;`session`→执行且规则进 `options.sessionRules`(同进程免弹、零落盘);`always`→执行且落 `rulesPath`;`no`→不执行,`isError` 回喂 `user rejected: <tool>`,带 `reason` 则原文附在后面
- Must not:read 触发 confirm(`skipConfirm`);任一档写盘失败即崩(落盘是优化,丢了下轮重弹 = 安全默认)
- Verification:vitest — registry.test.ts C6 组 + run-loop.test.ts;键位→档位映射 `mapConfirm` 有测(tui.test.ts),plain 与 TUI 共用同一映射
- Priority:Required

### AC-T2-6: 新工具自动过安检

- Scenario:注册一假危险工具 `rmrf`(未声明 `skipConfirm`、未声明 `matchKind`);confirm 假应答 no
- Action:runLoop 喂假流触发 rmrf
- Expected:confirm 被调用(逻辑在 loop hook);no→不执行;`matchOf` 缺省时判据 = `JSON.stringify(args)` 整串相等
- Must not:rmrf 工具内部自带确认(证明逻辑在 loop hook);rmrf 因"看着像只读"被 C4 表放行 —— 白名单只作用于 `matchKind:"shell"`,非 shell 工具 `parsed === null` 恒不适用
- Verification:vitest — registry.test.ts AC-T2-6 + C4 AC-4
- Priority:Required

### AC-T2-7: always 落盘种子形状

- Scenario:对 bash 段 `git commit -m x` 答 `always`;对 write 目标 `src/loop/x.ts` 答 `always`
- Action:答 always(`danger === null` 前提下)
- Expected:落盘 `{tool:"bash",prefix:"git commit:*"}`(shell 类 = 段前 2 token 家族,`seedOf`;复合命令每段一条)与 `{tool:"write",prefix:"path:src/loop/x.ts"}`(文件类 = cwd 内规范化相对路径;建议目录级 glob 时形如 `path:src/loop/**`,`*` 不跨 `/`、`**` 跨);下次同判据不弹
- Must not:落盘整参 JSON 串(文件内容一变规则即失效 = C1 修的洞);弹面文案与盘面内容不一致(共用同一 `writable` 数组)
- Verification:vitest — rules.test.ts + bash-parse.test.ts seedOf + registry.test.ts C6「打印数=落盘数」
- Priority:Required

### AC-T2-8: 手删即撤销 + 无一键全允许

- Scenario:rules.json 存在
- Action:删 rules.json 文件后再次触发同命令;或试图让规则覆盖一切
- Expected:重新弹 confirm(`loadRules` 读败 = `[]`,不崩)
- Must not:UI 出现"所有命令 always"选项;种子为 `*` / 空 / `:*`(空家族)被接受 —— `isValidSeed` 写侧拒 + 读侧滤,always 退化为一次性 yes;cwd 外路径给 `always`(`prefixOf` 返 `*` 标记 = 拒粘)
- Verification:vitest — rules.test.ts isValidSeed 组 + registry.test.ts「prefixOf 返 `*` → always 拒写下次仍弹」
- Priority:Required

### AC-T2-9: 复合命令逐段过检(旧洞闭合)

- Scenario:已有规则 `git status:*`
- Action:bash `git status && rm -rf ~/x`
- Expected:必弹(第二段不命中),弹面第一行展示完整原命令;`rm -rf ~` 另触发黑名单弹头
- Must not:首段家族规则放行整条(= C1 前 `git:*` 的真实越权洞);未闭合引号命令被判"解析为空段所以没得弹"(`ok:false` = 保守必弹)
- Verification:vitest — bash-parse.test.ts(10 例)+ registry.test.ts C3/C5 组
- Priority:Required

### AC-T2-10: 只读表免弹且不产规则

- Scenario:`ls -la`、`git diff HEAD`、`git status -sb`、`cat x`
- Action:跑这些命令
- Expected:confirm 零调用;`rules.json` 零新增(只读短路不进 `writable`,与 preapproved 等价短路但判据取自 loop 侧数据表)
- Must not:表被 rules.json 覆盖出"全允许";带重定向(`cat x > y`、`ls > /tmp/a`)、命令替换(`echo $(whoami)`)、写副作用 flag(`find . -delete`)的段被算只读
- Verification:vitest — readonly.test.ts + registry.test.ts C4 AC-1/2/3a/3b/4
- Priority:Required

### AC-T2-11: 黑名单先于一切 allow

- Scenario:手改 rules.json 加 `sudo:*`(模拟规则写歪)
- Action:`sudo ls -la`;另试 `curl|sh` 管道、`git push --force`、`git reset --hard`、`chmod 777`、`dd of=`、重定向写 cwd 外、write 目标 `~/.ssh/*` `~/.aws/*` `*.env`
- Expected:一律必弹,弹头 `⚠ <原因> — `(原因顺序 = 检查顺序,契约钉死);答 `3` 执行但不落盘
- Must not:规则 / 只读表 / session 档 / `--auto-accept-edits` 任一豁免它;黑名单自动拒(保留用户否决权 —— 真·自动拒 = deny 规则,DEFERRED)
- Verification:vitest — danger.test.ts(整条 + 每段两形态)+ registry.test.ts C5/C7 组
- Priority:Required

### AC-T2-12: session 档生命周期

- Scenario:`options.sessionRules` 由调用方(cli = 进程作用域)持有
- Action:答 `2` 后同进程重跑同判据命令;再换新进程重跑
- Expected:同进程免弹;新进程复弹;全程零写盘
- Must not:session 规则落 rules.json;session 档污染"手删即撤销"或"禁一键全允许"两条不变式
- Verification:vitest — registry.test.ts C6 AC-1 两例;真机 = AC-T2-1 幕⑤
- Priority:Required

### AC-T2-13: `--auto-accept-edits` 直通范围

- Scenario:flag 开
- Action:连续 cwd 内 write/edit;cwd 外 write;任意 bash;cwd 内 `secret.env`
- Expected:仅 `matchKind:"path"` 且种子为 cwd 内相对 `path:` 且黑名单未命中 → 直通且不落新规则
- Must not:豁免 bash;豁免黑名单(内层 `secret.env` 仍弹);豁免 cwd 外路径;flag 缺省时行为与关 flag 逐字等价(缺省 false = 零新分支)
- Verification:vitest — registry.test.ts C7 组 + run-loop.test.ts;启动打 `auto-accept-edits on` note 显式来源
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
- **验收句**:直接调 `bashTool.run({command:"sleep 99999", timeout:100})` → ≈100ms 返回 isError:true 且含超时字样,返回后 `pgrep -f "sleep 99999"` 为空(shell 与其子 sleep 皆亡 = 杀进程树,非只 kill 壳);再调 `bashTool.run({command:"seq 1 6000"})` → ToolResult 内联文本 ≤2000 行且 ≤50KB、含末行 `6000` 与截断提示、并含临时文件路径,读该文件 = 全量 6000 行;再把真 bashTool 喂进 runLoop、confirm 恒应答 "no" → 命令 `touch <tmp>/marker` 未执行(marker 不存在),且 loop 回喂 toolResult = T2 既有拒绝语义(isError:true、文本含 "user rejected",run-loop.ts:198)。三剧本任一不满足即判失败。
- **判卷**:通过(2026-09-14)— seams 与用户确认;AC-T4-2/3/4 各自红→绿,AC-T4-5 真 bashTool 回归绿(T2 门既有,新行为 = 不置 skipConfirm 自动过检);typecheck 干净;全量 64 passed + 1 skipped(smoke)
- **seams(已确认 2026-09-14)**:`bashTool: Tool`(src/tools/bash.ts,同 read/write 走 Tool 公共接口 types.ts:110);`run({command, timeout?}, signal?)` — 工具内部 AbortController 管 timeout,与 loop 透传的 signal 合并,任一触发 → 杀进程树;杀法 = POSIX 进程组(spawn detached + `process.kill(-pid)`,项目 WSL-only 成立);全量 stdout+stderr 合流落 `os.tmpdir()` 临时文件,路径写进 ToolResult 文本;保尾截断复用 read.ts 同一 `tailTruncate`(导出共享,阈值单源);不置 skipConfirm → 自动过 loop 确认门。**种子抽取(2026-09-15 C8 校正)**:原记"`prefixOf` = 命令首 token `:*`"自 C2/C3 起不再决定落盘 —— bash 声明 `matchOf` = 整条命令 + `matchKind:"shell"`,loop 拆段后用 `bash-parse.seedOf`(段前 2 token)逐段落盘;`prefixOf` 保留首 token 式仅作 `matchKind` 缺省时回退,当前不可达(死声明,清理候选)。

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
- **验收句**:调 `new SessionManager({baseDir:临时目录, cwd})` 后 append 一条 message entry → `baseDir/<cwd编码>/<时间>_<uuidv7>.jsonl` 存在,首行 header {type:"session",version:1,id,cwd}、第 2 行 entry 含 id/parentId/ts/type/payload;append 返回后立读文件已含新行(不关句柄、不重开);再 append model_change(payload 含切后模型)→ 该行落盘且 `rebuild().model` = 切后模型;append type="custom" → 抛错且文件行数不变。四剧本任一不满足即判失败。
- **判卷**:通过(2026-09-14)— seams 与用户确认:M1 含最小线性 rebuild(顺序投影;多分支 leaf 回溯留 M2)
- **验证**:AC-M1-2/3/4/5 红→绿(AC-M1-3/4 即时绿 = 回归护栏,红只在 AC-M1-2 parentId 顺序 bug 与 AC-M1-5 rebuild 缺失两处真红);typecheck 0;eslint src/memory 0 问题;prettier 干净;全量 68 passed + 1 skipped(smoke)

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
- **验收句**:同一 jsonl 内 `append` 传 `parentId` 造多分支 → `rebuild(leafId)` = 该 leaf 沿 parentId 回溯到根的路径投影(兄弟分支一行不见;`model` 取路径上末条 model_change,不取文件末行),`rebuild()` 不传参 = 最新 leaf;append 两条后丢弃实例(模拟 kill)→ `SessionManager.open({baseDir,cwd})` 接回同一文件,已 flush entry 全在、不新建文件、续写行 parentId 指回 kill 前 leaf;末行为半截 JSON 时 open 截回最后一个换行(已提交行一条不丢),非末行坏 JSON 则 rebuild 抛错;rebuild 结果直喂 `runLoop(假流)` 跑完一轮无错;全程文件行数只增不减、旧行逐字不变。五剧本任一不满足即判失败。
- **判卷**:通过(2026-09-14)— seams 与用户确认:分支 = `append` 可选 `parentId`(不另开 fork);重开 = 静态 `open({sessionId?})`(缺省最新 = `--continue`,给定 = `--resume`);torn 末行 = open 时截到末换行(半行从未提交成 entry,不算"删旧行"),中间坏行抛错报真损坏;未知 leafId 抛错(静默返空会被 H1 当空会话续写)
- **验证**:AC-M2-2/3/4/5 红→绿。真红 5 处:线性投影读到兄弟分支、`open is not a function`、torn 末行 `Unterminated string in JSON at position 41`、`sessionId` 被忽略、未知 leaf 静默返空;即时绿 3 处 = 回归护栏(model 走路径末条、中间坏行抛、M2-3 喂 loop 类型直通过)。附带修一个自造 flake:文件名时间戳只到秒,同秒两会话"最新"随 uuid 字典序翻转 → open 改以 mtime 定最新(名字兜底)。typecheck 0;eslint src/memory 0 问题;prettier 干净;全量 77 passed + 1 skipped(smoke),6 连跑稳定
- **遗留**:`rebuild()` 默认 leaf = 文件末行 entry(最新写入者);多分支下"活跃 leaf"由实例内 leafId 与磁盘末行共同决定,切 leaf/`getTree()` 交互仍在 DEFERRED(v2 UI)

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
- **验收句**:同一会话 append 消息+带 usage 的 assistant → `compact({contextWindow,summarizeFn})`:累计 usage > contextWindow−16384 触发、未超返回 null 零副作用(summarizeFn 不调用、文件不动);触发时从近往远按 `tokenOf` 累计 keepRecent(默认 20000)定刀口,写 compaction entry(payload={summary,firstKeptEntryId}),刀口若落 toolResult 则回退到配对 assistant(保留段成对);`rebuild()` = 摘要(user 角色)+保留段+新行;全程旧行逐字不删。四剧本任一不满足即判失败。
- **判卷**:通过(2026-09-14)— seams 与用户确认:compact 挂 `SessionManager`(PRD memory 行三缝之一);阈值不满足返回 null 零副作用(手动 /compact 的 force 路径留 H2);摘要投影 = user 角色消息(零类型改动);tokenOf 注入、默认 chars/4 启发(精确 token 数无本地 tokenizer)
- **验证**:AC-M3-2/3/4 红→绿。真红 3 处:`sm.compact is not a function`、`firstKeptEntryId: null`(切点未算)、刀口劈配对(期望 assistant id 实得 toolResult id);即时绿 0(全新增行为)。另修两处自造测试 bug:行数断点少算 header、heredoc 反引号被外层 bash 吞(改用 Write+cat 追加)。typecheck 0;eslint src/memory 0 问题;prettier 干净;全量 80 passed + 1 skipped(smoke)

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

- Scenario:切片开工前
- Action:自写"怎么演示算完"验收句
- Expected:助教判卷通过(有不合格依据)
- Verification:人工 — 验收句文本入 plan.md 并标注判卷通过
- Priority:Required
- **验收句**:同一会话调 `compact({contextWindow,summarizeFn,keepRecent,tokenOf})` 四剧本:①注入假 summarizeFn 返回固定七段中文(目的/做到哪了/关键要点/引用文件/关键决定/下一步/关键背景)→ compaction entry payload.summary 含全部七段标题、rebuild 投影摘要行含全部七段,且源码 `SUMMARY_SECTIONS` 常量 = 七段标题单源、`buildSummarizePrompt()` 产物含七段标题、`buildSummarizePrompt(旧纪要)` 产物另含"旧纪要"文本与"合并"UPDATE 指令;②首次 compact 后再 compact → summarizeFn 第二次调用收 `previousSummary` = 首轮纪要文本、`toSummarize` 不含首轮被弃消息(= 首轮刀口后新入弃段);rebuild 摘要行恒 1(末次产物)、盘上 compaction entry = 2 条、旧行逐字不变;③最近单条 `tokenOf` > keepRecent → compact 抛 Error(含"手动处理"字样)、summarizeFn 零调用、文件行数不变;④全程 `globalThis.fetch` spy 零调用。四剧本任一不满足即判失败;源零真实密钥(grep `sk-` 零命中)。
- **seams(已确认 2026-09-14)**:新文件 `src/memory/summarize-prompt.ts` 导出 `SUMMARY_SECTIONS`(七段单源)+ `buildSummarizePrompt(previousSummary?)`(生产 LLM 指令文本,上层拿去配流生成;compact 自身零网络);`summarizeFn` 扩参 `(toSummarize, previousSummary?)`(TS 少参函数可赋值,M3 既有注入向后兼容)——compact 取路径末条 compaction entry 的 summary 为 previousSummary,`toSummarize` = 末条 compaction 之后、刀口之前的 message(旧弃段不重发),合并由 LLM UPDATE 式完成、compact 不拼字符串;触发 usage 计数改 = 末条 compaction 后窗口(投影口径,M3 测试无 compaction 行不受影响);拒压 = 无有效刀口(最近单条 > keepRecent,M3 注释预留 `cut===path.length` 路径)→ throw,分段兜底进 DEFERRED;rebuild 多 compaction 折叠投影天然纪要恒一,零改动。
- **判卷**:通过(2026-09-14)— 四剧本验收句 + seams 与用户确认
- **验证**:AC-M4-2/3/4/5 红→绿。真红 4 处:`Failed to load url ./summarize-prompt.js`、`calls[1].prev` 恒 undefined(单参调用)、二轮 `toSummarize` 重发首轮弃段(无 floor 概念)、拒压报错文案缺"手动处理"。即时绿 1 处 = 回归护栏(AC-M4-5 fetch spy,零网络是注入设计属性)。自造测试 bug 2 处修正:AC-M4-2 初版用默认 tokenOf(chars/4)过小落入 M3 全弃路径(断言 2 得 1)、AC-M4-3 初版切点累计算错一位。附带 seams 内行为修正:触发口径 = 全路径 usage 累计 → floor 窗内末条 assistant usage(provider 精确数;否则旧大 usage 常驻致压缩永不收敛;M3 测试均单 assistant 兼容)。typecheck 0;eslint src/memory 0 问题;prettier 干净;全量 84 passed + 1 skipped(smoke);grep `sk-` 仅 S1 测试注释引用规则本身,零真实密钥
- **遗留**:①巨大单条(> keepRecent)的分段兜底 = DEFERRED(M3 已录);②firstKeptEntryId 指向非 message 行时 rebuild indexOf=-1 全折的 M3 潜在边缘未动(M4 范围外);③生产 summarizeFn(拿 buildSummarizePrompt 配同模型流)= H3 接线

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
- **验收句**:`node src/harness/cli.ts`(H1 只一行配置 = deepseek-chat,密钥读 `DEEPSEEK_API_KEY`,会话落 `~/.mini/sessions/`)启动后输入"用 read 读 package.json 前 3 行,然后说 hello":thinking 段以 ANSI dim 逐字流出、正文逐字流出(非整块,`message_update` 快照只补新增后缀),write/edit/bash 调用前打确认(2026-09-15 C8 校正:C6 起为四档 `❯ 1 Yes (once)  2 Yes + session  3 Yes + always  4 No` + 将落盘规则行,plain 模式追加 `(1/2/3/4) ❯`;建卡时为三选项)、read 与只读表命中放行,一轮结束回到 `>` 可续问;每 `message_end` 即时 append 一行 jsonl;provider 报错(如 401)必须在 stdout 可见(`[error] ...`)而非静默或栈崩;`src/harness/` 只有 cli.ts + renderer.ts,除组装外零 loop/校验/压缩逻辑 —— 这就算 H1 完。
- **seams 与用户确认**:renderer = 唯一自动缝(`createRenderer(write)` 返回 `(event) => void`,数组 sink 断 ANSI 串),harness 其余照 DECISIONS W2 纯人工;`RunLoopOptions.confirm` 放宽为可返回 Promise(`run-loop.ts:195` 加 `await`,同步实现零改动);4 真工具补 `description`,read/bash 另补 `schema`(provider 的 `parameters` 单源 = `tool.schema`,harness 只做形态搬运);全仓 import specifier `.js` → `.ts` + tsconfig `allowImportingTsExtensions`(node v24 实测不回解 `.js`→`.ts`,`ERR_MODULE_NOT_FOUND`,G4 补注);`SessionManager.open` 首次运行(目录不存在)= 返回空历史而非抛,显式 `sessionId` 找不到仍抛。
- **验证**:renderer 4 测(后缀增量 / dim 包裹 / `[error]` 可见 / `[aborted]` 可见)+ memory 首次运行回归 1 测红→绿;typecheck 0;eslint src/harness 0 问题;prettier 干净;全量 89 passed + 1 skipped(smoke)。离线端到端探针两支:①dummy key 打真 deepseek → stdout 出 `[error] HTTP 401`、jsonl 落 user 行、无栈崩、回 `>`;②pty(`script`)+ 挂起端口(本地 socket server 不回包)让流卡在途中,3s 后发 `\003` → stdout 出 `[aborted]` 并回 `>`(loop 的 `signal?.aborted` 检查在 switch 之前,故 transport 的 AbortError 被 abort 分支吃掉、不显示成 `[error]`),空转时再发 `\003` → 进程退出。真 key 人工演示待跑。
- **已知残留**(H1 不修):①abort 后 `context.messages` 里留一条 `stopReason="aborted"` 的空 assistant 消息,下一轮原样发给 provider —— 是否被拒(400)只有真 key 能验,拒了则归 loop/memory 层清理,不属 harness;②story 16 的"中断在跑的工具"靠 loop 把 signal 传给 `tool.run`(bash 已实现杀进程组),write/edit 不观测 signal = 已在手的落盘不撤回。

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
- **验收句**:`cli.ts` 读三 flag(`--model <alias>` / `--continue` / `--resume`)后 ——`mini --model glm` 用 glm 配置行起(provider=dialect+base_url+key_env 全来自 `providers.ts` 表,加厂商只加一行);启动横幅显示 `mini · glm (glm-4-plus) · <cwd>`;会话内输入 `/model deepseek` 即热切(下一条消息起走新厂商、并 append 一行 `model_change` 存 alias),退出后 `mini --resume` 打编号清单(每行 mtime · model · sessionId 前 8 位)、选号进入该会话且**恢复切后厂商**(rebuild 末条 model_change 生效),`mini --continue` 直接接 mtime 最新会话续聊;坏 alias → `unknown provider "x" (可选:...)` 不崩、`--model` 缺值即报错、`--resume` 空目录提示新开。裁决全在纯缝,`src/harness/` 除组装零 loop/校验/压缩逻辑 —— 这就算 H2 完。
- **seams 与用户确认**:4 纯缝自动测 + 其余 HITL(照 H1「harness 故意浅」)。S-a `resolveProvider(alias)`(providers.ts 配置行表)/ S-b `parseArgs(argv)`(无第三方库)/ S-c `SessionManager.list({baseDir,cwd})`(mtime 降序 + sessionId 解析 + 末条 model_change)/ S-d `resolveModel({cliModel,rebuiltModel,defaultAlias})` 优先级 = `--model` > resume 恢复 > 默认。会话内热切机制 = 本会话向用户确认后定的 `/model <alias>` 斜杠(推翻「/compact 唯一斜杠」→ 改记 DECISIONS H2 为两条);`model_change` 存 alias 非 model id(一行配置可翻回完整 provider)。启动仅当 `--model` 覆盖历史 model 才落 model_change,默认/纯恢复不写(避噪音)。
- **验证**:四缝 13 测红→绿(providers 3 / args 5 / session-list 2 / resolve-model 3);全量 102 passed + 1 skipped(smoke 需真 key);typecheck 0;eslint src/harness 0;prettier 干净。非网络 CLI 探针三支:①`--model zzz` → `unknown provider "zzz" (可选:deepseek / glm)` 且 resolveProvider 先于 env 检查;②`--model`(缺值)→ 报错退 1;③`--resume` 空 HOME → 「无可恢复会话,新开一个」再 DEEPSEEK_API_KEY 未设置。真 key 人工演示待跑。
- **已知残留**(H2 不修):①`PROVIDERS` 现仅 deepseek/glm 两行、且一行一模型(`models[0]`),`--model glm:flash` 式多模型 = DEFERRED;②`--resume` 选号后走 `SessionManager.open`,崩溃 torn 末行由 open() 截回,list() 只读不修(损坏行跳过扫描);③启动横幅的 model id 取 `provider.models[0].id`,多模型厂商暂不反映实际选中项。

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
- **验收句**:`cli.ts` 接线后 ——会话中输入 `/compact`:当前厂商同模型流按 M4 七段生成纪要,compaction entry 落盘(payload = summary + firstKeptEntryId),随即 `rebuild()` 热替换 `context.messages`,下一条消息走压缩后上下文;**未达阈值照样压**(S-d `force`),压完窗口立即回落(同口径 usage 重测不再触发)。每轮 `message_end` 自动调 `compact()`(不带 force):阈值不过 = 返 null 零副作用,手动/自动共用同一生产 `summarizeFn`(= `buildSummarizePrompt(previousSummary)` + `serializeConversation(被弃段)` 喂当前 `streamFn`,裁决零在 harness)。发给 provider 的 system prompt 三段:中文固定骨架 + 工具清单(全量 name+description,随 `context.tools` 每轮重算 = AC-H3-5) + `<project_instructions>` 包裹的项目上下文(cwd 向上找 AGENTS.md/CLAUDE.md:跨目录恒近者赢——cwd=/a/b/c、/a/CLAUDE.md 与 /a/b/AGENTS.md 并存用近者;同目录 AGENTS.md 赢;皆无 = 该段省略)。`src/harness/` 除组装零压缩/阈值/配对裁决 —— 这就算 H3 完。
- **seams 与用户确认**:4 纯缝自动测 + 接线 HITL(照 H1/H2)。S-a `buildSystemPrompt({tools, projectContext})`(harness 纯拼装)/ S-b `findProjectContext(cwd)`(向上近者 + 同目录 AGENTS>CLAUDE)/ S-c `serializeConversation(messages)`(memory 纯缝,`[role]` 行格式,thinking 块丢)/ S-d `CompactOptions.force?`(跳阈值一行)。自动压缩接线 = 本会话裁决(接,M3/M4 触发口径否则成死代码);骨架中文;同目录 AGENTS.md 赢。
- **判卷**:通过(2026-09-14)— 四缝方案 + 自动压缩接线 + 中文骨架 + 同目录 AGENTS 赢,均经用户确认(AskUserQuestion)。
- **验证**:四缝 12 测红→绿(S-d force 1 / S-c serialize 3 / S-a system-prompt 4 / S-b project-context 4);全量 114 passed + 1 skipped(smoke 需真 key);typecheck 0;eslint 0 error(memory `list()` 1 条既有 warning,非本刀引入);prettier 干净。非网络 CLI 探针两支:①空会话 `/compact` → 「当前会话无可压缩内容」不崩退 0;②cwd 放 AGENTS.md → 横幅出「项目上下文:<绝对路径>」(发往 provider 的 system 消息由 S1/S3 适配器既有 Story 31 测断言 systemPrompt 首位注入,harness 侧三段拼装 = S-a/S-b 覆盖)。真 key 人工演示待跑。
- **已知残留**(H3 不修):①`/compact` 执行中 Ctrl+C:readline 在 ask 之外无 controller → SIGINT 直接退进程(压缩中途死 = M2 崩溃恢复语义兜底,torn 末行截回);②projectContext 启动读一次,会话中改 AGENTS.md 要到重启才反映(AC-H3-5 只承诺工具集);③拒压(最近单条 > keepRecent)时 `[error] compact:` 透传 memory 长英文错误(M4 遗留①分段兜底,DEFERRED 在册);④summarize 流无进度显示,长纪要等待期 stdout 静默。

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
