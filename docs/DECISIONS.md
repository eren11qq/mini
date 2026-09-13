# DECISIONS —— mini v1 决策日志

来源:2026-09-13 grilling 会话 Q1–Q33。标 ★ = 对 pi 的故意偏离;标 ◇ = 助教默认拍板、用户可翻案;其余 = 用户拍板。

## 全局

| #   | 决策                                                                    | 出处               |
| --- | ----------------------------------------------------------------------- | ------------------ |
| G1  | v1 = 1:1 复刻 pi + 安全件;品味进 backlog 不急用                         | Q1                 |
| G2  | 建造顺序改为:⓪ 假流+loop → ① 真 stream → ② tools → ③ memory → ④ harness | Q3                 |
| G3  | 适配器按方言分(仅 2 个),厂商只是配置行                                  | Q2+Q19             |
| G4  | ◇ 运行时 node v24 直跑 .ts;单包按目录分层;无构建                        | 环境事实(NOTES.md) |
| G5  | 项目 = ~/project/mini;会话数据 = ~/.mini/                               | Q16+Q30            |
| G6  | PRD 落本地 docs/,暂不建 git 仓库                                        | Q33                |

## ⓪ loop

| #   | 决策                                                                                        |
| --- | ------------------------------------------------------------------------------------------- |
| L1  | 双层 while 形状照抄;steering/followUp 队列不挂(v2)                                          |
| L2  | 停止 = pi 五条件(无 toolCall / error / abort / 钩子 / 整批 terminate)★ + maxTurns=50 保险丝 |
| L3  | ◇ 事件协议照抄 pi 10 个 AgentEvent(实测 types.ts:428-443)                                   |
| L4  | ◇ 同批 toolCall 串行执行                                                                    |
| L5  | ◇ 流式 partial 占位 messages 末位;error 编码进流、loop 零 try/catch                         |
| L6  | 测试 = 假流四剧本:①纯文本 1 圈停 ②toolCall→2 圈停 ③无限 toolCall→保险丝 ④流中途 error→不崩  |

## ① stream

| #   | 决策                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | 首发 openai-completions 方言 → deepseek-chat(2026-09-13 实测 200 + tool_calls 流正常)                                                  |
| S2  | 第二适配器 anthropic-messages → qwen3.8-flash 经 token-plan relay(实测 /v1/messages 可用、吐 thinking;该 relay 无 openai 端点、曾 403) |
| S3  | dashscope openai 端点实测 401(openclaude 的 key 已过期),不作为依赖                                                                     |
| S4  | 密钥只从 env 读;配置 {dialect, base_url, key_env, models[]}                                                                            |
| S5  | 重试:5xx/超时自动 1 次;4xx 即停显示原因                                                                                                |
| S6  | ◇ toolcall 参数流式 salvage 解析;截断定稿整批拒执(照抄 pi)                                                                             |

## ② tools

| #   | 决策                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------- |
| T1  | v1 仅 read/bash/edit/write;edit = pi 式多锚点 {edits:[{oldText,newText}]},全批原子校验                   |
| T2  | ★ 安检:Claude Code 式三选项确认(Yes / Yes, always / No),装 loop 的 beforeToolCall 公共 hook,不装工具内部 |
| T3  | 确认范围 = bash/write/edit;read 放行                                                                     |
| T4  | "always" 落盘 rules.json(项目目录、明文、手删即撤销),仅命令前缀匹配,禁止一键全允许                       |
| T5  | ◇ bash 超时 + abort 杀进程树 + 输出保尾截断(2000 行/50KB,全量落临时文件);校验失败→error toolResult 回喂  |

## ③ memory

| #   | 决策                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | JSONL append-only 树 {id,parentId,ts,type};message_end 即时落盘;旧行永不删                                                                                                                                                                                                                                                                                                                                                                   |
| M2  | v1 entry 仅 5 种:header/message/model_change/compaction/session_info;砍件见 DEFERRED.md                                                                                                                                                                                                                                                                                                                                                      |
| M3  | compaction 进 v1,机制照抄 pi + 用户规格(Q35–38):触发 = usage > contextWindow − reserve(16384),另支持手动 /compact(唯一斜杠命令);切点 = 从近往远累计 keepRecent(20000);刀口不劈 toolCall/toolResult 配对;纪要 = 同模型、中文固定七段(目的/做到哪了/关键要点/引用文件★/关键决定/下一步/关键背景),"引用文件"为对 pi 格式的偏离;二次压缩增量合并,纪要恒一份;旧段超窗拒压报错;产物写 compaction entry(firstKeptEntryId)→ 热替换 messages,旧行不删 |
| M4  | 路径 ~/.mini/sessions/<cwd 编码>/<时间>_<uuidv7>.jsonl;fork 的 parentSession 谱系字段保留在 header(交互功能 v2)                                                                                                                                                                                                                                                                                                                              |

## ④ harness

| #   | 决策                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------- |
| H1  | 裸 readline + 流式 stdout(thinking 淡显);无 TUI                                                          |
| H2  | flags 全集仅 3 个:--model / --continue / --resume(编号选择器);会话内 /compact 为唯一斜杠命令(Q35 用户加) |
| H3  | systemPrompt = 骨架 + 激活工具清单 + 项目上下文(AGENTS.md/CLAUDE.md 向上找、近者优先);工具集变化即重建   |

## 工作流决议

| #   | 决策                                                                             |
| --- | -------------------------------------------------------------------------------- |
| W1  | 每层开工前用户自写一句验收句("怎么演示算完"),助教对照报告判卷,不过不许发建造指令 |
| W2  | 测试缝 S1–S4(S1 主缝 90%),harness 纯人工;依赖全注入、测试零网络                  |
| W3  | 所有砍掉功能 + 加回路径写 DEFERRED.md                                            |

## 补课记录(grill 暴露的概念盲区,已过关)

- content 块三类型 text/thinking/toolCall —— 第 3 轮口头过关
- toolResult 回填 role/toolCallId —— 第 3 轮答对
- compaction 不删行 + firstKeptEntryId 窗口 —— 第 5 轮变试题答对
- 行为盲区:max-turns 决策连跳 3 轮才拍板 —— 写验收句时警惕同款拖延
