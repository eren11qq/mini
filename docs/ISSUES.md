# ISSUES — 确认门重构(Claude Code 式分层决策)

本地 tracker。源 = 2026-09-15 设计对话(plan: confirm 系统分层流水线)。
目标:弹窗从"每次工具调用"降为"仅未预批且非只读的边界动作",同时堵复合命令越权洞。
分层顺序(所有片共同遵守):工具分级 → 参数解析 → 危险黑名单 → allow 判定(内置只读表 + rules)→ 弹窗兜底。
合并顺序 C1→C2(同碰 rules.ts)。C6/C8/C9 为 HITL,需人审文案/spec/视觉。显示升级三卡 C10(折行地基)→C12(排版)按序合,C11 可与 C10 并行;C13/C14 独立运维/诊断,C14 先跑让装机追平基准。C15(/model 自配 key)= PRD 翻案卡,独立于 C10-C14 链,2026-09-15 插队先做。kilocode 对标三卡 C16(弹层特效)→C17(/connect 向导)→C18(/model 收口)按序合,C17 blocked by C16、C18 blocked by C17。展示升级弹头三卡(2026-09-16 立,Claude Code 式工具渲染):C19(edit diff 穿全层)先行,C20(write diff)/C21(bash ⎿ 树)blocked by C19 且互可并行;C19 建议先于 C17 落(tui.ts 邻区防撞)。C22 = skill 三段式(Kilo 同款:扫目录→元数据表进 prompt→工具按需注入)预留号,未建卡。2026-09-16 另起 D 系列(MAF 图案移植批,源 = `docs/PRD-V2.md`,见本文件末尾):编号独立于 C 避并行会话撞号;合并序 D1→D2→D4,D3 刀位独立可穿插,D5 收尾吃全部。

---

## C1 — 文件工具种子 = path + glob 匹配器(write/edit 的 always 必粘)

**Type**: AFK · **Blocked by**: 无

### What to build

现状 bug:write/edit 未声明种子抽取器,确认门退化用整参 JSON 串当规则种子,文件内容一变规则即失效 → 文件类工具 100% 每次弹。改为:文件类工具声明 `prefixOf` = 规范化 `path`(相对 cwd);rules 匹配器对 `path:` 前缀条目启用 glob(`src/loop/**` 命中目录下任意深度文件,`*` 不跨 `/`,`**` 跨)。

"always" 时优先建议目录级 glob(如 `path:src/loop/**`),用户接受后退到文件级。解析后落在 cwd 外的绝对路径:必弹,且不提供 always 选项(拒落盘)。旧 write/edit 的全 JSON 死规则条目兼容保留(载入不报错、永不命中),手删即清。

### Acceptance criteria

- [x] 同一文件连续 edit 两次,confirm 仅首弹(第二次走 always 落盘规则)
- [x] 规则 `path:src/**` 命中 `src/a.ts`,不命中 `docs/x.md`;`path:src/*` 不命中 `src/sub/a.ts`
- [x] cwd 外绝对路径 → 弹且 always 被拒退化为一次性 yes
- [x] 旧 rules.json(含全 JSON 串条目)载入不崩、行为不回退
- [x] 确认逻辑仍在 loop 侧,工具源零确认代码(AC-T2-6 约束不破)

---

## C2 — bash token 前缀匹配 + 规则格式 v2 + 旧规则迁移

**Type**: AFK · **Blocked by**: 无(与 C1 按序合)

### What to build

bash 规则从"整串字符串相等"升级为 **token 前缀匹配**:规则携带 token 数组(如 `["git","status"]`),规则 token 序列是命令 token 序列的前缀即命中。效果:`git status -sb` 命中 `["git","status"]`;`git commit` 不命中(现状首 token 种子 `git:*` 会把整个 git 家族放行)。

loader 归一化:旧 `{tool:"bash",prefix:"git:*"}` → tokens `["git"]`(family 语义不变,存量 rules.json 行为等价)。新写条目落 v2 形状。`isValidSeed` 保留:拒空、拒 `*`(AC-T2-8 无一键全允许不破)。匹配器做成纯函数便于单测。

### Acceptance criteria

- [x] `["git","status"]` 规则:`git status -sb` 免弹、`git commit` 弹(rules.test.ts 前两例 + registry.test.ts C2 组真跑 loop 缝)
- [x] 旧 `{prefix:"git:*"}` 载入 ≡ tokens `["git"]`,`git push` 免弹(rules.test.ts「旧格式迁移语义等价」例)
- [x] `*` / 空数组种子拒写,always 退化一次性 yes(rules.test.ts isValidSeed 组:`*` / 空 / `:*` 三拒)
- [x] 匹配器纯函数 vitest 覆盖边界(空命令、多余空白、flag 首 token)—— 空白折叠有独立例;空命令由 `:*` 拒写覆盖;flag 首 token 侧由 `want[0] !== ""` 守卫覆盖,**无独立负例**(C8 记档:补测 = `ruleMatches({tool:"bash",prefix:"-x:*"}, "-y z") === false` 一行)
- [x] loop 源零 try/catch 约束保持(C8 复扫:`src/loop/*.ts` 非测试文件仅注释含该词,零 `try {`)
- 实现注记(C8):卡面写的"规则携带 **token 数组**"未采 —— 线上形状钉为 `{tool, prefix}` 的 **prefix 字符串**,匹配时按空白切 token(`git status:*` ≡ `["git","status"]`)。理由:数组需 loader 双形状兼容 + 手改 rules.json 更易破格式;语义等价,已回写 `docs/DECISIONS.md`「② 修订记录」末行

---

## C3 — 复合命令拆段、逐段过检(always 按段落规则)

**Type**: AFK · **Blocked by**: C2

### What to build

新叶子模块 `src/loop/bash-parse.ts`(独立于 loop 主体,照 salvage/transport 先例):bash 命令按 `&&` `||` `;` `|` 与换行拆为段;逐段提取 tokens,并检测 `>`/`<` 重定向、`$( )`/反引号命令替换。引号不闭合或解析失败 → 整条必弹(安全侧兜底)。

决策:每段独立走 C2 匹配器,**任一段不命中即弹**(弹窗展示完整原命令);全部命中才免弹。always 落盘时每段各写一条规则,建议粒度 = 前 2 token(二进制 + 子命令,不足 2 token 用 1 个)。

堵洞:`git status && rm -rf ~/x` 在已有 `["git","status"]` 规则时必须弹——现状 `git:*` 直接放行整条。

### Acceptance criteria

- [x] 有 `["git","status"]` 规则时 `git status && rm -rf ~/x` 弹;单 `git status` 免弹(bash.test AC-C3-1)
- [x] `git add -A && git commit -m x` 选 always → 落 `["git","add"]` + `["git","commit"]` 两条,重跑 0 弹(AC-C3-2 以只读 git 段同形验证:真 add 在 cwd=本仓库会污染 index)
- [x] `echo $(whoami)` 段带命令替换,不被判纯只读(bash-parse substitution 标记;双引号内 `$( )` 也标)
- [x] 未闭合引号 `git status && echo "oops` → 整条弹,不崩(parser ok:false + loop 必弹兜底,AC-C3-4)
- [x] parser 纯函数单测:分隔符在引号内不误拆(`echo "a && b"`)(bash-parse.test.ts 10 例)

---

## C4 — 内置只读命令白名单(零弹窗日常)

**Type**: AFK · **Blocked by**: C3

### What to build

loop 侧持有一张**数据表**(不放工具):只读 bash 段免弹且不产生规则。首版表:`ls cat head tail wc grep rg find pwd whoami date sort uniq tree git:status git:diff git:log git:show git:branch git:blame node:--version npm:ls`。

退出条件(任一命中则回弹窗流):段含重定向、段含命令替换、段带写副作用 flag(`find -delete` 类,flag 列表进同表)、解析失败。表可增长、可被手改,但不可被 rules.json 覆盖出"全允许"。

### Acceptance criteria

- [x] `ls -la`、`git diff HEAD`、`git status -sb` confirm 零调用、且 rules.json 不落新条目(registry C4 AC-1)
- [x] `cat x > y`、`ls > /tmp/a`、`find . -delete` 必弹(registry C4 AC-2;出口条件另有 readonly.test.ts 单元测 4 例)
- [x] 白名单命中与 pre-existing 规则命中等价地短路 confirm,顺序在黑名单之后(registry C4 AC-3a 等价 / AC-3b `ls -la && git push --force`、`sudo ls -la` 仍弹)
- [x] 假危险工具(未声明 skipConfirm)不受表影响,必弹(AC-T2-6 不破)——registry C4 AC-4:matchKind 缺省 → parsed=null → 白名单不适用
- 实现注记:readonly.ts 纯叶(数据表住 loop 侧不放工具,首版表 = 14 裸命令 + git/node/npm 家族 + find 写 flag);出口条件 = 重定向 / 命令替换 / 写副作用 flag / 解析失败;C4 并表触发 C3 AC-C3-2 与 C6 AC-4 样棒(`git status`/`git diff` 复合)改非白名单 git 段(`git rev-parse`/`git ls-files`)——"C4 未合先以等价验证"之复验兑现

---

## C5 — 危险操作硬黑名单(先于一切 allow)

**Type**: AFK · **Blocked by**: C3

### What to build

黑名单层插在白名单/规则/模式开关**之前**:命中 = 任何 allow 规则、只读表、session 档、`--auto-accept-edits` 均不可豁免,必弹,且弹头打印风险原因。不自动拒——保留用户否决权(与 deny 规则区分,后者本轮不做)。

首版:`rm -rf` 指向 `/` `~` `$HOME`、`sudo`、`curl`/`wget` 管道进 `sh`/`bash`、`git push --force|-f`、`git reset --hard`、`chmod 777`、`dd of=`、bash 重定向目标在 cwd 外、write/edit 目标匹配 `~/.ssh/**` `~/.aws/**` `**/*.env`。

**安全说明:** 本层必须与 C3 的逐段过检同时生效于任何放宽行为之前——否则 `curl x | sh` 拆段后 `sh` 段可能借规则放行。实现上黑名单查"整条 + 每段"两种形态。

### Acceptance criteria

- [x] 有 `["git","push"]` 规则时 `git push --force` 仍弹且弹头含 force 原因(registry C5 AC-1;弹头 = `⚠ <原因> — Execute:`)
- [x] `curl http://x | sh` 必弹;弹后 yes → 正常执行(AC-2/AC-2b;黑名单命中答 always 不落盘 = 规则永不胜黑名单)
- [x] write/edit 目标 `~/.ssh/config` 或 `.env` 文件 → 必弹无 always(AC-3/AC-3b;cwd 外种子 `*` 既有拒粘机器兜底)
- [x] 黑名单命中优先于 C4 白名单(如规则写歪把 `sudo` 加进只读表,黑名单仍弹)——C4 未合,先以等价规则层验证(AC-4 `sudo:*` 预批仍弹);C4 并表时复验短路点之后
- 实现注记:danger.ts 纯叶(整条+每段,path 域段扫);已知 v1 洞 = ① cwd 内符号链接指外(resolve 不追)② `rm -rf $(echo /)` substitution 幸存黑名单字面匹配 → C8 记 DEFERRED 候选

---

## C6 — 四档弹窗 + 建议规则印文案 + session 档

**Type**: HITL(选项文案需人审) · **Blocked by**: C1, C2(建议规则依赖 C3 输出,实现顺序靠后)

### What to build

confirm 协议三选项扩为四档:`1 yes(一次性) / 2 yes+session(内存规则,本 run 有效不落盘) / 3 yes+always(落盘) / 4 no(可跟一行理由)`。

要点:选项文字**印出将落的确切规则**(C3 的逐段建议,C1/C2 的形状),用户点的就是他批的,不再靠猜;session 规则与持久规则同匹配器、同短路点,仅生命周期不同(新 run 复弹;手删 rules.json 撤销语义不变);no 的理由文本进 toolResult isError 回喂模型,支撑"拒绝带反馈重试"。

tui.ts 与 cli readline 两处答案映射同步改 1/2/3/4。

### Acceptance criteria

- [x] session 选择 → 同 run 内重跑免弹;新 run 恢复弹;rules.json 无新条目(registry C6 AC-1 两例)
- [x] always 打印的规则文案与 rules.json 实际落盘内容逐字一致(vitest 解析断言,`printedRules` 抽面 == JSON 盘面)
- [x] no + 理由 → 模型收到的 toolResult 含理由文本(`user rejected: bash — <理由>`,无理由 = 旧文本逐字不变)
- [x] 复合命令的 always 建议=每段一条,打印数=落盘数(变异测:删列表渲染 → 此锚独红)
- [x] 键盘映射:`mapConfirm` 四档 1/2/3/4 + `4 <理由>` 有测(tui.test.ts);TUI 确认等待态吞行不破坏 = 归 C8 W 剧本人工跑 → 剧本已落地 `plan.md` AC-T2-1 幕⑤⑥(C8,2026-09-15;待人工跑)
- 实现注记:`ConfirmAnswer = {kind:"yes"|"session"|"always"|"no", reason?}`(住 loop/types,C6 单一契约);session 容器 = `RunLoopOptions.sessionRules`(cli 进程作用域一条,跨每轮 runLoop 存活,loop 只 push 永不写盘);弹面三行 = 原因+命令 / 四档键位 / 将落盘规则,规则行与落盘共用 `writable` 一份数组(`fmtRule` = `<tool>␣␣<prefix>`)

---

## C7 — `--auto-accept-edits` 模式开关

**Type**: AFK · **Blocked by**: C1

### What to build

cli 启动 flag。开启后:write/edit 且解析目标在 cwd 内 → 直通免弹(bash 不受影响,黑名单照常压制)。弹窗/日志注明"auto-accept-edits on"以显式来源。flag 关 = 现行为零变化。默认关。

### Acceptance criteria

- [x] flag 开:连续 2 次 cwd 内 write/edit 零 confirm 调用(registry C7;且不落新规则)
- [x] flag 开:cwd 外 write/edit 必弹(种子 `*` 不享直通)
- [x] flag 开不豁免 bash 与 C5 黑名单命中(bash 必弹;cwd 内 `secret.env` 黑名单先拦)
- [x] flag 缺省行为与现状逐字等价(全套 241 测零回归,缺省 = false = 零新分支)
- 实现注记:cli flag → parseArgs → RunLoopOptions.autoAcceptEdits;启动开 flag 打 `auto-accept-edits on` note(plain/TUI 均经 io.note,显式来源)

---

## C8 — spec 同步(AC-T2 重写 + DECISIONS T4 修订 + W 验收剧本)

**Type**: HITL · **Blocked by**: C1–C7

### What to build

规则语义变了 = 改 spec 不是改码。重写 `plan.md` T2 系列 AC:新 seams(token 匹配器、bash-parse 叶子、只读表、黑名单层、四档 confirm);修订 `docs/DECISIONS.md` T4:确认粒度=命令+子命令 token 前缀 / 文件 path glob,黑名单先于 allow,"手删即撤销""禁一键全允许"两条不变式保留;写新 W1 验收剧本(人工跑)覆盖:只读零弹、always 必粘、复合命令洞闭合、session 生命周期。DEFERRED.md 追加候选:deny 规则、批量弹窗合并。

### Acceptance criteria

- [x] plan.md AC-T2-* 全部与实现一致,无残留"首 token"表述 —— AC-T2-1 重写(分层流水线总表 + 真机六幕),AC-T2-5 四档,AC-T2-7 种子形状,AC-T2-8 双端拒,新增 AC-T2-9~13(拆段 / 只读表 / 黑名单 / session / 开关);顺带清掉 AC-T4-1 与 AC-H1-1 的旧文案(均标"2026-09-15 C8 校正")
- [x] DECISIONS T4 修订注明日期与被修订理由(引用本文件 C1–C7)—— T2/T3/T4 行改到现语义 + 新增「② 修订记录」表(逐行:原决策 → 现决策 → 引据卡号);另扫平 PRD 故事 22/23 + 新增 22a/22b/23a/23b/23c(未改号:代码引 `story 24`/`Story 16`/`story 8`,改号会断链)、PRD 缝表 confirm 行与「固定接口契约」confirm 签名、PRD「安检」条;两条 `PRD line 100/106` 代码注释因插行漂移,改指章节锚点
- [ ] 新 W 验收剧本六幕人工跑通,判卷记录进 plan.md —— 剧本已定稿(AC-T2-1),判卷行现标"待跑";六幕 = ①只读零弹 ②always 必粘 ③复合洞 ④黑名单先于 allow ⑤session 寿命 ⑥四档键位+理由+开关
- [x] DEFERRED.md 追加候选 —— 新增「确认门」表:deny 规则、批量弹窗合并 + C5 遗留两洞(符号链接逃逸、命令替换躲黑名单)+ 幕② 探针暴露的 always 粒度(段前 2 token,`mkdir w1` 管不到 `mkdir w2`)+ 清账 `bash.prefixOf` 死声明
- 实现注记(C8):本卡零生产码改动(规则语义变了 = 改 spec)。唯一例外 = 两条注释内的 PRD 行号锚点(漂移自修)。顺带核出 C2 的一条弱 AC(flag 首 token 无独立负例)已在上方记档并给出补测一行;PRD harness 行的"flags 仅 3 个 / 唯一斜杠 /compact"是 C7+C9 的历史漂移,不属本卡,留给下一张 spec 同步卡

---

## C9 — 斜杠命令补全弹层(输入 `/` 出候选列表)

**Type**: HITL(弹层视觉需人审) · **Blocked by**: 无

### What to build

现状:命令处理是 cli.ts 里逐条 `line === "/compact"` 硬编码 if,无命令表;TUI 输入行无补全。改为:

1. 抽**命令注册表**(名字+一行说明+handler),cli 分发从硬编码 if 改查表;后续加命令只登记不碰分发。
2. TUI 输入:行首为 `/` 且未提交 → 输入框下方渲染候选弹层(名字+说明),随键入前缀过滤(`/co` → 只剩 /compact);Tab/回车补全最高亮项,Esc 收起不删已输内容;退格到 `/` 前或清空 → 弹层消失。
3. 弹层只是视图态,不改提交语义:照旧整行回车交给注册表分发;无匹配命令时行为与现状一致(回喂 unknown)。

### Acceptance criteria

- [x] 注册表存在,`/compact` 经表分发,现有 /compact 行为零回归
- [x] 键入 `/` 出弹层列全部命令;继续键入按前缀过滤;Tab 补全
- [x] Esc 收起、已输文本保留;退格过 `/` 弹层自动消失
- [x] 补全态与确认门弹层(C6 四档)互不串态:确认等待中不渲染补全
- [x] 窗口窄/多命令时列表不折行破框(照满宽线修复先例 columns-1)

---

## C10 — ANSI 安全折行 + ansi.ts 叶子(排版地基)

**Type**: AFK · **Blocked by**: 无

### What to build

抽 `src/harness/ansi.ts` 常量叶子(B/DIM/ITALIC/CYAN/GREEN/YELLOW/RESET),tui-view 改 import 并 re-export 保对外面;`wrapLines` 折行时跟踪活动 SGR,断行处行尾补 RESET、下行头重开 = 每物理行自闭;非 ANSI 输入逐字节不变。TDD 切片:先红「bold 串宽 2 折行两行各自自闭」,既有 12 例 diff=0 为过门。

### Acceptance criteria

- [x] 含 bold 序列输入按宽 2 折行:两行各自行尾 RESET、行头重开码,逐字符断言(2 CJK=4 列,实钉宽 4 两行;宽 2 一字符一行同规则)
- [x] 非 ANSI 输入 wrapLines 输出逐字节不变(既有例 diff=0)
- [x] tui-view re-export 后对外 import 面零改(测试与消费方不破)
- [x] 依赖零环:tui-view → ansi 单向(ansi.test 源码 grep 契约)

---

## C11 — thinking 折成一行汇总 + Ctrl+O verbose

**Type**: HITL(汇总行文案需人审) · **Blocked by**: 无

### What to build

`entriesFromMessages` 把相邻 thinking 块合并为单条 think 条目(保留全文);折叠在**渲染期派生**(非构造期销毁原文,否则会话内/回放无法再展开):非 verbose 时一条 think 只画 `✻ 思考·N字`(N=去换行码点数,✻ U+273B 码点构造防漂移);流式 live think 恒展开,message_end 当场收行;`TuiView` 唯一新字段 `verbose: boolean`;tui.ts 绑 `\x0f`(Ctrl+O,现为自由键位)切换 + 一行 dim notice。`--continue` 回放与实时同派生链 = 平价天然成立(锚测钉死)。ChatIO/cli/renderer.ts/plain 模式零改动。

### Acceptance criteria

- [x] 相邻两个 thinking 块 → 渲染仅一行 `✻ 思考·N字`(N=去换行码点数),码点断言
- [x] verbose=true → 全文淡显原样;同 entries 两帧行数差确定
- [x] 流式期间 live thinking 展开;message_end 落定即收成一行
- [x] `--continue` 重放与实时轮输出一致(平价锚测)
- [ ] Ctrl+O 切换不写入输入框、不与既有键位互踩(人工,W2)
- [x] 汇总行文案人审定稿(HITL)—— 用户 2026-09-15 裁:照卡上定稿 `✻ 思考·N字`(✻ U+273B / · U+00B7,源里 String.fromCodePoint 构造)

---

## C12 — bot 文本 Markdown 渲染(基础+代码块,仅 TUI)

**Type**: HITL(视觉需人审) · **Blocked by**: C10

### What to build

新叶 `src/harness/markdown.ts` + 同刀 `markdown.test.ts`(锚点直测,裸缝窗口不跨 slice):`splitBlocks`(head/para/list/quote/code/hr/blank;围栏未闭合 = code 到末尾 = 流式安全)→ `styleInline`(单遍扫描 `**`/`*`/反引号,未闭合定界符字面降级;不变式 `vw(styleInline(s))===vw(s)`)→ `renderMarkdown(src, ruleW)`(零宽度数学;块内不过 styleInline;引用 `│ ` 沟、列表 `•` U+2022、hr 用 ruleW)。顺序契约:分块 → 逐行行内样式 → wrapLines → 前缀(head 永不吃样式)。user/tool 行不过 markdown(防注入变脸)。真机流式无闪 = 人工验(整屏重绘机制不变,帧成本同阶)。

### Acceptance criteria

- [x] splitBlocks/styleInline/renderMarkdown 三函数锚点直测(markdown.test 10 例;未闭合围栏归 code 到末尾、未闭合定界符逐字节字面降级均有锚)
- [x] 恒宽不变式钉死(markdown.test)—— 卡面字面式 `vw(styleInline(s))===vw(s)` 对闭合定界符不成立(定界符本身消费可视宽,`**中中**` 8→4),真锚拆两支:闭合 ⇒ vw = 原 vw − 定界符宽(手算 4);未闭合 ⇒ 逐字节字面 ⇒ vw 恒等。含 CJK
- [x] 超宽 bold CJK 折行:w=8 时 `**甲乙丙丁**` 断两物理行,行尾 RESET 行头重开 bold,每行 vw≤8(tui-view.test C11 后接线锚,复用 C10 自闭机器)
- [x] user/tool 行 `#`/`**` 字面直折,逐字节 = 旧行为(AC-4 负锚;plain renderer 零改动)
- [x] 整屏多块 bot markdown 行数 ≤ height,含弹层时预算算术不变(renderView 锚)
- [ ] 真机流式无闪、半开围栏不崩、版式人审(HITL)—— 待用户跑 `mini` 验后勾
- 实现注记:markdown.ts 纯叶(import ansi,零回指);版式 2026-09-15 用户裁 = head 整行 B 不吃行内不分级 / code 行 DIM / 无序 `-`/`*`→`•`(有序段落字面)/ 沟 `│ ` 只落逻辑行首 / hr=─×ruleW;砍项见 DEFERRED「markdown v1」表

---

## C13 — 叠帧排查:columns 虚高致每帧滚进 scrollback?

**Type**: HITL(需本机终端取证) · **Blocked by**: 无

### What to build

现象(用户真机粘贴为证):每键/每 token 重绘都把旧帧推入 scrollback,规则线 ~180 字符。装机版 columns-1 修复已在,头号嫌疑 = 终端上报 columns > 真实可视宽(WSL 桥/缩窗未收 SIGWINCH)→ 满宽线折一行 → 帧高超 rows → 推滚动。步骤:① 记终端类型+窗口尺寸、缩窗看是否好转;② 临时帧首打印 `columns×rows` 探针定位;③ 根因落回本卡文后选最小刀(如留边 `columns-2` 或 resize 兜底),改动配回归。

### Acceptance criteria

- [ ] 终端类型/尺寸/复现结果与根因结论写回本卡
- [ ] 修复刀最小生效:连续打字与流式输出下 scrollback 不再叠旧帧
- 进行注记(2026-09-15):探针已埋 `tui.ts` requestDraw(`MINI_PROBE=1` 帧首印 `c= r= h= maxvw=`,定位完即删)。判读表:真实宽<c⇒SIGWINCH/WSL 桥虚报;maxvw≥c⇒渲染层超宽 bug;宽对仍折⇒终端把 ─▸⚠✻ 画双宽。取证卡在用户跑 `MINI_PROBE=1 node src/harness/cli.ts`(或装机版同变量)回传数字。附带发现:「缺 key 零反应秒退」= warn 未画帧即 stop+exit,已由 C15 启动解耦根治。

---

## C14 — 发布路径:装机版落后本地 7 commit

**Type**: AFK(push 面需人审带谁上车) · **Blocked by**: 无

### What to build

`~/.local/bin/mini` 跑 `~/.local/share/mini` = origin/main tarball(install.sh VERSION 默认 main);本地 main 领先 7(含卡9、C1+C2、types/memory 卡)→ 装机无弹层。刀:确认上车范围(含已提交 ca9d9d2;**工作区未提交的 bash.ts/bash.test.ts 属另一会话,不带**)→ 从 win git 带 gh token header push(既有先例)→ 重跑 install.sh → 真机验 `/` 弹层 + `/compact` 查表分发。

### Acceptance criteria

- [x] origin/main 与本地对齐(不含工作区未提交改动)—— 2026-09-15 win git + gh credential-helper push `1f2921e..3d106a7`(另会话随后叠 `c1f427e` docs),gh api 验远端 tip 与本地 rev-list=0;发货门前在 3d106a7 独立 worktree 跑全仓 = 283 passed
- [ ] 重跑 install 后真机 `mini` 出 `/` 弹层、/compact 走注册表分发
- [x] 另一会话的 bash.ts/bash.test.ts 原样未动 —— push 只推 commit;其 WIP 后由该会话自行提交(`3d106a7`),未混入本刀

---

## C15 — /model 自配 API key + 缺 key 启动不死

**Type**: HITL(密钥策略改 PRD,用户拍板) · **Blocked by**: 无(翻案 DECISIONS S4 / plan AC-S1-4「密钥只 env」)

### What to build

用户诉求:开 `mini` 即可用 `/model` 现场配 key、选模型,不再被 env 前置卡死。三刀:① 纯叶 `harness/keys.ts` = `resolveKey`(env 优先、0600 store 兜底)+ `loadKeys`(缺/坏降级空表)+ `saveKey`(合并写,tmp 创建期 0600 → rename 原子换);② cli 启动解耦:缺 key 不再 stop+exit(根治 C13 附带发现的「零反应秒退」),warn 入帧 + 发送门拦轮;③ `/model <alias> [key]`:带 key = 验 alias 后落盘再切,key 全程不回显;密钥住 `~/.mini/keys.json`,仓库零接触。下游适配器零改动(cli 合流后 `??=` 回填 env)。

### Acceptance criteria

- [x] keys.ts 四测绿:env 缺 store 兜底 / 两源 env 赢 / loadKeys 缺坏降级 / saveKey 合并 + `mode&0777==0600`
- [x] 离线端到端(隔离 HOME,慢喂管道):无 key 启动 warn 可见不退;发消息被发送门拦下;`/model qwen <key>` 落盘切换;无 key 换 `/model glm` 拒绝保原厂商;新进程 `/model qwen` 不带 key 命中 store 兜底
- [x] PRD 同步:plan.md 第 7 行 + AC-S1-4 改写、DECISIONS S4 打 ★ 修订
- [ ] 真机(TUI):`mini` 直开 → `/model qwen sk-xxx` 切换成功 → 重启 `/model qwen` 即复用(用户验后勾)
- 注:C15 的 `/model <alias> <key>` inline 形态已被 C18 收掉(2026-09-16),key 入口唯一化 = `/connect`(C16),2026-09-16 用户裁决照 kilocode。下方「真机」AC 的旧流程随此作废,等价验见 C18 剧本 1/10。

---

## C16 — 弹层选中特效(kilocode DialogSelect 移植)

**Type**: AFK · **Blocked by**: 无(建议先于 C17,C17/C18 弹层共用本机)

### What to build

现状 C9 补全弹层选中 = `▸`+B,无明暗分级。照 kilo `packages/tui/src/ui/dialog-select.tsx`(816 行)移植其「特效」(实为样式分级,无帧动画):

- 选中行 = **整行反色横带**(`\x1b[7m` 或 bg 常量,pad 满宽,C10 折行自闭机器复用),title BOLD,描述随选中换前景;未选行 title 本色、description 灰
- gutter 标记:当前项行首 `●`(主色)、已配 key 的厂商 `✓`(成功色)——数据由调用方注入,渲染层只画
- 零候选 → 不关层改显 dim `无匹配`(kilo No results found 语义;C9 现「自动收层」行为随之改)
- ↑↓ 环绕、首次移动选中行居中(= 视口切片把高亮行挪进中段)、层高度预算语义不变

刀 = `tui-view.ts` 纯函数面升级(`completionLines` → 泛化 `selectListLines(items, w, sel)`,items = {title, desc, mark?, active?}),`connectLines`/既有补全共用。kilo 的鼠标悬停/滚轮加速/分组头不抄(无对应输入面/单组数据)。

### Acceptance criteria

- [x] 选中行逐字节含反色开闭序列且 pad 满宽、行自闭(RESET 收尾);非选中行零反色
- [x] `●`/`✓` gutter 各占 1 列、续行缩进对齐;无匹配行 dim 且高亮位不指任何行
- [x] C9 既有补全测试零回归(diff=0 锚保留,除「零候选收层」一例按新语义改写)
- [x] 整屏行数 ≤ height 契约不破(弹层预算公式同步吃 No-results 行)
- ★ 真机裁决三轮 + 补裁(2026-09-16,用户验后):① 纯反色带太亮 → 透明轻档;② 透明档不直观 → 毛玻璃近似压暗带(7m+2m);③ **终档 = 零背景,选中整行换主题淡蓝**(`/命令` CYAN+B **连 desc 同蓝**,● CYAN 位标,未选行零主色反测钉死);④ 补裁 = title/desc 距离太近 → **描述列对齐(Claude Code 式):desc 统一贴最长 title+3 列**,未选行同步对齐,C9「未选行逐字节 diff=0」锚就此让位(结构锚仍全保:满宽 pad、vw 契约、行数封顶)。`INV` 叶撤,整层零 `\x1b[7m`。
- 注(2026-09-16 TDD 落地):`selectListLines(items, w, sel, maxRows)` 纯函数面六测钉死;超宽走 wrapLines 折行(每物理行满宽 pad 自闭、续行 2 列缩进对齐);视口自 sel 下/上交替扩 = 首移居中;未选行逐字节 = 旧 `completionLines` 非高亮行(diff=0 锚成立)。旧「▸/截断」两例视觉断言按新契约改写(结构锚全保:底线位、零竖线、行数封顶、超界不渲染、vw 满宽);`commands.test.ts` 零动。`ansi.ts` 新叶 `INV=\x1b[7m`(码点钉死)。tui.ts 键路由(零候选 Enter 落回整行提交、↑↓ 环绕)= 既有 W2 人工验缝,真机随 C17 抽验。

---

## C17 — `/connect` 向导:厂商层 → key 输入 → 落盘热切

**Type**: AFK(版式真机抽验) · **Blocked by**: C16(吃选中特效机)

### What to build

照 kilocode `packages/tui/src/component/dialog-provider.tsx` + `packages/opencode/src/auth/index.ts` 的 API-key 分支(用户裁决 2026-09-16「照 kilo」):

```
/connect → 厂商弹层(行 = alias · model-id · ✓已配/无)
  Enter:直接进 key 输入态(单 method,跳过 kilo 的多 method 选择)
    帧底独立态:标题「输入 <alias> API key」+ 端点/获取指引一行 + placeholder sk-…
    明文输入(kilo DialogPrompt 实况即 textarea 不打码,照抄;屏幕暴露风险已知晓并接受)
    ⏎ 空 → 不关继续等;kilo 同款
    ⏎ 非空 → saveKey(0600 合并写,复用 keys.ts)→ switchModel 同款校验 → 关层顶栏热切
    Esc → 任意步取消,零落盘
```

不抄项:kilo 的 instance.dispose()+bootstrap()(我们是单进程,无 server 层,saveKey 后 resolveKey 现读即生效)、OAuth 分支、Custom Provider 输入、配完顺手弹 DialogModel(一厂商一模型,无可选)。

刀 = `connect-flow.ts` 纯 reducer(state: idle|pick|keyIn{alias,buf};事件:↑↓/⏎/Esc/字符/backspace)+ `tui.ts` 键路由(与 confirmWait/askWait 同族的第三等待态)+ cli 注入口。reducer 迁移表全纯测。

### Acceptance criteria

- [x] reducer 迁移表驱动测:pick 环绕/进 keyIn/⏎空不落盘/⏎非空发 save+switch 意图/Esc 两步语义 —— `connect-flow.test.ts` 七测钉死;submit/cancel 是 effect,落盘/热切全在 cli 消费侧
- [x] 离线 e2e(隔离 HOME):键序走完 `qwen` 落 keys.json(0600)且顶栏换 id;Esc 全程 → 文件不生成 —— tmux PTY 四跑:pick ● Down×2 → qwen keyIn → 空⏎等待 → 明文 `sk-tui-1` → `{"qwen":"sk-tui-1"}` 600 + 「已切换 → qwen (qwen3.8-flash)」;Esc@pick 与 Esc@keyIn 打码中途均零落盘。plain 管道三跑同绿(慢喂防 EOF race,C15 先例):落盘+自动切 / 空 key 取消 / 未知厂商拒绝
- [x] 弹层样式逐字节走 C16 契约(反色带/●/✓);层开时聊天键位全部让位向导 —— pick = `selectListLines` 原机零新码(● 位标、✓ gutter 顶格、● 顶掉 mark、desc 列对齐,D capture 取证);向导活跃时 stdin 键全数进 reducer,聊天输入/弹层零触达
- [x] `/connect` 进 C9 命令注册表(补全可见),plain 模式回落后走既有逐行 ask 通道不弹层 —— plain = 逐行 ask(列厂商→alias→key)收齐交 cli 落盘+热切(与 TUI 同果,用户裁决 2026-09-16);TUI 提交 = 两连 ⏎(补全收起→提交,C9 既裁零变)
- [ ] 真机抽验(用户验后勾):版式手感 + ✓ 已配标记 + Esc 热退
- 注(2026-09-16 TDD 落地):e2e 揪出**连发吞键**真 bug —— tmux 连发/长按 repeat 把 `"\x1b[B\x1b[B"` 并成单 data 事件,整串全等匹配全吞;向导支改 token 流解析(CSI=\x1b[. 整串 + 可打印逐字符,`no-control-regex` 注释走 tui-view 同款)。chat 支同弱点系既有(C16 W2 缝外)未动,卡外发现记账。`ensureKey` warn 文案仍指 `/model <alias> <key>` = C18 收口位,零越界。

---

## C18 — `/model` 收 inline-key 形态:key 入口唯一 = /connect

**Type**: AFK · **Blocked by**: C17

### What to build

`/model <alias>` 保留(只切 env/已配 key 的厂商,缺 key 报「/connect 配置」);`/model <alias> <key>` 形态删除(聊天记录明文留 key 的风险随 C15 的这条通道一起收)。C15 卡的 AC 措辞与 plan/DECISIONS 相关句跟改:key 落盘入口唯一 = `/connect`。

### Acceptance criteria

- [x] `/model qwen sk-xxx` 不再落盘:报「多余参数」用法行;C15 已存 keys.json 仍可切(剧本 1/2/10 + `splitModelArg` 表测 4 例;被拒 key 零落盘 = 剧本 6,明文不回显 = 剧本 7)
- [x] C15 离线剧本重跑(键入口换 `/connect` 后)全绿;switchModel 单入口零分叉(剧本 10/10;saveKey 调用点实测仅剩 cli.ts:236 /connect 一处)
- [x] 文档三处同步:ISSUES C15 注、plan.md AC-S1-4、DECISIONS S4(入口名改 `/connect`)
- 实现注(2026-09-16 TDD):参数判定抽 `commands.ts` 纯缝 `splitModelArg`(alias 单 token,第二 token = 多余,不回传 key 本体);cli 接线删 inline 分支,ensureKey warn 与注册表 usage 同步改口,providers.ts 头注释随修。剧本坑记:plain REPL 下 `rl "close"→process.exit` + 启动期 ensureKey 的 await 让 burst 行无人认领即丢 —— 喂 stdin 必须逐行前置 sleep(`/tmp/c18-e2e.sh` 留档)。

---

## C19 — edit 工具红绿 diff 上屏(Claude Code 式展示 · tracer bullet)

**Type**: AFK(真机抽验) · **Blocked by**: 无(三卡之首,C20/C21 共用其机器)

### What to build

现状:`tool_execution_end` 的 result 被 `previewResult`→`oneLine(80)` 压成一行,换行全杀,屏幕上永远看不到代码改动本体。本片单刀穿全层(schema→工具→事件→渲染),打通「工具产出结构化 diff → TUI 上色折叠」的弹头通道,参照 Claude Code `⎿` 树 + Kilo 渲染分级:

- `ToolResult` 加可选 `details` 侧信道。关键事实(2026-09-16 源码核):run-loop 把 result **按引用**塞进事件(`result: unknown` 透传),loop/stream **零改动**;持久化只走 `content` → provider 每轮重吃大 diff 的 token 污染从根上绕开。载荷形状(原型期决策形,实现时照此钉):

```ts
export type ToolDetails =
  | {
      kind: "diff";
      path: string;
      added: number;
      removed: number;
      hunks: DiffHunk[];
      truncated?: boolean;
    }
  | { kind: "out"; text: string }; // C21 消费,本片只定形状
export interface DiffRow {
  t: "+" | "-" | " ";
  s: string;
}
export interface DiffHunk {
  oldStart: number;
  newStart: number;
  rows: DiffRow[];
}
```

- 新纯叶 `src/util/diff.ts`:行级 diff = 掐公共前后缀 + 中段 LCS DP(滚动 Int32Array);中段积 >250k 格退化为全删全增(仍正确,计数恒全量);hunk = 变更行 ±2 上下文,gap ≤2·ctx+1 并带;存 hunk 行封顶 180 + `truncated`。非 Myers:四倍代码换不来 ctx=2 预览可感知的最小性。零 npm 红线内手撕。
- edit.ts 成功分支挂 `details = diffDetails(path, 全文旧, 全文新)`(两串已在内存,零额外 I/O);失败/abort 零 details → warn 路径逐字节旧样。
- TUI:`Entry` 加可选 `details?`(不新增 EntryKind,无 details 旧路径白拿 diff=0 锚);`entryLines` 加第三参 `verbose = false` 透传;渲染枝输出 = `⎿`(U+23BF,码点常量,WT 若画双宽退 `└` U+2514,C13 探针流程判)+ `+N`/`−M` 汇总行 + hunk 行(`+` 绿 `-` 红 上下文 dim,续行 2 列缩进),非 verbose 正文 8 行封顶 + `… +N 行(Ctrl+O 展开)`,复用 C11 think 折叠同机关。行仍走 wrapLines→tail-slice→pad 管道,columns-1/≤height/vw=width 三契约结构不破。
- `ansi.ts` 新叶 `RED = \x1b[31m`(逐条 pin 用例同步)。

### Acceptance criteria

- [x] `util/diff.test.ts`:纯增/纯删/中段替换 ctx=2 窗/近距并 hunk 远距拆/gap=2·ctx+1 边界/600×600 走退化路且 added·removed 计数精确/尾换行翻转显 ± 空行/超 180 行 `truncated:true` 计数仍全量
- [x] edit.test:成功 run → details 的 ± 行与锚点区一致且原行成 `" "` 上下文;abort/未命中 → `details === undefined`
- [x] tui-view.test 新 describe:红绿开闭序列逐字节(码点钉)、折叠算式(实现取 12 行 → 8 + `… +4 行`,9 行时折叠与 verbose 行数同 = 歧义故换)、verbose 全展、含大 diff 条目整屏仍 ≤height 且每行 vw=width;无 details tool 条目 = diff=0 锚逐字节不变;user/bot/warn 负锚
- [x] stream/serialize/session 文件零动;`--continue` 回放与今平价(tool 结果本就不落盘)
- [ ] 真机抽验(W2):TTY 让 agent edit 一行 → 眼看 `-` 红 `+` 绿、上下文灰、`⎿` 单宽;Ctrl+O 展开;文案(`⎿ +N −M 行` / `… +N 行(Ctrl+O 展开)`)人审终判写回本行

---

## C20 — write 覆盖 → 全文件 diff

**Type**: AFK · **Blocked by**: C19(diff 机器 + 折叠渲染全复用,本片只添一次读)

### What to build

write.ts 今天盲写(不读旧内容)。在其既有 per-path enqueue 串行内、`writeFile` 前加 best-effort 读旧:ENOENT = 新建 → 旧串按空 diff = 全绿;其他读失败 = 降级当新建但**写入照常成功**(不因展示层饿死主功能)。成功分支挂 `details = diffDetails(path, 旧, a.content)`,与 edit 同机器同折叠同色规。

### Acceptance criteria

- [ ] write.test:新建 → 全 `+` 行 removed=0;覆盖 → 红绿真 diff;旧文件 EACCES → details 按新建算且写入不失败
- [ ] 读发生在 enqueue 串行段内(无新并发面),既有 write 时序测试零回归
- [ ] 真机抽验:让 agent 覆盖一个既有文件 → 屏上见红删绿增,`⎿` 汇总计数对

---

## C21 — bash → `⎿` 输出树(折叠同式)

**Type**: AFK(文案终判需人) · **Blocked by**: C19(共吃 `details` 侧信道与折叠式样;与 C20 并行)

### What to build

bash 成功返回挂 `details = { kind: "out", text: content[0].text 原文 }`(不发明新结构,存的就是模型吃到的那段:exit code 行 + tail 截断 + `full output: path` 尾注,原样)。TUI 两处:

- header 后缀:`kind==="out"` 时 `previewResult` 改取 content **首行**(如 `bash ls → exit code 0 ✓`),不再三行压扁;其余 kind 旧式逐字节不变
- 正文:`⎿ ` 首行 + 后续行 DIM 两列缩进,8 行封顶折叠,同 C19 式样同 Ctrl+O 全展

timeout/错误 fail 分支零 details → 旧 warn 路径不动。plain 模式零动(增量打印机无折叠机关,DEFERRED 既有「TUI 差分渲染」行随 C19-C21 落地划掉)。

### Acceptance criteria

- [ ] bash.test:`echo hi` 成功 → `details.text === content[0].text`;timeout 路径 → undefined
- [ ] tui-view.test:out 树逐字节(⎿ 首行/续行缩进/30 行 → 8 + `… +22 行` 折叠算式/verbose 全展);header 首行式对 `out` 生效且其余 kind diff=0 负锚
- [ ] 真机:跑 `seq 30` → 树 8 行折叠,Ctrl+O 全展;文案终判写回

---

# D 系列 — 生产运行加固(MAF 图案移植批)

源 = 2026-09-16 microsoft/agent-framework 调研对话 + `docs/PRD-V2.md`(故事号引该文件)。结论基线:MAF 无 TS SDK,只移植图案不引代码;新依赖恒零。合并序 D1→D2→D4,D3 刀位独立(runLoop)可穿插,D5 收尾。现行 bug 靶心:toolResult 从未落盘(D1 修)。

---

## D1 — toolResult 即时落盘 + resume 悬空配对修复 + maxTurns 续计

**Type**: AFK · **Blocked by**: 无(D 系列之首;D2 接线位长在本卡分发表上)

### What to build

Bug:cli 落盘只订阅 `message_end`,而 runLoop 对 toolResult 不发 message_* 事件(只随 turn_end 携带)→ toolResult 永不进 JSONL → 带工具的会话 `--continue` = 末条 assistant 悬空 toolCall、配对全缺 → 两方言 toWire 把悬空 tool_calls 喂给 provider → 400。三刀(承 PRD-V2 Implementation Decisions):

1. 纯叶 `memory/journal.ts` `eventToEntries(event)`:新增 `tool_execution_end` → `{type:"message", payload:ToolResultMessage}`;cli 订阅环从硬编码 if 改查此表,assistant 的 message_end 落盘行为逐字节不变(entry 仍 5 类零新增)。
2. 同文件 `repairDangling(messages)`:末条 assistant(`stopReason==="tool_use"`)的 toolCall id 集 − 其后已存在 toolResult 的 toolCallId 集 = 缺位;逐个合成 `{isError:true}` 文本「interrupted before result was persisted — 副作用可能已发生,先核实(bash 重跑前查盘)再重试」;接 `SessionManager.rebuild()` 出口,loop/cli 零感知。
3. maxTurns 续计:cli 侧纯函数从重建 messages 派生「末条 user 之后的 assistant 数」作偏移传入既有 `maxTurns` 选项,loop 零改动。

### Acceptance criteria

- [x] journal.test:`tool_execution_end` → 恰一条 message entry(payload role=toolResult 字段完整);message_end 输出与现行逐字节同;其余事件种 → 零条
- [x] repairDangling 表测:无悬空 = diff-0 / 两缺其一 = 只补一条 / 末条非 tool_use = 不动 / 多 toolCall 全缺 = 按调用序全补
- [x] S3 临时目录:append 全剧本 → 新 `open().rebuild()` → messages 零悬空;两方言 toWire 各一例锚:请求体零悬空 tool_use / tool_use 与 tool_result 一一配对(S2 离线 fixture 先例)
- [x] maxTurns 偏移纯函数测(假 messages 表驱动:0 turn / 中途 user 重置 / 末条 user 未回)
- [x] e2e 剧本(plain 慢喂,逐行 sleep 防 EOF = C18 教训):kill -9 于 bash 执行中 → `--continue` 发消息 → 断请求体含「结果未知」补位行;脚本留档并把结论写回本卡
- [x] 全仓零回归 + typecheck/eslint/prettier 干净

### 实现注记(2026-09-16,TDD 红→绿全程)

- **规模**:journal.test 23 例(分发表全 10 事件种 + repairDangling 边界含位置 6 例 + turnsSinceLastUser 3 例)/ session-manager.test D1 组 2 例(S3 临时目录全剧本 + 修复后续聊不塌尾)/ 两方言 toWire 锚各 1 例。判卷基线 = 主树 HEAD 7b2287a;全仓 362 passed | 1 skipped(含并行 D3 WIP 增量),typecheck/eslint(0 error)/prettier 净。
- **裁决修正(卡片措辞 → 实现,补 2 红测钉死)**:repairDangling 补位 = 插在「该批末条已有结果之后」而非数组尾 —— resume 后用户续聊落了盘再 rebuild 时,尾插会让 tool 行吊在新 user 行之后,openai 方言必 400;wire 硬要求 = tool 紧跟带 tool_calls 的 assistant。
- **e2e**:脚本 `/tmp/d1-e2e.sh` + 机关 `/tmp/d1-fakefetch.mjs`(`node --import` 进程内 patch 全局 fetch = 假流回放 + 请求体落盘,用户裁决 2026-09-16;零网络零改 src)+ 断言器 `/tmp/d1-logcheck.mjs`。**判卷树 = `git worktree /tmp/d1-base` detached@7b2287a + D1 工件**(主树混着未合的 D3 WIP,不作判据,见下条)。7/7 PASS:echo 结果先落盘(刀 1 本体)/ sleep 在飞被杀 c2 悬空在盘 / 修复行不落盘(投影幂等)/ resume 请求体 roles=[system,user,assistant,tool,tool,user] 配对完整、c2 含「结果未知」逐字。
- **⚠ 跨卡发现(给 D3)**:主树 D3 WIP 把 `tool_execution_end` 全憋到 `Promise.allSettled` 批齐后才发 → 故事 1「工具一执行完结果就落盘」退化为批级落盘:长兄弟 call 在飞时 kill = 已完成 call 的结果又丢了(e2e 断言 #2 在 WIP 树上红 = 实证)。D3 合入前应改「每个 run settle 即发 end 事件,allSettled 只管按调用序回填 messages/toolResults」;不改则故事 1 措辞收口归 D5。
- **判据面注记(按卡字面,不改)**:只盯末条 assistant 且 `stopReason==="tool_use"`;aborted/error 批次带残 toolCall 块的悬空不在修复面(同样 400 风险面,但无在飞副作用,场景边缘),DEFERRED 候选顺手记一笔。
- **maxTurns 续计**:cli `turnBudget = max(0, 50 − turnsSinceLastUser(启动 rebuild messages))` 传既有 options;50 与 run-loop 缺省两处同值(loop 零改动裁决),已双向注释。全新会话 offset = 0 = 现行行为逐字节不变。

---

## D2 — AgentEvent trace 落盘(JSONL 旁挂,`--no-trace` 可关)

**Type**: AFK · **Blocked by**: D1(同刀 cli 订阅环;D1 的 journal 分发表 = 本卡接线位)

### What to build

纯叶 `harness/trace.ts`:`traceLine(event, clock) → string`,行 = `{ts, agentId?, ...event}`,事件名与字段原样保留(日后转 OTLP 不改格式,故事 10)。零 fs 在叶内;cli 订阅环逐事件 appendFile 到 `~/.mini/sessions/<cwd编码>/<会话>.trace.jsonl`(与会话文件同目录旁挂)。缺省即开;`--no-trace` = parseArgs 新 flag(args.ts 纯缝先例)。harness 故意浅不破:裁决零渗,接线只有 append。

### Acceptance criteria

- [x] traceLine 表测:10 类事件各类一行、ts = 注入 clock、键序稳定逐字节可断;turn_end 的 messages/toolResults 序列化完整
- [x] args.test:`--no-trace` 解析 + 缺省 = 开
- [x] 离线端到端(隔离 HOME + 假流剧本):一场含工具对话 → trace.jsonl 行数 = 事件数且与会话文件双写互不吞行(两文件都在、语义各自完整);`--no-trace` 跑同剧本 → 零 trace 文件
- [x] 全仓零回归

### 实现注记(2026-09-16,TDD 红→绿全程)

- **规模**:trace.test 12 例(10 种全覆盖 + clock 注入 + 键序逐字节含 agentId 提升位预锚 + 双写端到端 2)/ args.test 净 +3(既有全对象断言 9 例补 `trace:true`,红在实现缺字段)/ session-manager.test D2 组 4 例。判卷基线 = detached worktree @3b72f26 = 362 passed | 1 skipped → 净 +19 = 381|1;typecheck/eslint(0 error)/prettier 净。
- **红测捞出的真 bug(同目录共存面)**:旁挂 `.trace.jsonl` 会被 `open()`(mtime 最新 = 恒吞)/`list()`(--resume 选择器假会话)吞掉(实证续写出 `.trace.trace.jsonl`)。修 = 两处扫描排除 `.trace.jsonl` 后缀 + 靶向锚测「trace mtime 更新仍不被选为会话」。`_${sessionId}.jsonl` 精确匹配天然不受累(不动)。
- **agentId 裁决**:卡行形状 `{ts, agentId?, ...event}` 字面 = agentId 提升为 ts 后首键(非事件字面序尾随)→ `traceLine` 解构提升;缺省 undefined → JSON.stringify 零键 = D4「主代理行 diff-0」预锚。`as AgentEvent & { agentId?: string }` cast = D4 契约扩预留位,届时摘。
- **接线必要新增(用户裁决 2026-09-16)**:`SessionManager.traceFile(): string | null` getter —— 会话文件名含 uuidv7 且延迟首建,类外不可知;纯推路径永不碰盘(卡「落盘动作住 cli」裁决不破)。cli 订阅环 3 行 = render → trace append(先写,下游抛错不吞观测面)→ journal 查表。
- **e2e**:脚本 `/tmp/d2-e2e.sh` + 机关 `/tmp/d2-fakefetch.mjs`(承 D1,唯一改 = SSE 按请求队列消耗,一场进程跑完工具轮+终答轮)+ 断言器 `/tmp/d2-tracecheck.mjs`(逐行 parse/ts 单调非减/首尾 agent_*)。判卷 = 主树直跑(与 D4 零文件交叉)。12/12 PASS:旁挂兄弟位、行数=事件数(仓内 e2e 锚等式;真机断 ≥12 + 首尾对 + 工具事件对)、会话 5 类 entry 合法、D1 配对语义未踩、`--no-trace` 零 trace 且会话照常落。

---

## D3 — 同批 toolCall 两段式并行(A 弹检串行 / B 并发 / 调用序回填)

**Type**: AFK · **Blocked by**: 无(刀在 runLoop 工具批区,与 D1/D2 零冲突,可并行开发)

### What to build

runLoop 工具批区改两段:A 段逐 call 串行完成 validate → danger → rules/session/readonly/autoAccept → confirm await 弹窗(收集已过门的 run 闭包;`tool_execution_start` 移到 B 段前按调用序统一发),A→B 之间查 signal(既有 aborted 缝保留);B 段 `Promise.allSettled` 并发执行 run 闭包,results 按调用序回填 messages 与 toolResults;abort 杀死致缺位 → 合成 `{isError:true,"aborted"}` 补位不破配对。terminate 语义不变(全批完成再停)。write/edit 互斥仍靠既有 per-path 写队列;bash 在飞吃 signal(Story 16 机制零动)。弹窗体验:对人仍一次一个。

### Acceptance criteria

- [x] registry.test D3 组:假流两独立 read call → 假工具闭包记录 start 窗口重叠(第二个 start 早于第一个 end),回填序 = 调用序
- [x] 两未预批 call:confirm 恰 2 次且串行(第 2 次弹时第 1 次已答完),双 yes → 两 run 并发执行
- [x] abort A 后 B 前命中 → B 不启动,整批走既有 aborted 路径(AC-L3-4 剧本逐字节同);B 中途 abort → 缺位全补 isError,配对完整(两方言 toWire 可过)
- [x] 单 call 批 = 现行行为逐字节(dif-0 负锚:既有工具批剧本全绿零改)
- [x] anyTerminate 批仍全批完成后停(AC-L3-5 复验)
- [x] 全仓零回归(基线 = 合卡前 HEAD 全绿数写回本卡)——基线卡:7b2287a = 330 passed | 1 skipped(其 detached worktree 实测),D1 = 3fe6277(本卡净 +5 锚;合卡数= 其 HEAD 全绿 +5,以 commit 钩子实测为准)。翻案注:AC-L2-3 原「同批串行」钉就地改写为两段式断言(run-loop.test),DECISIONS 记账归 D5。

---

## D4 — task 子代理:runLoop-as-a-Tool(只读首版)

**Type**: AFK · **Blocked by**: D2(child 事件带 agentId 进 trace 的 AC 吃它;D3 合后自动获得并发 N 个 task 的 superstep 之效,非硬依赖)

### What to build

契约扩先行:`AgentEvent` 全 10 类可选 `agentId?: string`(types.ts 头注记照「maxTurns 唯一故意偏离」先例补一行;缺省 = 主代理,loop 体零特判透传)。新 `tools/task.ts`:`makeTaskTool({streamFn}) → Tool`,schema `{prompt:string}`;`run()` = 递归 `runLoop(streamFn, [read], fresh context, {confirm: confirmDeny, maxTurns: 20, signal: 父})`;child 全部事件打 agentId;结果 = child 末条 assistant text → content,child usage 合计一行进 trace(agent_end);失败/abort 面:child error 行 → 父收 isError toolResult,父循环不断。`confirmDeny` 纯叶:凡未 preapproved 答 `{kind:"no", reason:"sub-agent headless"}` —— 从 child 侧堵 `run-loop.ts` 「缺 confirm = 放行」洞(loop 缺省行为本卡不改,改它 = DEFERRED 候选)。child 工具 = [read],永不含 task = 深度 1 硬编码。cli 注册进 TOOLS(system prompt 工具集重建 = 既有机制);TUI 首版仅 tool_execution_start 派生「▸ task 运行中」一行,全量归属渲染 = DEFERRED 候选。

### Acceptance criteria

- [ ] task.test:makeTaskTool 面(schema/description/无 skipConfirm);child 工具集 = 白名单表断(无 task 无 bash 无 write/edit)
- [ ] confirmDeny 单测:任意 prompt → `{no, "sub-agent headless"}`
- [ ] S1 双层套娃剧本:父假流吐 task toolCall → child 独立假流(read → 作答)→ 父 messages 配对完整、child 末 text 成 toolResult、child 内 error 假行不断父循环
- [ ] deny 洞负例:child 工具集经测试注入换假 bash → 零弹窗、父收 `user rejected: bash — sub-agent headless`、循环继续
- [ ] agentId e2e(隔离 HOME + 假流):trace.jsonl 有 child 行且 agentId 非空;主代理行零该键(diff-0 锚)
- [ ] abort 透传:父 signal 命中 → child 在飞工具被杀、双层 agent_end reason=aborted、父批补位配对完整
- [ ] 全仓零回归

---

## D5 — spec 同步(DEFERRED 划两行 + DECISIONS ★修订 + 文案收口)

**Type**: HITL(修订文案需人审) · **Blocked by**: D1–D4

### What to build

DEFERRED.md 划账:「并行 tool 执行」(D3)与「sub-agent」半行(D4;plan mode 半行不动);PRD.md:150 摘要行不动(行号锚定死教训 = C8),只在 DEFERRED 原条目处注「已由 D 系列翻案,见 PRD-V2」。DECISIONS.md「② 修订记录」表加两行:原决策(pi 刻意下放 / v1 串行确认门)→ 现决策(superstep 两段并行 / 只读深度 1 子代理)→ 引 D3/D4 + PRD-V2 故事号。D1-D4 落卡期间实现注记与 PRD-V2 措辞冲突处(agentId 取值方案、confirmDeny 住家、trace 文件名)以本卡统一收口。DEFERRED 候选新增:child 写权限 + 审批上抛(P5 触发式)、agentId 全量归属渲染、loop 缺 confirm 改默认拒。

### Acceptance criteria

- [ ] 四文档互检无矛盾(PRD-V2 / ISSUES / DECISIONS / DEFERRED;对照 = 翻案两行、★两行、D 卡 AC 注记映射表)
- [ ] 修订行文案人审签号(HITL)
- [ ] 本卡零生产码改动,全仓绿
