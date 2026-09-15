// P2 聊天框纯渲染层:视图状态 → 一屏字符串。布局 = 变体 A 定稿
// (幽灵顶栏 + 三行 info + 无边框消息流 + 唯一 `>` 输入框),原型出处见分支 proto/terminal-ui、裁决见 ADR-002。
// 纯函数零状态零 I/O —— 键盘/重绘在 tui.ts,这里全部可自动测。
// 制表/生僻符号一律 \uXXXX 转义:模型直接生成 ╭╯○‿ 类同形字符会漂移(原型期连错 5+ 次),转义源是纯 ASCII,稳。
import type { AgentMessage, AssistantMessage } from "../loop/types.ts";

export const B = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

// ---- 宽度工具(量宽必须剥 ANSI;控制字符正则故意的)----
// eslint-disable-next-line no-control-regex
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
// 可见宽度:CJK/全角记 2 列(近似,够用)。
export const vw = (s: string): number =>
  [...strip(s)].reduce((n, c) => n + ((c.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1), 0);
const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - vw(s)));
export const trunc = (s: string, w: number): string => {
  if (vw(s) <= w) return s;
  let out = "";
  for (const c of [...strip(s)]) {
    if (vw(out + c) > w - 1) break;
    out += c;
  }
  return out + "…";
};
// 输入框专用:超长保尾弃头(用户要看自己正打着的末段)。
export function fitInput(s: string, w: number): string {
  if (vw(s) <= w) return s;
  let out = "";
  for (const c of [...s].reverse()) {
    if (vw(`…${out}` + c) > w) break;
    out = c + out;
  }
  return `…${out}`;
}
// 按可见列宽软换行(\n 先分段;无断点的长串按字符硬切)。
export function wrapLines(text: string, w: number): string[] {
  const out: string[] = [];
  for (const seg of text.split("\n")) {
    if (seg === "") {
      out.push("");
      continue;
    }
    let line = "";
    for (const c of seg) {
      if (vw(line + c) > w) {
        out.push(line);
        line = c;
      } else line += c;
    }
    out.push(line);
  }
  return out;
}

// ---- 消息条目 ----
export type EntryKind = "user" | "bot" | "think" | "tool" | "warn" | "dim";
export interface Entry {
  kind: EntryKind;
  text: string;
  id?: string; // tool 行凭 toolCallId 回填结果,不重复开新行
}

const PREFIX: Record<EntryKind, string> = {
  user: `${B}›${RESET} `,
  bot: `${GREEN}▍${RESET} `,
  tool: `${DIM}▸${RESET} `,
  warn: `${YELLOW}⚠${RESET} `,
  think: `${DIM}  ${RESET}`,
  dim: `${DIM}  ${RESET}`,
};
const FAINT: Record<EntryKind, boolean> = {
  user: false,
  bot: false,
  tool: false,
  warn: false,
  think: true,
  dim: true,
};

// 一条逻辑条目 → 若干物理行(首行带符号,续行两空格缩进)。
export function entryLines(e: Entry, w: number): string[] {
  return wrapLines(e.text, Math.max(4, w - 2)).map((l, i) => {
    const head = i === 0 ? PREFIX[e.kind] : "  ";
    const body = FAINT[e.kind] ? `${DIM}${l}${RESET}` : l;
    return head + body;
  });
}
export const entriesToLines = (es: Entry[], w: number): string[] =>
  es.flatMap((e) => entryLines(e, w));

// ---- 顶栏(G5 第一版线描幽灵,logo-lab 定稿;字符全码点构造防漂移)----
export const LOGO = [
  ` ${"╭"}${"─".repeat(3)}${"╮"}`,
  ` ${"│"}${"○"} ${"○"}${"│"}`,
  ` ${"│"} ${"‿"} ${"│"}`,
  ` ${"╰"}${"╯"}${"╰"}${"╯"}`,
];
export function headerLines(modelId: string, cwd: string, w: number): string[] {
  const info = [
    `${B}mini${RESET} ${DIM}v0.1 · coding agent${RESET}`,
    `${CYAN}${modelId}${RESET} with high effort`,
    `${DIM}${trunc(cwd, Math.max(8, w - 12))}${RESET}`,
  ];
  return LOGO.map((g, r) => `${CYAN}${pad(g, 10)}${RESET}  ${info[r] ?? ""}`);
}

// ---- 输入框(Claude Code 式:上下全宽纯横线,零竖边框)----
const RULE = "─"; // U+2500
export function inputFrame(input: string, busy: boolean, width: number): string[] {
  const cur = fitInput(input, Math.max(6, width) - 4);
  const hint = busy ? ` ${DIM}⋯ 运行中 Ctrl+C 中断${RESET}` : "";
  return [
    RULE.repeat(width),
    pad(`${B}>${RESET} ${cur}${CYAN}▌${RESET}` + hint, width),
    RULE.repeat(width),
  ];
}

// ---- 整屏 ----
export interface TuiView {
  modelId: string;
  cwd: string;
  entries: Entry[];
  live: Entry | null;
  input: string;
  busy: boolean;
  width: number;
  height: number;
}
// 顶栏并入滚动区:消息变长整体向下生长,超屏后顶栏随内容滑出("自动向上移动"手感),输入框钉底。
// 行数 ≤ height(内容留尾 + 空 + 3 框),超界终端滚动会撕框。
export function renderView(v: TuiView): string {
  const content = [
    ...headerLines(v.modelId, v.cwd, v.width),
    ...entriesToLines(v.live ? [...v.entries, v.live] : v.entries, v.width),
  ];
  const lines = content.slice(-Math.max(1, v.height - 4));
  lines.push("", ...inputFrame(v.input, v.busy, v.width));
  return lines.join("\n");
}

// ---- loop 数据 → 条目(历史重建 + 落定消息共用)----
export function entriesFromMessages(msgs: AgentMessage[]): Entry[] {
  const out: Entry[] = [];
  for (const m of msgs) {
    if (m.role === "user") out.push({ kind: "user", text: m.content });
    else if (m.role === "assistant") {
      for (const b of m.content) {
        if (b.type === "text" && b.text.trim() !== "") out.push({ kind: "bot", text: b.text });
        else if (b.type === "thinking" && b.text.trim() !== "")
          out.push({ kind: "think", text: b.text });
      }
      if (m.stopReason === "error")
        out.push({ kind: "warn", text: `[error] ${m.errorMessage ?? ""}` });
      else if (m.stopReason === "aborted") out.push({ kind: "warn", text: "[aborted]" });
    } else
      out.push({
        kind: m.isError ? "warn" : "tool",
        text: `${m.toolName} ${m.isError ? "✗" : "✓"} ${oneLine(m.content.map((c) => c.text).join(" "))}`,
      });
  }
  return out;
}
// 流式中的活块:取最后一个 text/thinking 块(快照态,proto 同款)。
export function liveEntry(m: AssistantMessage): Entry | null {
  for (let i = m.content.length - 1; i >= 0; i--) {
    const b = m.content[i];
    if (!b) continue;
    if (b.type === "text") return { kind: "bot", text: b.text };
    if (b.type === "thinking") return { kind: "think", text: b.text };
  }
  return null;
}

// ---- 摘要工具(tool 行用)----
export const oneLine = (s: string, max = 60): string => trunc(s.replace(/\s+/g, " ").trim(), max);
export function previewArgs(args: unknown): string {
  if (args && typeof args === "object") {
    for (const v of Object.values(args)) {
      if (typeof v === "string" && v !== "") return oneLine(v, 50);
      if (typeof v === "number") return String(v);
    }
  }
  return oneLine(JSON.stringify(args ?? ""), 50);
}
export function previewResult(result: unknown): string {
  const r = result as { content?: { text?: string }[] };
  return oneLine(r?.content?.[0]?.text ?? "", 80);
}
