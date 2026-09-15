// P2 聊天框纯渲染层:视图状态 → 一屏字符串。布局 = 变体 A 定稿
// (幽灵顶栏 + 三行 info + 无边框消息流 + 唯一 `>` 输入框),原型出处见分支 proto/terminal-ui、裁决见 ADR-002。
// 纯函数零状态零 I/O —— 键盘/重绘在 tui.ts,这里全部可自动测。
// 制表/生僻符号一律 \uXXXX 转义:模型直接生成 ╭╯○‿ 类同形字符会漂移(原型期连错 5+ 次),转义源是纯 ASCII,稳。
import type { AgentMessage, AssistantMessage } from "../loop/types.ts";
import { B, CYAN, DIM, GREEN, RESET, YELLOW } from "./ansi.ts";
import { renderMarkdown } from "./markdown.ts";

export { B }; // 重导出保对外面:历史 `import { B } from tui-view` 不破(依赖单向 tui-view → ansi)。

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
// SGR 感知:整条转义 = 一个 token(\x1b 前缀且长 >1;裸 \x1b 按宽 1 字符走老路)。
// 断行处行尾补 RESET、下行行头重开活动码 = 每物理行自闭;活动码全空时零插入,非 ANSI 输入逐字节不变。
// eslint-disable-next-line no-control-regex
const CELL = /\x1b\[[0-9;]*m|./gu;
export function wrapLines(text: string, w: number): string[] {
  const out: string[] = [];
  for (const seg of text.split("\n")) {
    if (seg === "") {
      out.push("");
      continue;
    }
    let line = "";
    let active = ""; // 全量态:含尚未跟可见字符的滞留码 → 决定续行行头重开
    let lineOpen = ""; // 本行最后落字符时的态:非空 = 行尾需 RESET(RESET 滞留 pending 也算未关)
    let pending = ""; // 已读未落字符的码:遇断行归下行重开,段尾无字符跟则弃
    for (const c of seg.match(CELL) ?? []) {
      if (c[0] === "\x1b" && c.length > 1) {
        active = c === RESET ? "" : active + c;
        pending += c;
      } else if (vw(line + c) > w) {
        if (lineOpen) line += RESET;
        out.push(line);
        line = active + c;
        lineOpen = active;
        pending = "";
      } else {
        line += pending + c;
        lineOpen = active;
        pending = "";
      }
    }
    out.push(lineOpen ? line + RESET : line);
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
// C12 顺序契约:分块 → 行内样式 → wrapLines → 前缀。仅 bot 过 markdown(含 live);
// user/tool/warn/think 保持字面直折 = 旧行为逐字节不变(防注入变脸)。
export function entryLines(e: Entry, w: number): string[] {
  const wrapW = Math.max(4, w - 2);
  const logical =
    e.kind === "bot"
      ? renderMarkdown(e.text, wrapW).flatMap((l) => wrapLines(l, wrapW))
      : undefined;
  const lines = logical ?? wrapLines(e.text, wrapW);
  return lines.map((l, i) => {
    const head = i === 0 ? PREFIX[e.kind] : "  ";
    const body = FAINT[e.kind] ? `${DIM}${l}${RESET}` : l;
    return head + body;
  });
}
// C11 汇总行:非 verbose 时一条 think 只画一行 `✻ 思考·N字`(N = 去换行后的码点数)。
// 折叠是渲染期派生 —— 原文一直在 entry 里,verbose 一开即全文;符号走码点构造防源字符漂移。
const STAR = String.fromCodePoint(0x273b); // ✻
const MID = String.fromCodePoint(0xb7); // ·
const thinkChars = (s: string): number => [...s.replace(/\n/g, "")].length;
export const thinkSummary = (text: string): string => `${STAR} 思考${MID}${thinkChars(text)}字`;

export function entriesToLines(es: Entry[], w: number, verbose = false): string[] {
  const out: string[] = [];
  for (const e of es) {
    if (e.kind === "think" && !verbose) out.push(`${DIM}${thinkSummary(e.text)}${RESET}`);
    else out.push(...entryLines(e, w));
  }
  return out;
}

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

// ---- 补全弹层(C9:斜杠命令候选,渲染在输入框底线下方;候选数据在 commands.ts)----
export interface CompletionItem {
  name: string; // 不含 "/"
  description: string;
  highlighted: boolean; // 高亮位由 tui.ts 键盘态裁决,视图只画
}
export interface CompletionView {
  items: CompletionItem[];
}
// 每条一行、vw 截断到宽(不折行 = 不破 columns-1 的帧高契约);高亮行 ▸,风格零竖边框。
export function completionLines(comp: CompletionView, w: number): string[] {
  return comp.items.map((it) => {
    const mark = it.highlighted ? `${B}▸${RESET}` : " ";
    const head = `${mark} ${B}/${it.name}${RESET}`;
    const desc = it.description ? trunc(it.description, Math.max(4, w - vw(head) - 1)) : "";
    const line = desc === "" ? head : `${head} ${DIM}${desc}${RESET}`;
    return pad(line, w);
  });
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
  completion: CompletionView | null;
  verbose: boolean; // C11:think 全文淡显(Ctrl+O 切);live 条目不受此字段影响,恒展开
}
// 顶栏并入滚动区:消息变长整体向下生长,超屏后顶栏随内容滑出("自动向上移动"手感),输入框钉底。
// 行数 ≤ height(内容留尾 + 空 + 3 框),超界终端滚动会撕框。
export function renderView(v: TuiView): string {
  // 弹层封顶 = height 减去定盘(顶 4 + 空 1 + 框 3 + body 至少 1),超界候选不渲染(C9 AC-5)。
  const comp = v.completion
    ? completionLines(v.completion, v.width).slice(0, Math.max(0, v.height - 8))
    : [];
  const content = [
    ...headerLines(v.modelId, v.cwd, v.width),
    ...entriesToLines(v.entries, v.width, v.verbose),
    ...(v.live ? entryLines(v.live, v.width) : []), // live 恒展开:流式期看全文,message_end 落定才折
  ];
  // 弹层占的尾行从消息体预算里扣(body 至少留 1 行,整屏恒 ≤ height)。
  const lines = content.slice(-Math.max(1, v.height - 4 - comp.length));
  lines.push("", ...inputFrame(v.input, v.busy, v.width), ...comp);
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
        else if (b.type === "thinking" && b.text.trim() !== "") {
          // C11:相邻 thinking(同消息内或跨消息)并一条,全文保留 —— 折叠只在渲染期派生。
          const prev = out[out.length - 1];
          if (prev && prev.kind === "think") prev.text += `\n${b.text}`;
          else out.push({ kind: "think", text: b.text });
        }
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
