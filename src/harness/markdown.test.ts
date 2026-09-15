// C12 markdown 叶子锚点直测(卡定:三函数各钉锚,裸缝窗口不跨 slice)。
// 断言全用 \u 码点/手算字面量(同 tui-view.test 规约:期望值独立于实现,防同漂骗测)。
import { describe, expect, it } from "vitest";
import { renderMarkdown, splitBlocks, styleInline } from "./markdown.ts";
import { vw } from "./tui-view.ts";

// 版式符号码点构造(源规约)。
const BULLET = String.fromCodePoint(0x2022); // •
const VBAR = String.fromCodePoint(0x2502); // │
const RULE = String.fromCodePoint(0x2500); // ─

// SGR 码走常量(与 ansi.ts 值同;测试独立手拼 = 字面量防同漂,用码点)。
const B = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const RESET = "\x1b[0m";

describe("splitBlocks:块分类", () => {
  it("七类块按源序切分,载荷逐字段钉死", () => {
    const src = [
      "# Title",
      "intro para",
      "second para line",
      "",
      "- one",
      "* two",
      "",
      "> quoted",
      "> more",
      "",
      "---",
      "",
      "```py",
      "x=1",
      "```",
      "after",
    ].join("\n");
    expect(splitBlocks(src)).toEqual([
      { kind: "head", level: 1, text: "Title" },
      { kind: "para", lines: ["intro para", "second para line"] },
      { kind: "blank" },
      { kind: "list", items: ["one", "two"] },
      { kind: "blank" },
      { kind: "quote", lines: ["quoted", "more"] },
      { kind: "blank" },
      { kind: "hr" },
      { kind: "blank" },
      { kind: "code", lines: ["x=1"] },
      { kind: "para", lines: ["after"] },
    ]);
  });
  it("head 判据:# 1-6 个 + 必跟空格;7 个或无空格 = 段落字面", () => {
    expect(splitBlocks("###### six")[0]).toEqual({ kind: "head", level: 6, text: "six" });
    expect(splitBlocks("####### seven")[0]).toEqual({ kind: "para", lines: ["####### seven"] });
    expect(splitBlocks("#NoSpace")[0]).toEqual({ kind: "para", lines: ["#NoSpace"] });
  });
  it("有序列表 1. 不识别 = 段落字面(用户 2026-09-15 裁);hr 只认无空格连串", () => {
    expect(splitBlocks("1. first")[0]).toEqual({ kind: "para", lines: ["1. first"] });
    expect(splitBlocks("***")[0]).toEqual({ kind: "hr" });
    expect(splitBlocks("_ _ _")[0]).toEqual({ kind: "para", lines: ["_ _ _"] });
  });
  it("围栏未闭合 = code 到末尾(流式安全:半开 ``` 不吞不崩)", () => {
    expect(splitBlocks("```js\nlet a\nlet b")).toEqual([
      { kind: "code", lines: ["let a", "let b"] },
    ]);
    // 裸 ``` 开栏无闭合 → 后续行全归 code(此例钉 tail 非 para)。
    expect(splitBlocks("```\ntail")).toEqual([{ kind: "code", lines: ["tail"] }]);
  });
});

describe("styleInline:单遍扫描三定界符", () => {
  it("闭合三对:逐字符钉死 SGR 包裹输出", () => {
    expect(styleInline("**b** and *i* and `c`")).toBe(
      `${B}b${RESET} and ${ITALIC}i${RESET} and ${DIM}c${RESET}`,
    );
  });
  it("恒宽不变式:闭合 = vw 原样减定界符宽;未闭合 = 逐字节字面(vw 恒等)", () => {
    // 中文粗体:输入 vw 8(`**`×2=4 + 中 2 + 中 2),输出可视 4。期望独立手算。
    expect(vw(styleInline("**中中**"))).toBe(4);
    expect(vw(styleInline("**中中**"))).toBe(vw("**中中**") - 4);
    // 纯未闭合(a ** b ` c,无成对可配)→ 字面降级 = 逐字节不变 → vw 恒等。
    const s = "a ** b ` c";
    expect(styleInline(s)).toBe(s);
    expect(vw(styleInline(s))).toBe(vw(s));
  });
  it("code span 内容不透视:** 在反引号内 = 字面", () => {
    expect(styleInline("`a**b**c`")).toBe(`${DIM}a**b**c${RESET}`);
  });
  it("v1 不嵌套:bold span 内反引号字面(DEFERRED 记候选)", () => {
    expect(styleInline("**a `b` c**")).toBe(`${B}a \`b\` c${RESET}`);
  });
});

describe("renderMarkdown:块 → 逻辑行", () => {
  it("七类块全谱:head 不吃行内、沟/圆点/hr 宽度、code 透视禁用", () => {
    const src = [
      "# T**x", // head:`**` 字面不过 styleInline
      "",
      "- *hi*",
      "",
      "> **bb**",
      "",
      "```c",
      "int a;",
      "",
      "b",
      "```",
      "",
      "---",
      "",
      "x `y`",
    ].join("\n");
    expect(renderMarkdown(src, 8)).toEqual([
      `${B}T**x${RESET}`,
      "",
      `${BULLET} ${ITALIC}hi${RESET}`,
      "",
      `${DIM}${VBAR}${RESET} ${B}bb${RESET}`,
      "",
      `${DIM}int a;${RESET}`,
      "", // code 内空行:不包空码对(裸空串,防无谓转义滞留)
      `${DIM}b${RESET}`,
      "",
      RULE.repeat(8),
      "",
      `x ${DIM}y${RESET}`,
    ]);
  });
  it("围栏未闭合流式态:到末尾仍是 code 行,不崩不吃后", () => {
    expect(renderMarkdown("```\nabc", 10)).toEqual([`${DIM}abc${RESET}`]);
    expect(renderMarkdown("para\n```js\nlet x", 10)).toEqual(["para", `${DIM}let x${RESET}`]);
  });
});
