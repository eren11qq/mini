# DEFERRED —— v1 砍件清单(砍=排队,不是丢失)

用户指令(2026-09-13):"先暂时删掉,需要的时候我再加回来,记得写进文件"。每项含:砍掉理由 / pi 里的原件位置(加回时的抄写对象)/ 加回触发条件。

## loop 层

| 件                                         | 理由                            | pi 原件                                                       | 何时加回                    |
| ------------------------------------------ | ------------------------------- | ------------------------------------------------------------- | --------------------------- |
| steering 队列(流式中插话)                  | readline 与 LLM 流并发,复杂度×2 | agent-loop.ts:194-209 + PendingMessageQueue(agent.ts:125-159) | v1 跑顺、想"边跑边改方向"时 |
| followUp 队列(停后排队续跑)                | 同上                            | agent-loop.ts:261-265                                         | 与 steering 一起            |
| 并行 tool 执行                             | 串行已够,并行引入竞态           | agent-loop.ts:416-424(executionMode)                          | 一批多 read 变常见后        |
| shouldStopAfterTurn / prepareNextTurn 钩子 | v1 无扩展系统                   | types.ts:223 / agent-loop.ts:176-190                          | 做 extensions 时            |

## tools 层

| 件                                  | 理由                        | pi 原件               | 何时加回                 |
| ----------------------------------- | --------------------------- | --------------------- | ------------------------ |
| grep/find/ls/powershell 工具        | 默认 4 件套够编码用         | tools/index.ts:95-105 | 模型频繁喊"找不到文件"时 |
| 规则 UI(管理 rules.json 的斜杠命令) | 手删文件即可撤销,先不做界面 | —(pi 无此物,我们自造) | 弹窗烦了的时候           |

## 确认门(C1–C8 分层流水线的砍件与已知洞)

| 件                                                                                                                                 | 理由 / 现状                                                                                                  | 现落点(加回时动这里)                                                     | 何时加回                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **deny 规则**(硬拒,连弹都不给)                                                                                                     | C5 明确"不自动拒 —— 保留用户否决权";有了 deny 就多一层优先级语义要定义                                       | `loop/rules.ts`(规则需加 kind/deny 域)+ `run-loop.ts` allow 层之前       | 要做策略管控(团队共用、机器不许碰某目录)时                        |
| **批量弹窗合并**(一批多 toolCall 一次批)                                                                                           | 现串行逐条弹(L4),一批 5 个写操作 = 弹 5 次                                                                   | `run-loop.ts` 工具批循环 + `ConfirmAnswer` 契约                          | 真被同轮多弹烦到                                                  |
| **符号链接逃逸**:cwd 内软链指向 cwd 外,`path:` 判据与黑名单不追链                                                                  | C5 v1 洞①:`pathMatchOf` 用 `resolve` 不追软链,`dangerOfShell` 只看字面路径                                   | `tools/tool.ts pathMatchOf` + `loop/danger.ts`                           | 出现"让模型改 cwd 内文件、实为写 `~/.ssh`"的真事故时              |
| **命令替换躲黑名单**:`rm -rf $(echo /)` 字面不含根路径,躲过 rm 炸机判定                                                            | C5 v1 洞②:`bash-parse` 已把该段标 `substitution`(故不算只读、必弹一次),但黑名单是字面匹配,展开后的参数看不到 | `loop/danger.ts`(要加就得引真 shell 解析或求值)                          | 同上 —— 现状兜底 = 该段必弹(substitution 出口条件),只是没打出原因 |
| **always 粒度档位**:种子恒取段前 2 token,单二进制+文件名的命令只覆盖同参(`mkdir w1` → `mkdir w1:*`,管不到 `mkdir w2`)              | `seedOf` 假定 argv[1] 是子命令;对 `mkdir/touch/cp` 这类"动词+文件名"命令过窄,对 `git` 这类家族刚好           | `loop/bash-parse.ts seedOf` + C6 弹面(可给 3a/3b 两档:二进制级 / 家族级) | W 剧本幕②探针跑出来后真觉得烦(2026-09-15 C8 记)                   |
| 清账:`src/tools/bash.ts` 的 `prefixOf`(首 token `:*`)自 C3 起不参与落盘(bash 有 `matchKind:"shell"` → 走 `seedOf` 逐段),当前不可达 | 死声明,留着会误导读者(已按"死码不删"规矩挂账)                                                                | `tools/bash.ts:32`                                                       | 下次碰 bash 时顺手删(零行为变化,靠 typecheck + 283 测兜)          |

## memory 层

| 件                                               | 理由                                         | pi 原件                            | 何时加回              |
| ------------------------------------------------ | -------------------------------------------- | ---------------------------------- | --------------------- |
| thinking_level_change entry                      | v1 不暴露 thinking 档位切换                  | session-manager.ts:53-153          | 做 --thinking flag 时 |
| branch_summary entry + 离开分支自动生成摘要      | v1 无分支切换交互                            | compaction/branch-summarization.ts | 做 time-travel UI 时  |
| custom / custom_message entry(扩展状态/注入消息) | v1 无扩展系统                                | session-manager.ts:53-153          | 做 extensions 时      |
| label entry(书签)                                | 无 UI 消费它                                 | 同上                               | 做 tree 浏览器时      |
| fork / 切 leaf / getTree 交互                    | 存储层(parentId/parentSession)已保留,纯缺 UI | session-manager.ts:1427-1544       | v2 第一件事的候选     |
| 超长旧段分段摘要兜底(prefix summarization)       | v1 承认极限:旧段本身超窗就拒压报错           | compaction.ts:835                  | 真撞上一次报错之后    |

## harness 层

| 件                                                | 理由                          | pi 原件                | 何时加回        |
| ------------------------------------------------- | ----------------------------- | ---------------------- | --------------- |
| TUI 差分渲染                                      | 独立大工程(pi-tui 整个包)     | packages/tui           | 裸打印能日用后  |
| print/json/rpc 多模式                             | interactive 一种就够          | modes/index.ts:6-9     | 要接 IDE/脚本时 |
| extensions/skills/prompt-templates/jiti 热加载    | 报告 §6.9 明确"可选第二期"    | extensions/loader.ts   | v2 主体         |
| 指数退避多轮重试                                  | 1 次重试已覆盖 relay 抖动主因 | agent-session.ts:2917+ | 频繁 1 次不够时 |
| --session/--session-id/--no-session/--fork 等旗标 | flags 冻结在 3 个             | cli/args.ts            | 随 fork UI      |

## markdown v1(C12 砍项,版式人审后续按需回补)

| 件                                   | 理由                               | 现落点                       | 何时加回                |
| ------------------------------------ | ---------------------------------- | ---------------------------- | ----------------------- |
| 嵌套强调(`**a `b` c**` 内反引号字面) | 单遍扫描即够,嵌套要重开 SGR 栈     | markdown.ts styleInline      | 真机看到 bot 常吐嵌套时 |
| 有序列表 `1.` 规整/对齐              | 2026-09-15 裁:段落字面             | splitBlocks LIST 正则        | 日用碍眼就加            |
| quote 折行续行追沟 `│ `              | 需 wrap 阶段带前缀,刀大            | tui-view entryLines bot 分支 | 同上                    |
| 强调 `_x_` 下划线形                  | 只认 `*` 形,少一类误伤(变量名 a_b) | styleInline                  | 几乎不加                |
| 表格 / 链接渲染                      | 基础+代码块之外,pi 也无            | —                            | 明确需求后              |

## 永远不做(pi 的取舍,mini 继承,见报告 §6 末段)

- 逐工具之外的全局功能开关式安全(项目信任已有,不再加层)
- sub-agent / plan-mode 内建 —— pi 下放给扩展,mini v1 直接不做
- 向量检索式跨会话记忆 —— pi 本身就没有(报告 §5.4),别被"memory"一词骗去做 embedding

## 品味 backlog(Q1 压下的,等 v1 1:1 复刻完成才有资格谈)

- (未列满 —— 用户想清楚一处写一处,格式:改哪层 / 违背 pi 哪条 / 为什么值得)
