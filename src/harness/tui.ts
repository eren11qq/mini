// P2 聊天框 I/O:ChatIO 统一缝 + 两实现,cli.ts 只认接口(AC-H1-3 组装层零业务逻辑保持)。
//   createTui —— TTY 默认:raw mode 键盘 + 整屏重绘,画面全部出自 tui-view 纯函数(变体 A 定稿,ADR-002)。
//   createPlainIO —— 非 TTY/管道回落:H1 原裸 readline + 增量 renderer,行为与旧 cli 一致。
// loop/stream/memory 零改动;确认门/中断/落盘裁决仍全在 loop 与 cli 既有缝里。
import { createInterface } from "node:readline";
import type { AgentEvent, AgentMessage, ConfirmAnswer } from "../loop/types.ts";
import { DIM, RESET } from "./ansi.ts";
import { filterCommands, type SlashCommand } from "./commands.ts";
import { createRenderer } from "./renderer.ts";
import {
  entriesFromMessages,
  liveEntry,
  previewArgs,
  previewResult,
  renderView,
  vw,
  type CompletionView,
  type Entry,
  type TuiView,
} from "./tui-view.ts";

// C6:答案契约住 loop(单一事实源),本侧只 re-export 保 cli.ts 既有对外面。
export type { ConfirmAnswer };

export interface ChatIO {
  readonly mode: "tui" | "plain";
  start(): void;
  stop(): void;
  /** 下一行输入。label 仅 plain 模式当提示符;tui 回显由 user 条目天然完成。 */
  ask(label?: string): Promise<string>;
  confirm(prompt: string): Promise<ConfirmAnswer>;
  render(event: AgentEvent): void;
  note(line: string): void;
  warn(line: string): void;
  setModel(modelId: string): void;
  loadHistory(msgs: AgentMessage[]): void;
  onInterrupt(cb: () => void): void;
}

// 帧写序列(纯函数,tui.test 钉死):home 顶格重写 + 帧尾 [J。禁 2J —— Windows Terminal 将其
// 解释为"整屏滚进 scrollback 再清",每帧存档 = 连续叠框(本次回归的根因)。
export const frameBytes = (probe: string, body: string): string =>
  `\x1b[H${probe}${body}\x1b[0m\x1b[J`;

// C6 四档键位映射:1/y/yes=一次性、2=session、3/always*=落盘、其余=拒。
// 旧三档的 2=always 作废(session 插位,always 顺位 3);拒时"其余皆拒"的兜底语义不变。
export function mapConfirm(answer: string): ConfirmAnswer {
  // 档位 = 首个空白前的 token(判定用小写);理由 = 其后原文(不降大小写,中文/英文原样)。
  const raw = answer.trim();
  const sp = raw.search(/\s/);
  const key = (sp < 0 ? raw : raw.slice(0, sp)).toLowerCase();
  const rest = sp < 0 ? "" : raw.slice(sp + 1).trim();
  if (key === "1" || key === "y" || key === "yes") return { kind: "yes" };
  if (key === "2") return { kind: "session" };
  if (key === "3" || key.startsWith("always")) return { kind: "always" };
  if (key === "4" && rest !== "") return { kind: "no", reason: rest };
  return { kind: "no" };
}

export function createTui(opts: { cwd: string; commands: readonly SlashCommand[] }): ChatIO {
  let modelId = "…";
  let entries: Entry[] = [];
  let live: Entry | null = null;
  let input = "";
  let busy = false;
  let started = false;
  let verbose = false; // C11:Ctrl+O(\x0f)切 think 全文/折行;纯视图态,不落盘
  let askWait: ((s: string) => void) | null = null;
  let confirmWait: ((s: string) => void) | null = null;
  const pending: string[] = []; // busy 期按 ⏎ = 排队,本轮 main 回到 ask 立即领走
  let interrupt: (() => void) | null = null;
  // C9 补全弹层 = 纯视图态:确认等待中/Esc 收起/非 "/" 行首 → 不出弹层;提交语义零改动。
  let compSel = 0;
  let compDismissed = false;
  const popupItems = (): SlashCommand[] =>
    confirmWait || compDismissed || !input.startsWith("/")
      ? []
      : filterCommands(opts.commands, input);
  const popupOpen = (): boolean => popupItems().length > 0;
  const acceptCompletion = (): void => {
    const items = popupItems();
    const it = items[Math.min(compSel, items.length - 1)];
    if (!it) return;
    input = `/${it.name}${it.usage ? " " : ""}`;
    compSel = 0;
    compDismissed = true; // 补全后收起:再按 Enter = 照常整行提交
  };
  const afterEdit = (): void => {
    compDismissed = false; // 任何编辑重开弹层(退格过 "/" 由非 "/" 前缀自然收起)
    compSel = 0;
  };
  const compView = (): CompletionView | null => {
    const items = popupItems();
    if (items.length === 0) return null;
    const sel = Math.min(compSel, items.length - 1);
    return {
      items: items.map((c, i) => ({
        name: c.name,
        description: c.description,
        highlighted: i === sel,
      })),
    };
  };

  const restore = (): void => {
    process.stdout.write("\x1b[?25h\x1b[0m");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  };
  // 同事件轮多次变更并成一次重绘(message_update 逐 token 到达 = 免闪)。
  let drawQueued = false;
  const requestDraw = (): void => {
    if (drawQueued || !started) return;
    drawQueued = true;
    setImmediate(() => {
      drawQueued = false;
      if (!started) return;
      // columns-1:写满整列会触发终端自动折行,每帧卷出多余物理行 → 超 rows 滚动、旧帧叠进 scrollback。
      const width = Math.max(20, (process.stdout.columns ?? 90) - 1);
      const height = process.stdout.rows ?? 24;
      const ephemeral: Entry | null = live ?? (busy ? { kind: "dim", text: "⋯" } : null);
      const view: TuiView = {
        modelId,
        cwd: opts.cwd,
        entries,
        live: ephemeral,
        input,
        busy,
        width,
        height,
        completion: compView(),
        verbose,
      };
      // 零 \x1b[2J:Windows Terminal 把 2J 解释成"整屏滚进 scrollback 再清",每帧存档 = 连续叠框。
      // 帧恒 ≤ rows 行,home + 顶格重写即可覆盖;帧尾 \x1b[J 抹比上一帧矮时的残底;
      // 窄行残字由 renderView 行满宽 pad 防(见 tui-view 同批改动)。
      // C13 临时探针(MINI_PROBE=1 才画,定位完即删):c=上报列 r=上报行 h=帧逻辑行(未折) maxvw=帧内最宽行。
      // 判读:c > 窗口真实可视宽 ⇒ SIGWINCH 未达/WSL 桥虚报;maxvw ≥ c ⇒ 我方超宽 bug;
      //       maxvw < c 仍折行 ⇒ 终端把模糊宽度字符(─ ▸ ⚠ ✻)画成双宽。探针行自身 +1 帧高,属诊断行为。
      const body = renderView(view);
      const probe = process.env.MINI_PROBE
        ? (() => {
            const ls = body.split("\n");
            return `${DIM}[probe] c=${process.stdout.columns} r=${process.stdout.rows} h=${ls.length} maxvw=${Math.max(0, ...ls.map(vw))}${RESET}\n`;
          })()
        : "";
      process.stdout.write(frameBytes(probe, body));
    });
  };
  const submit = (): void => {
    const text = input.trim();
    input = "";
    afterEdit();
    if (confirmWait) {
      const f = confirmWait;
      confirmWait = null;
      if (text !== "") entries.push({ kind: "user", text });
      f(text);
    } else {
      if (text !== "") entries.push({ kind: "user", text });
      if (askWait) {
        const f = askWait;
        askWait = null;
        f(text);
      } else if (text !== "") pending.push(text);
    }
    requestDraw();
  };

  return {
    mode: "tui",
    start() {
      if (started) return;
      started = true;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdout.write("\x1b[?25l");
      process.on("exit", restore);
      process.stdout.on("resize", requestDraw);
      process.stdin.on("data", (buf) => {
        const s = buf.toString("utf8");
        if (s === "\x03") {
          // Ctrl+C:有挂起确认/提问先按"否/空"解掉(防 loop await 卡死),再交 cb——
          // busy 时 cli 的 cb = abort 当前轮(语义在 loop),空转时 = 退出。
          if (confirmWait) {
            const f = confirmWait;
            confirmWait = null;
            f("no");
          }
          if (askWait) {
            const f = askWait;
            askWait = null;
            f("");
          }
          if (interrupt) interrupt();
          else {
            restore();
            process.exit(0);
          }
        } else if (s === "\t") {
          if (popupOpen()) acceptCompletion(); // C9:Tab = 补全高亮项(无弹层时吞掉,同旧控制字符丢弃)
        } else if (s === "\r" || s === "\n") {
          if (popupOpen())
            acceptCompletion(); // 弹层开:Enter=补全收起;弹层关:照旧整行提交(用户裁决)
          else submit();
        } else if (s === "\x7f" || s === "\b") {
          input = input.slice(0, -1);
          afterEdit();
        } else if (s === "\x0f") {
          // C11 Ctrl+O:切 think 全文/折行(自由键位,与既有键零冲突);一行 dim notice 进滚动区。
          verbose = !verbose;
          entries.push({
            kind: "dim",
            text: verbose ? "思考全文(Ctrl+O 折回)" : "思考已折行(Ctrl+O 展开)",
          });
        } else if (s.startsWith("\x1b")) {
          // Esc = 收起弹层(已输内容保留);↑/↓ 仅在弹层开时移高亮;其余转义照旧吞,别当字面量打进输入框。
          const items = popupItems();
          if (s === "\x1b") compDismissed = true;
          else if (items.length > 0 && s === "\x1b[A")
            compSel = (Math.min(compSel, items.length - 1) + items.length - 1) % items.length;
          else if (items.length > 0 && s === "\x1b[B") compSel = (compSel + 1) % items.length;
        } else {
          const multi = s.length > 1; // 粘贴含换行 → 空格,不连发多条
          for (const c of s) {
            const cp = c.codePointAt(0) ?? 0;
            if (cp === 0x0a || cp === 0x0d) {
              if (!multi) submit();
              else input += " ";
            } else if (cp === 0x7f) input = input.slice(0, -1);
            else if (cp >= 0x20) input += c;
          }
          afterEdit();
        }
        requestDraw();
      });
      requestDraw();
    },
    stop() {
      if (!started) return;
      started = false;
      restore();
    },
    ask(label?: string) {
      void label;
      return new Promise<string>((resolve) => {
        const t = pending.shift();
        if (t !== undefined) {
          resolve(t);
          requestDraw();
          return;
        }
        askWait = (text: string) => {
          askWait = null;
          resolve(text);
        };
        requestDraw();
      });
    },
    confirm(prompt: string) {
      return new Promise<ConfirmAnswer>((resolve) => {
        // C6:弹面文案由 loop 一次给全(首行 warn,其余行 dim 缩进),本侧不再自造键位行。
        const lines = prompt.split("\n");
        entries.push(
          { kind: "warn", text: lines[0] ?? "" },
          ...lines.slice(1).map((text) => ({ kind: "dim" as const, text })),
        );
        confirmWait = (answer: string) => {
          confirmWait = null;
          resolve(mapConfirm(answer));
        };
        requestDraw();
      });
    },
    render(ev: AgentEvent) {
      switch (ev.type) {
        case "agent_start":
        case "turn_start":
          busy = true;
          break;
        case "message_update":
          live = liveEntry(ev.message);
          break;
        case "message_end":
          entries.push(...entriesFromMessages([ev.message]));
          live = null;
          break;
        case "tool_execution_start":
          entries.push({
            kind: "tool",
            text: `${ev.toolName} ${previewArgs(ev.args)}`,
            id: ev.toolCallId,
          });
          break;
        case "tool_execution_end": {
          const mark = ev.isError ? "✗" : "✓";
          const i = entries.findIndex((e) => e.id === ev.toolCallId);
          if (i >= 0) {
            const e = entries[i]!;
            e.text = `${e.text} → ${previewResult(ev.result)} ${mark}`;
            if (ev.isError) e.kind = "warn";
          } else
            entries.push({
              kind: ev.isError ? "warn" : "tool",
              text: `${ev.toolName} → ${previewResult(ev.result)} ${mark}`,
            });
          break;
        }
        case "agent_end":
          busy = false;
          live = null;
          break;
      }
      requestDraw();
    },
    note(line: string) {
      entries.push({ kind: "dim", text: line });
      requestDraw();
    },
    warn(line: string) {
      entries.push({ kind: "warn", text: line });
      requestDraw();
    },
    setModel(id: string) {
      modelId = id;
      requestDraw();
    },
    loadHistory(msgs: AgentMessage[]) {
      entries = entriesFromMessages(msgs);
      requestDraw();
    },
    onInterrupt(cb: () => void) {
      interrupt = cb;
    },
  };
}

// 非 TTY 回落 = 旧 H1 通道原样搬进接口(增量 renderer、SIGINT、Ctrl+D 退出全同前)。
export function createPlainIO(): ChatIO {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on("close", () => process.exit(0)); // Ctrl+D
  let interrupt: (() => void) | null = null;
  rl.on("SIGINT", () => {
    if (interrupt) interrupt();
    process.stdout.write("\n"); // tty 不回显 ^C,补换行让后续输出不粘连
  });
  const stream = createRenderer((s) => process.stdout.write(s));
  const askLine = (label: string) => new Promise<string>((res) => rl.question(label, res));
  return {
    mode: "plain",
    start() {},
    stop() {
      rl.close();
    },
    ask: (label) => askLine(label ?? "> "),
    confirm: async (prompt) => mapConfirm(await askLine(`${prompt}\n(1/2/3/4) ❯ `)),
    render(ev) {
      stream(ev);
    },
    note(line) {
      process.stdout.write(`${line}\n`);
    },
    warn(line) {
      process.stdout.write(`${line}\n`);
    },
    setModel() {},
    loadHistory() {},
    onInterrupt(cb) {
      interrupt = cb;
    },
  };
}
