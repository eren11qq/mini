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

// ---- C16 通用选列(kilo DialogSelect 样式分级):补全弹层与 C17 connect 层共用 ----
export interface SelectItem {
  title: string; // 正文(含 "/名" 等前缀,渲染层不问)
  desc: string; // 尾部灰说明
  mark?: string; // 调用方注入的 gutter 符号(如 ✓ 已配)
}
export interface SelectView {
  items: SelectItem[]; // 空表 = 无匹配行(不关层,kilo 语义)
  sel: number; // 高亮下标由 tui.ts 键盘态裁决(−1 = 不指任何行),视图只画
}
const BULL = String.fromCodePoint(0x25cf); // ●(码点构造防漂移,同 STAR 规约)
// 选中行 = 零背景、整行换主题淡蓝(命令名 CYAN+B + desc 同 CYAN)+ ● 位标(三轮真机裁决 2026-09-16 定档);
// 未选行 = 本色 B title + 灰 desc;两态 desc 均列对齐 = 最长 title+3(Claude Code 式,补裁)。超宽复用 wrapLines 自闭机折行、续行缩进对齐。
// 视口:自 sel 交替扩到 maxRows 行(高亮恒中段 = 首移居中)。sel 恒 −1..len−1(空表配 −1,调用方钳好)。
export function selectListLines(
  items: SelectItem[],
  w: number,
  sel: number,
  maxRows: number,
): string[] {
  // 零候选不关层(kilo No results found 语义):dim 一行占位,高亮不指任何行。
  if (items.length === 0) return maxRows > 0 ? [pad(`  ${DIM}无匹配${RESET}`, w)] : [];
  if (maxRows <= 0) return [];
  // 一条目 = 一物理行组:复用 wrapLines 自闭机折到 w−2,首行 gutter 符号、续行两空格(缩进对齐 title 列)。
  // desc 列对齐(Claude Code 式,补裁 2026-09-16):统一贴 最长 title + 3 列;空 desc 零 gap。
  const wrapW = Math.max(4, w - 2);
  const gapCol = Math.max(...items.map((it) => vw(it.title))) + 3;
  const groups = items.map((it, i) => {
    const gap = it.desc === "" ? "" : " ".repeat(Math.max(0, gapCol - vw(it.title)));
    if (i === sel) {
      // 三轮定档(2026-09-16):零背景 —— 选中整行换主题淡蓝(命令名 CYAN+B + desc 同 CYAN),● 位标。
      const head = `${CYAN}${B}${it.title}${RESET}`;
      const styled = it.desc === "" ? head : `${head}${gap}${CYAN}${it.desc}${RESET}`;
      return wrapLines(styled, wrapW).map((l, k) =>
        pad(`${k === 0 ? `${CYAN}${BULL}${RESET} ` : "  "}${l}`, w),
      );
    }
    const head = `${B}${it.title}${RESET}`;
    const styled = it.desc === "" ? head : `${head}${gap}${DIM}${it.desc}${RESET}`;
    const gut = it.mark ? `${GREEN}${it.mark}${RESET} ` : "  "; // 符号占第 1 列,选中行 ● 顶掉 mark
    return wrapLines(styled, wrapW).map((l, k) => pad(`${k === 0 ? gut : "  "}${l}`, w));
  });
  // 视口:自 sel 起下/上交替扩(按物理行数计,高亮恒中段 = 首移居中;贴边停,不多滑一行)。
  let lo = sel;
  let hi = sel;
  let n = groups[sel]!.length;
  let wantDown = true;
  while (n < maxRows) {
    const dOk = hi + 1 < groups.length && n + groups[hi + 1]!.length <= maxRows;
    const uOk = lo > 0 && n + groups[lo - 1]!.length <= maxRows;
    if ((wantDown && dOk) || (!wantDown && !uOk && dOk)) {
      n += groups[++hi]!.length;
    } else if (uOk) {
      n += groups[--lo]!.length;
    } else if (dOk) {
      n += groups[++hi]!.length;
    } else break;
    wantDown = !wantDown;
  }
  return groups
    .slice(lo, hi + 1)
    .flat()
    .slice(0, maxRows); // sel 组独行超预算时硬截(带首行 = sel 行,恒可见)
}
// ---- C17 keyIn 底条(向导独立态,照 kilo DialogPrompt):标题 / 端点指引(dim,调用方注入)/ 明文输入 ----
// 明文不打码 = kilo 实况(屏幕暴露风险用户已知晓);空 buf → dim placeholder sk-…;超宽 fitInput 保尾(输入框同款)。
export function connectKeyInLines(o: {
  alias: string;
  hint: string;
  buf: string;
  w: number;
}): string[] {
  const cur = o.buf === "" ? `${DIM}sk-…${RESET}` : fitInput(o.buf, Math.max(2, o.w - 2));
  return [
    `${B}输入 ${o.alias} API key${RESET}`,
    `${DIM}${trunc(o.hint, Math.max(8, o.w))}${RESET}`,
    `${B}>${RESET} ${cur}`,
  ];
}

// ---- 整屏 ----
// C17 向导层视图:pick = C16 选列复用(items 由 tui.ts 注 alias·modelId·✓);keyIn = 底条三行。
// 活跃时压掉补全层(聊天键位全让位,AC3);行数契约同 completion 吃 height−8 预算。
export type ConnectView =
  | { step: "pick"; items: SelectItem[]; sel: number }
  | { step: "keyIn"; alias: string; hint: string; buf: string };

export interface TuiView {
  modelId: string;
  cwd: string;
  entries: Entry[];
  live: Entry | null;
  input: string;
  busy: boolean;
  width: number;
  height: number;
  completion: SelectView | null;
  connect: ConnectView | null;
  verbose: boolean; // C11:think 全文淡显(Ctrl+O 切);live 条目不受此字段影响,恒展开
}
// 顶栏并入滚动区:消息变长整体向下生长,超屏后顶栏随内容滑出("自动向上移动"手感),输入框钉底。
// 行数 ≤ height(内容留尾 + 空 + 3 框),超界终端滚动会撕框。
export function renderView(v: TuiView): string {
  // 弹层封顶 = height 减去定盘(顶 4 + 空 1 + 框 3 + body 至少 1);无匹配行同吃此预算(C16 AC-4)。
  // C17:向导层活跃时占同一弹层位(pick 走 selectListLines 逐字节 C16 契约,keyIn 三行底条;极矮终端截行保契约)。
  const budget = Math.max(0, v.height - 8);
  const comp = v.connect
    ? v.connect.step === "pick"
      ? selectListLines(v.connect.items, v.width, v.connect.sel, budget)
      : connectKeyInLines({ ...v.connect, w: v.width }).slice(0, budget)
    : v.completion
      ? selectListLines(v.completion.items, v.width, v.completion.sel, budget)
      : [];
  const content = [
    ...headerLines(v.modelId, v.cwd, v.width),
    ...entriesToLines(v.entries, v.width, v.verbose),
    ...(v.live ? entryLines(v.live, v.width) : []), // live 恒展开:流式期看全文,message_end 落定才折
  ];
  // 弹层占的尾行从消息体预算里扣(body 至少留 1 行,整屏恒 ≤ height)。
  const lines = content.slice(-Math.max(1, v.height - 4 - comp.length));
  lines.push("", ...inputFrame(v.input, v.busy, v.width), ...comp);
  // 行满宽 pad:重绘不再用 2J(见 tui.ts),同物理行上一帧更宽时旧字会露;pad 到 width 逐格覆写。
  return lines.map((l) => pad(l, v.width)).join("\n");
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
