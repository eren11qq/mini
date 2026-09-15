// P2 聊天框 I/O:ChatIO 统一缝 + 两实现,cli.ts 只认接口(AC-H1-3 组装层零业务逻辑保持)。
//   createTui —— TTY 默认:raw mode 键盘 + 整屏重绘,画面全部出自 tui-view 纯函数(变体 A 定稿,ADR-002)。
//   createPlainIO —— 非 TTY/管道回落:H1 原裸 readline + 增量 renderer,行为与旧 cli 一致。
// loop/stream/memory 零改动;确认门/中断/落盘裁决仍全在 loop 与 cli 既有缝里。
import { createInterface } from "node:readline";
import type { AgentEvent, AgentMessage } from "../loop/types.ts";
import { createRenderer } from "./renderer.ts";
import {
  entriesFromMessages,
  liveEntry,
  previewArgs,
  previewResult,
  renderView,
  type Entry,
  type TuiView,
} from "./tui-view.ts";

export type ConfirmAnswer = "yes" | "always" | "no";

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

// 确认门答案映射(与旧 cli 逐字等价:1/y/yes=放行,2/always*=总是,其余=拒)。
export function mapConfirm(answer: string): ConfirmAnswer {
  const a = answer.trim().toLowerCase();
  if (a === "1" || a === "y" || a === "yes") return "yes";
  if (a === "2" || a.startsWith("always")) return "always";
  return "no";
}

export function createTui(opts: { cwd: string }): ChatIO {
  let modelId = "…";
  let entries: Entry[] = [];
  let live: Entry | null = null;
  let input = "";
  let busy = false;
  let started = false;
  let askWait: ((s: string) => void) | null = null;
  let confirmWait: ((s: string) => void) | null = null;
  const pending: string[] = []; // busy 期按 ⏎ = 排队,本轮 main 回到 ask 立即领走
  let interrupt: (() => void) | null = null;

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
      const width = process.stdout.columns ?? 90; // 拉满终端(聊天框向右延伸,无列上限)
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
      };
      process.stdout.write(`\x1b[H\x1b[2J${renderView(view)}`);
    });
  };
  const submit = (): void => {
    const text = input.trim();
    input = "";
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
        } else if (s === "\r" || s === "\n") submit();
        else if (s === "\x7f" || s === "\b") input = input.slice(0, -1);
        else if (s.startsWith("\x1b")) {
          // 方向键/功能键转义序列:吞掉,别当字面量打进输入框。
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
        entries.push(
          { kind: "warn", text: prompt },
          { kind: "dim", text: "1 Yes / 2 Yes-always / 3 No" },
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
    confirm: async (prompt) => mapConfirm(await askLine(`${prompt} (1/2/3): `)),
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
