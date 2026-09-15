// C12 markdown 叶子:bot 文本 → 块 → 行内样式 → 逻辑行(零宽度数学,折行归 wrapLines)。
// 纯函数零 I/O。只做 TUI bot 线,plain renderer 不过此处(防注入变脸)。
// 符号一律码点构造(同 tui-view 规约:字面量易漂移)。
import { B, DIM, ITALIC, RESET } from "./ansi.ts";

export type Block =
  | { kind: "head"; level: number; text: string }
  | { kind: "para"; lines: string[] }
  | { kind: "list"; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "code"; lines: string[] }
  | { kind: "hr" }
  | { kind: "blank" };

const HEAD = /^(#{1,6}) (.*)$/; // # 须 1-6 个且必跟空格,否则段落字面
const HR = /^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/; // 只认无空格连串(`_ _ _` = para)
const LIST = /^[-*] (.*)$/; // 有序 `1.` v1 不识别 = 段落字面(2026-09-15 裁)
const QUOTE = /^> ?(.*)$/;
const FENCE = /^```/;
const FENCE_CLOSE = /^```\s*$/;

export function splitBlocks(src: string): Block[] {
  const lines = src.split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // 尾换行不造幽灵 blank
  const out: Block[] = [];
  const para: string[] = [];
  const list: string[] = [];
  const quote: string[] = [];
  let code: string[] | null = null; // 非 null = 围栏内(含未闭合到末尾 = 流式安全)
  const flush = (): void => {
    if (para.length) out.push({ kind: "para", lines: para.splice(0) });
    if (list.length) out.push({ kind: "list", items: list.splice(0) });
    if (quote.length) out.push({ kind: "quote", lines: quote.splice(0) });
  };
  for (const line of lines) {
    if (code) {
      if (FENCE_CLOSE.test(line)) {
        out.push({ kind: "code", lines: code });
        code = null;
      } else code.push(line);
      continue;
    }
    if (FENCE.test(line)) {
      flush();
      code = [];
      continue;
    }
    const h = HEAD.exec(line);
    if (h) {
      flush();
      out.push({ kind: "head", level: (h[1] ?? "").length, text: h[2] ?? "" });
      continue;
    }
    if (line.trim() === "") {
      flush();
      out.push({ kind: "blank" });
      continue;
    }
    if (HR.test(line)) {
      flush();
      out.push({ kind: "hr" });
      continue;
    }
    const l = LIST.exec(line);
    if (l) {
      if (para.length) out.push({ kind: "para", lines: para.splice(0) });
      if (quote.length) out.push({ kind: "quote", lines: quote.splice(0) });
      list.push(l[1] ?? "");
      continue;
    }
    const q = QUOTE.exec(line);
    if (q) {
      if (para.length) out.push({ kind: "para", lines: para.splice(0) });
      if (list.length) out.push({ kind: "list", items: list.splice(0) });
      quote.push(q[1] ?? "");
      continue;
    }
    if (list.length) out.push({ kind: "list", items: list.splice(0) });
    if (quote.length) out.push({ kind: "quote", lines: quote.splice(0) });
    para.push(line);
  }
  if (code) out.push({ kind: "code", lines: code }); // 未闭合:扫到 EOF 仍收块
  flush();
  return out;
}

// 单遍扫描 `**`/`*`/反引号。未闭合 = 定界符逐字符字面降级(后续文本仍尝试配对)。
// code span 内容不透视;v1 不嵌套(span 内再遇定界符 = 字面,DEFERRED 候选)。
// 定则:** 优先成对(开则必找 **,落单 * 从下一字符再论),span 整体被零宽 SGR 包裹。
export function styleInline(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "`") {
      const j = s.indexOf("`", i + 1);
      if (j > i) {
        out += DIM + s.slice(i + 1, j) + RESET;
        i = j + 1;
        continue;
      }
    }
    if (c === "*") {
      if (s[i + 1] === "*") {
        const j = s.indexOf("**", i + 2);
        if (j >= i + 2) {
          out += B + s.slice(i + 2, j) + RESET;
          i = j + 2;
          continue;
        }
      } else {
        const j = s.indexOf("*", i + 1);
        if (j > i) {
          out += ITALIC + s.slice(i + 1, j) + RESET;
          i = j + 1;
          continue;
        }
      }
    }
    out += c;
    i++;
  }
  return out;
}

// 块 → 逻辑行(含 SGR,零宽度数学:仅 hr 吃 ruleW)。折行/前缀不在本层 —— 归 wrapLines + entryLines。
// 版式 2026-09-15 人审定稿:head 整行 B(不吃行内、不分级)、code 行 DIM、沟 `│ ` DIM、
// 列表仅无序 `-`/`*` 换 •(有序段落字面)、hr = ─ 连排 ruleW。每逻辑行自闭(行首尾皆平态)。
const BULLET = String.fromCodePoint(0x2022); // •
const VBAR = String.fromCodePoint(0x2502); // │
const RULE = String.fromCodePoint(0x2500); // ─

export function renderMarkdown(src: string, ruleW: number): string[] {
  const out: string[] = [];
  for (const b of splitBlocks(src)) {
    switch (b.kind) {
      case "head":
        out.push(`${B}${b.text}${RESET}`);
        break;
      case "para":
        for (const l of b.lines) out.push(styleInline(l));
        break;
      case "list":
        for (const it of b.items) out.push(`${BULLET} ${styleInline(it)}`);
        break;
      case "quote":
        for (const l of b.lines) out.push(`${DIM}${VBAR}${RESET} ${styleInline(l)}`);
        break;
      case "code":
        for (const l of b.lines) out.push(l === "" ? "" : `${DIM}${l}${RESET}`); // 空行不包空码对
        break;
      case "hr":
        out.push(RULE.repeat(Math.max(0, ruleW)));
        break;
      case "blank":
        out.push("");
        break;
    }
  }
  return out;
}
