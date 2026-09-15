// P2 纯渲染层自动测试(只测 tui-view 这层纯函数;raw-mode 驱动 tui.ts 人工验,同 DECISIONS W2 精神)。
// 断言全用 \u 码点字符串 —— 源码若生成时字符漂移(或同漂骗测),码点对不上必红,即漂移探测器。
import { describe, expect, it } from "vitest";
import {
  entriesFromMessages,
  entryLines,
  fitInput,
  liveEntry,
  LOGO,
  renderView,
  trunc,
  vw,
  wrapLines,
  type TuiView,
} from "./tui-view.ts";
import type { AssistantMessage, StopReason } from "../loop/types.ts";
import type { ContentBlock } from "../blocks.ts";

function asst(content: ContentBlock[], stopReason: StopReason = "stop"): AssistantMessage {
  return { role: "assistant", content, stopReason };
}
function view(partial: Partial<TuiView>): TuiView {
  return {
    modelId: "test-model",
    cwd: "/tmp/x",
    entries: [],
    live: null,
    input: "",
    busy: false,
    width: 60,
    height: 20,
    completion: null,
    ...partial,
  };
}

describe("宽度与折行", () => {
  it("vw:CJK 记 2 列,ANSI 不计量", () => {
    expect(vw("中文")).toBe(4);
    expect(vw("ab")).toBe(2);
    expect(vw("\x1b[1m中文\x1b[0m")).toBe(4);
  });
  it("wrapLines 按列宽硬切,先分段", () => {
    expect(wrapLines("一二三四五六", 4)).toEqual(["一二", "三四", "五六"]);
    expect(wrapLines("一二三四五六", 8)).toEqual(["一二三四", "五六"]);
    expect(wrapLines("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });
  it("wrapLines ANSI 自闭:bold 串按宽 4 折两行,各自行尾 RESET、行头重开(逐字符钉死)", () => {
    // 两个 CJK = 4 列,宽 4 → 每行两字(宽 2 会一字符一行,同规则)。
    expect(wrapLines("\x1b[1m一二三四\x1b[0m", 4)).toEqual([
      "\x1b[1m一二\x1b[0m",
      "\x1b[1m三四\x1b[0m",
    ]);
    // 输入不带收尾 RESET:末行也必须自行自闭,bold 不外溢。
    expect(wrapLines("\x1b[1m一二三四", 4)).toEqual(["\x1b[1m一二\x1b[0m", "\x1b[1m三四\x1b[0m"]);
  });
  it("wrapLines 样式中途切换:续行头重开整串活动码,死码不滞留上一行行尾", () => {
    // DIM 在断行点前出现但无后续可见字符 → 归下一行(重开串含之),不污染上行行尾。
    expect(wrapLines("\x1b[1m一二\x1b[2m三四", 4)).toEqual([
      "\x1b[1m一二\x1b[0m",
      "\x1b[1m\x1b[2m三四\x1b[0m",
    ]);
    // RESET 后活动清空:续行不吃旧码重开,裸字符起行。
    expect(wrapLines("\x1b[1m一二\x1b[0m三四", 4)).toEqual(["\x1b[1m一二\x1b[0m", "三四"]);
  });
  it("wrapLines 非 ANSI 输入逐字节不变:不注一条转义码", () => {
    // 期望 = 旧规则(硬切、零插入)手算字面量,非实现复算。
    const out = wrapLines("abcdefg一二三", 3);
    expect(out).toEqual(["abc", "def", "g一", "二", "三"]);
    expect(out.every((l) => !l.includes("\x1b"))).toBe(true);
  });
  it("trunc 截头保尾加省略号;fitInput 反向(保尾弃头)", () => {
    expect(trunc("abcdefghij", 5)).toBe("abcd…");
    expect(fitInput("0123456789", 5)).toBe("…6789");
  });
});

describe("变体 A 定稿画面", () => {
  it("G5 第一版线描幽灵 = 码点钉死(防漂移)", () => {
    expect(LOGO).toEqual([
      ` ${"╭"}${"─".repeat(3)}${"╮"}`,
      ` ${"│"}${"○"} ${"○"}${"│"}`,
      ` ${"│"} ${"‿"} ${"│"}`,
      ` ${"╰"}${"╯"}${"╰"}${"╯"}`,
    ]);
  });
  it("整屏:内容顶对齐,输入框跟在内容后(4 头 + 空 + 3 框 = 8 行)", () => {
    const lines = renderView(view({})).split("\n");
    expect(lines).toHaveLength(8);
    expect(lines[0]).toContain("mini");
    expect(lines[1]).toContain("test-model");
    expect(lines[2]).toContain("/tmp/x");
    expect(lines[4]).toBe("");
    // 输入框 = Claude Code 式纯横线(全宽、无竖边框)。码点转义防漂移。
    expect(lines[5]).toBe("─".repeat(60));
    expect(lines[6]).toContain(">");
    expect(lines[7]).toBe("─".repeat(60));
    expect(lines.slice(5, 8).join("")).not.toContain("│"); // 框区零竖线(LOGO 的 │ 不算)
  });
  it("消息流超屏:顶栏随内容滑出,输入框钉底,行数 = height 封顶", () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({
      kind: "user" as const,
      text: `E${i}`,
    }));
    const out = renderView(view({ entries }));
    const lines = out.split("\n");
    expect(lines).toHaveLength(20);
    expect(out).not.toContain("mini"); // 顶栏已被滑走
    expect(lines[0]).toContain("E44"); // 头 4 + 60 条 = 64 行,bodyH=16 → 留 E44..E59
    expect(lines[15]).toContain("E59");
    expect(lines[18]).toContain(">");
  });
  it("busy 时输入行挂运行提示", () => {
    const lines = renderView(view({ busy: true })).split("\n");
    expect(lines[6]).toContain("Ctrl+C");
  });
  it("补全弹层:输入框底线下方逐行渲染,高亮行带 ▸,零竖边框", () => {
    const lines = renderView(
      view({
        input: "/co",
        completion: {
          items: [
            { name: "compact", description: "手动压缩上下文", highlighted: true },
            { name: "config", description: "配置", highlighted: false },
          ],
        },
      }),
    ).split("\n");
    expect(lines[7]).toBe("─".repeat(60)); // 输入框底线
    expect(lines[8]).toContain("▸");
    expect(lines[8]).toContain("/compact");
    expect(lines[8]).toContain("手动压缩上下文");
    expect(lines[9]).not.toContain("▸");
    expect(lines[9]).toContain("/config");
    expect(lines.slice(8).join("")).not.toContain("│"); // 弹区零竖线,同框风格
  });
  it("窄窗:弹层每行 vw ≤ width(截断不折行);多命令超界:整屏 ≤ height,弹层封顶", () => {
    const items = Array.from({ length: 6 }, (_, i) => ({
      name: `cmd${i}`,
      description: `说明${"一".repeat(20)}`,
      highlighted: i === 0,
    }));
    const narrow = renderView(view({ width: 16, completion: { items } })).split("\n");
    for (const l of narrow.slice(8)) expect(vw(l)).toBeLessThanOrEqual(16); // 只管弹层区(顶栏超宽是既有行为,C9 外)
    const short = renderView(view({ height: 10, completion: { items } })).split("\n");
    expect(short.length).toBeLessThanOrEqual(10);
    expect(short[8]).toContain("▸"); // 底线后前两行仍是弹层
    expect(short[9]).toContain("cmd1");
    expect(short.join("\n")).not.toContain("cmd5"); // 超界的候选不渲染
  });
  it("entryLines:首行带符号,续行两空格缩进", () => {
    const lines = entryLines({ kind: "bot", text: "一二三四五六七八" }, 10);
    expect(lines).toHaveLength(2);
    expect(vw(lines[0]!)).toBe(10);
    expect(lines[1]!.startsWith("  五六七八")).toBe(true);
  });
});

describe("loop 数据 → 条目", () => {
  it("user/assistant(think+text)/toolResult/error 全映射", () => {
    const es = entriesFromMessages([
      { role: "user", content: "hi" },
      asst([
        { type: "thinking", text: "想想" },
        { type: "text", text: "答复" },
        { type: "toolCall", id: "t1", name: "read", arguments: {} },
      ]),
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "read",
        content: [{ type: "text", text: "ok\n第二行" }],
        isError: false,
      },
      asst([], "error"),
    ]);
    expect(es.map((e) => e.kind)).toEqual(["user", "think", "bot", "tool", "warn"]);
    expect(es[3]!.text).toContain("ok 第二行");
    expect(es[4]!.text).toBe("[error] ");
  });
  it("liveEntry 取最后一个 text/thinking 块", () => {
    const m = asst([
      { type: "text", text: "旧" },
      { type: "thinking", text: "正在想" },
    ]);
    expect(liveEntry(m)).toEqual({ kind: "think", text: "正在想" });
    expect(
      liveEntry(asst([{ type: "toolCall", id: "x", name: "bash", arguments: {} }])),
    ).toBeNull();
  });
});
