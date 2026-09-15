# ISSUES — 确认门重构(Claude Code 式分层决策)

本地 tracker。源 = 2026-09-15 设计对话(plan: confirm 系统分层流水线)。
目标:弹窗从"每次工具调用"降为"仅未预批且非只读的边界动作",同时堵复合命令越权洞。
分层顺序(所有片共同遵守):工具分级 → 参数解析 → 危险黑名单 → allow 判定(内置只读表 + rules)→ 弹窗兜底。
合并顺序 C1→C2(同碰 rules.ts)。C6/C8/C9 为 HITL,需人审文案/spec/视觉。显示升级三卡 C10(折行地基)→C12(排版)按序合,C11 可与 C10 并行;C13/C14 独立运维/诊断,C14 先跑让装机追平基准。

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

- [ ] `["git","status"]` 规则:`git status -sb` 免弹、`git commit` 弹
- [ ] 旧 `{prefix:"git:*"}` 载入 ≡ tokens `["git"]`,`git push` 免弹
- [ ] `*` / 空数组种子拒写,always 退化一次性 yes
- [ ] 匹配器纯函数 vitest 覆盖边界(空命令、多余空白、flag 首 token)
- [ ] loop 源零 try/catch 约束保持

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

- [ ] `ls -la`、`git diff HEAD`、`git status -sb` confirm 零调用、且 rules.json 不落新条目
- [ ] `cat x > y`、`ls > /tmp/a`、`find . -delete` 必弹
- [ ] 白名单命中与 pre-existing 规则命中等价地短路 confirm(顺序在黑名单之后,见 C5)
- [ ] 假危险工具(未声明 skipConfirm)不受表影响,必弹(AC-T2-6 不破)

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
- [~] 键盘映射:`mapConfirm` 四档 1/2/3/4 + `4 <理由>` 有测(tui.test.ts);TUI 确认等待态吞行不破坏 = 归 C8 W 剧本人工跑
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

- [ ] plan.md AC-T2-* 全部与实现一致,无残留"首 token"表述
- [ ] DECISIONS T4 修订注明日期与被修订理由(引用本文件 C1–C7)
- [ ] 新 W 验收剧本六幕人工跑通,判卷记录进 plan.md

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

- [ ] splitBlocks/styleInline/renderMarkdown 三函数锚点直测(未闭合围栏、未闭合定界符降级)
- [ ] 恒宽式 `vw(styleInline(s))===vw(s)` 含 CJK 用例钉死
- [ ] 超宽 bold CJK 段折行后每物理行自闭且 vw≤w(依赖 C10)
- [ ] user/tool 行 `#`/`**` 保持字面不过 markdown
- [ ] 整屏多块 markdown 行数 ≤ height,弹层高度预算算术不变
- [ ] 真机流式无闪、半开围栏不崩、版式人审(HITL)

---

## C13 — 叠帧排查:columns 虚高致每帧滚进 scrollback?

**Type**: HITL(需本机终端取证) · **Blocked by**: 无

### What to build

现象(用户真机粘贴为证):每键/每 token 重绘都把旧帧推入 scrollback,规则线 ~180 字符。装机版 columns-1 修复已在,头号嫌疑 = 终端上报 columns > 真实可视宽(WSL 桥/缩窗未收 SIGWINCH)→ 满宽线折一行 → 帧高超 rows → 推滚动。步骤:① 记终端类型+窗口尺寸、缩窗看是否好转;② 临时帧首打印 `columns×rows` 探针定位;③ 根因落回本卡文后选最小刀(如留边 `columns-2` 或 resize 兜底),改动配回归。

### Acceptance criteria

- [ ] 终端类型/尺寸/复现结果与根因结论写回本卡
- [ ] 修复刀最小生效:连续打字与流式输出下 scrollback 不再叠旧帧

---

## C14 — 发布路径:装机版落后本地 7 commit

**Type**: AFK(push 面需人审带谁上车) · **Blocked by**: 无

### What to build

`~/.local/bin/mini` 跑 `~/.local/share/mini` = origin/main tarball(install.sh VERSION 默认 main);本地 main 领先 7(含卡9、C1+C2、types/memory 卡)→ 装机无弹层。刀:确认上车范围(含已提交 ca9d9d2;**工作区未提交的 bash.ts/bash.test.ts 属另一会话,不带**)→ 从 win git 带 gh token header push(既有先例)→ 重跑 install.sh → 真机验 `/` 弹层 + `/compact` 查表分发。

### Acceptance criteria

- [ ] origin/main 与本地对齐(不含工作区未提交改动)
- [ ] 重跑 install 后真机 `mini` 出 `/` 弹层、/compact 走注册表分发
- [ ] 另一会话的 bash.ts/bash.test.ts 原样未动
