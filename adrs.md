# ADR 决策记录

## ADR-001：系统提示词骨架升级为 cline + codex 融合版

- 日期：2026-09-14
- 状态：已采纳
- 涉及文件：`src/harness/system-prompt.ts`（骨架 + env 段）、`src/harness/cli.ts`（env 实参）、`refs/agent-prompts/`（两份参考原件）

### 背景

原骨架只有三句话（身份 + "先读后写,改动尽量小" + 确认门 + 中文）。实测缺口：模型不知道运行环境（Windows/WSL 路径靠猜）、无输出篇幅与格式约束、无"无工具调用即终答"的循环约定、无并行调用指引、无验证与编辑纪律。需要一份贴合 mini（轻量 CLI harness）的骨架，而不是凭空拍脑袋。

### 参考来源（gh 拉取，原文存 `refs/agent-prompts/`）

- Cline：`sdk/packages/shared/src/prompt/system.ts`（DEFAULT + YOLO 两变体，约 6.6KB）——"执行力"取向：并行工具调用、验证闭环、简单问题短路。
- Codex：`codex-rs/core/gpt_5_2_prompt.md`（21.6KB，主力基座）——"判断力"取向：人格、自主性、验证分级、最终答案格式法典。

### 决策

骨架重写为九段：身份与语气 / `<env>` / 自主与闭环 / 并行 / 编辑纪律 / 验证 / 尺度 / 呈现 / 优先级与确认门。逐段出处：

1. **身份与语气**：保留"你是 mini"开头（测试钉死防段序漂移），并入 codex 的"精确、安全、有用"（L1）、Personality 节（L15）、默认极简不超 10 行（L170）。原版零语气约束，这是实测最易跑偏项。
2. **`<env>` 块**：搬 cline L7-13。mini 跑在 Windows+WSL 混合环境，无 env 注入时路径/命令风格全靠猜；经 opts 传入保持 buildSystemPrompt 纯函数零状态。
3. **自主与闭环**：codex L30-32 端到端坚持 + 例外枚举（提问/头脑风暴不动手）；cline L5 不臆测、L28 别说而不做、L30 无工具调用=最终答案（mini loop 正是靠无 tool call 终止，原骨架未把这个约定告诉模型）、L34 简单问题直答。
4. **并行**：cline L22-23 压缩为三行。cline 全文最值钱段落，多文件任务可省约一半轮次；codex 仅一句，不足取。
5. **编辑纪律**：codex L120-134 精选七条 + cline L16-18 三条。取：根因、最小聚焦、只用已确认库、无占位、不修无关、未经要求不 commit/不加注释/不单字母变量、绝对路径。
6. **验证**：codex L138-150 分级哲学（由窄到宽、无测试文化不加测试）压成三条，审批模式双轨条款改写成 mini 确认门现实。
7. **尺度**：codex L152-158 Ambition vs. precision，三行。防"既有库也抠抠搜搜 / 新项目也放不开"。
8. **呈现**：cline L32 + codex L160-170、L227-230 的定量条款（路径:行号、片段 ≤8 行、下一步问一句）。
9. **优先级与确认门**：codex L21-26 AGENTS 优先序的模型端镜像——H3 装配已实现"向上近者 AGENTS 赢"，但模型从未被告知裁决规则（用户 > project_instructions > 骨架通用条款；嵌套深者赢），此段补齐闭环。确认门原句保留并加"被拒不绕过"。

### 明确拒绝项及理由

- **codex update_plan 状态机整段**（L36-56、L290-298）：mini 无 plan 工具，无的放矢。
- **codex apply_patch 语法教学**（L254-288）：mini 用标准 tool schema + edit 工具，补丁 DSL 不存在的协议教给模型是死重。
- **codex 73 行最终格式法典**（L172-242 全量）：mini CLI 无对应富渲染器，只取"可点击路径 + 紧凑"主干。
- **codex L134 禁 `【F:…】` 引用、L130"apply_patch 失败即知"**：codex 渲染器/协议特供。
- **cline YOLO 变体与 `submit_and_exit` 协议**：那是无人值守模式；mini 每轮有确认门，两种终止语义不混用。
- **整搬 21KB codex 原文**：每轮全价付费的系统开销；mini 定位轻量。

### 成本

净增约 1.2K token/轮（介于原骨架 ~60 token 与 codex 21KB 之间），换取上述九段行为约束。

### 验证锚点

- `src/harness/system-prompt.test.ts`：首句 indexOf===0、段序 骨架→(env)→工具→项目上下文、env 可选整块省略、AC-H3-5 纯函数重建——全部保持。
- 融合文本先经人工逐段对比批准后才落盘（先译后比再改，三轮确认）。

## ADR-002：终端聊天框 = 变体 A 布局 + G5 线描幽灵顶栏（生产化）

- 日期：2026-09-15
- 状态：已采纳
- 涉及文件：`src/harness/tui-view.ts`（纯渲染）、`src/harness/tui.ts`（ChatIO 双实现）、`src/harness/cli.ts`（换缝）；原型原件存一次性分支 `proto/terminal-ui`（61ad622，不入 main 线）

### 背景

H1~H3 交付的是裸 readline + 增量 stdout，操控体验差（无整体画面、误触即发）。经 /prototype 流程做三布局变体（A 全宽双框 / B 左流右面板 / C 无框内联）+ 15 节 logo lab，用户十余轮反馈收敛出定稿。原型答完问题即弃，本条记录采纳进生产的最终形态与映射。

### 裁决（用户逐轮确认，非我自选）

1. **布局 = 变体 A**：G5 幽灵 4 行顶栏左置 + info 三行右邻（`mini v0.1 · coding agent` / `<model-id> with high effort` / `process.cwd()` 全路径）→ 无边框消息流 → 全屏唯一边框 = `>` 行首输入框。参考系 = opencode：名字居顶、下方单输入框。
2. **标志 = G5 第一版线描幽灵**（`╭───╮/│○ ○│/│ ‿ │/╰╯╰╯`，青色单色，带 ‿ 嘴、4 行等比）。中间轮次的"去嘴放大 1.5×"与"内部填色"两版被用户以"看起来很奇怪/加颜色很奇怪"撤回。
3. **消息流符号**：`›` 用户 / `▍` 助手 / 淡显 thinking / `▸` 工具（start 挂行、end 回填 `→ 结果 ✓/✗`，同 toolCallId 不重复开行）/ `⚠` 确认门与错误 / dim 系统注记。
4. **busy 态**：输入行右挂 `⋯ 运行中 Ctrl+C 中断`；busy 期 Enter = 排队下一条（本轮结束即领走）。

### 实现映射

- 纯渲染 `tui-view.ts`（宽度/折行/框线/历史映射全可测）+ 驱动 `tui.ts`（raw mode 键盘 + setImmediate 合并重绘）。
- `cli.ts` 只换缝：`ChatIO`（ask/confirm/render/note/warn/setModel/loadHistory/onInterrupt），TTY = TUI，**非 TTY 自动回落旧 readline 通道**（管道/脚本零破坏）；loop/stream/memory 与 AC-H1-3（组装层零业务逻辑）不动。
- 防漂移：制表/生僻符号以码点扫描验证落盘；测试断言同源（LOGO 码点钉死，漂移必红）。

### 明确拒绝项

- Tab 布局循环、变体 B 侧栏（ctx%/tools 面板）、变体 C：原型机制，生产只留 A。
- `ctx 12%/200k`、"历史 34 条"独立展示：proto 期用户"暂时不要"，压缩信息走 dim 注记行。
- 块字词标（mini 大字）、拟人篇 M1-M5、像素幽灵：被"幽灵可以但不要像素画风"与 G5 胜出淘汰。
- 输入框内嵌发送按钮/多行编辑器：定稿就是"前面一个 > 的聊天框"。

### 验证锚点

- `tui-view.test.ts` 10 例：vw CJK 计列 / wrap 硬切 / fitInput 保尾 / LOGO 码点 / 行数=height 封顶 / 超屏留尾 / busy 提示 / 条目映射 / liveEntry。全绿（125 passed）。
- 真 TTY 人工验收（渲染对位、键感、确认门、Ctrl+C 双语义）= 待用户 `npm run cli` 实测。
