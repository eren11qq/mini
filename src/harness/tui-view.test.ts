// P2 纯渲染层自动测试(只测 tui-view 这层纯函数;raw-mode 驱动 tui.ts 人工验,同 DECISIONS W2 精神)。
// 断言全用 \u 码点字符串 —— 源码若生成时字符漂移(或同漂骗测),码点对不上必红,即漂移探测器。
import { describe, expect, it } from "vitest";
import {
  entriesFromMessages,
  entriesToLines,
  entryLines,
  fitInput,
  liveEntry,
  LOGO,
  renderView,
  trunc,
  vw,
  wrapLines,
  type Entry,
  type TuiView,
} from "./tui-view.ts";
import type { AgentMessage, AssistantMessage, StopReason } from "../loop/types.ts";
import type { ContentBlock } from "../blocks.ts";

// 汇总行符号走码点构造(同 tui-view 源规约:生僻符号字面量易漂移)。
const STAR = String.fromCodePoint(0x273b); // ✻
const MID = String.fromCodePoint(0xb7); // ·
// 剥 ANSI 看纯文本(控制字符正则故意的,同 tui-view 源)。
// eslint-disable-next-line no-control-regex
const plain = (ls: string[]): string[] => ls.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

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
    verbose: false,
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
    expect(lines[4]).toBe(" ".repeat(60)); // C16 行满宽 pad:空行也覆写(防上一帧更宽时露旧字)
    // 输入框 = Claude Code 式纯横线(全宽、无竖边框)。码点转义防漂移。
    expect(lines[5]).toBe("─".repeat(60));
    expect(lines[6]).toContain(">");
    expect(lines[7]).toBe("─".repeat(60));
    expect(lines.slice(5, 8).join("")).not.toContain("│"); // 框区零竖线(LOGO 的 │ 不算)
  });
  it("C16 防叠框:重绘弃 2J → 每行满宽覆写(vw=width)且行数 ≤ height", () => {
    // Windows Terminal 把 2J 存进 scrollback = 连续叠框根因;弃用后残字防线 = 行满宽 pad。
    const es: Entry[] = [
      { kind: "bot", text: "短" },
      { kind: "user", text: "一条很长的消息".repeat(6) },
    ];
    for (const v of [
      view({}),
      view({ entries: es, busy: true }),
      view({ entries: es, verbose: true }),
    ]) {
      const ls = renderView(v).split("\n");
      expect(ls.length).toBeLessThanOrEqual(20);
      for (const l of ls) expect(vw(l)).toBe(60); // 逐行顶满:窄帧接宽帧也不露旧字
    }
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
  it("C11:非 verbose → 单条 think 只画一行 `\\u273b 思考\\u00b7N字`(N=去换行码点数,逐码点钉死)", () => {
    // "思"+a+😀+b = 4 码点(代理对计 1);\\n 不计。期望串手算:DIM + 码点串 + RESET。
    const es: Entry[] = [{ kind: "think", text: "思\na\u{1F600}b" }];
    // 期望串走 backslash-u 码点转义(纯 ASCII 源,同 tui-view 头注防漂移规约)。
    expect(entriesToLines(es, 60, false)).toEqual(["\x1b[2m\u273b 思考\u00b74字\x1b[0m"]);
  });
  it("C11:verbose=true → think 全文淡显原样;同 entries 两帧行数确定(2 vs 3)", () => {
    const es: Entry[] = [
      { kind: "think", text: "一二\n三四" },
      { kind: "bot", text: "答复" },
    ];
    const collapsed = entriesToLines(es, 60, false);
    const verbose = entriesToLines(es, 60, true);
    expect(plain(verbose)).toEqual(["  一二", "  三四", "▍ 答复"]);
    expect(plain(collapsed)).toEqual([`${STAR} 思考${MID}4字`, "▍ 答复"]);
  });
  it("C11:renderView 认 verbose —— live think 恒展开,message_end 落定即收一行,verbose 全展开", () => {
    const m = asst([{ type: "thinking", text: "一二\n三四" }]);
    // 去顶栏 4 行 + 空 1 + 框 3;行尾 pad 空格剥掉再比内容(C16 满宽覆写是帧层行为,不关内容断言)。
    const body = (s: string): string[] =>
      plain(s.split("\n"))
        .slice(4, -4)
        .map((l) => l.replace(/ +$/, ""));
    expect(body(renderView(view({ live: liveEntry(m), verbose: false })))).toEqual([
      "  一二",
      "  三四",
    ]);
    expect(body(renderView(view({ entries: entriesFromMessages([m]), verbose: false })))).toEqual([
      `${STAR} 思考${MID}4字`,
    ]);
    expect(body(renderView(view({ entries: entriesFromMessages([m]), verbose: true })))).toEqual([
      "  一二",
      "  三四",
    ]);
  });
  it("C11 平价锚:--continue 整段重放 与 逐条 message_end 追加 渲染逐字符相等", () => {
    const msgs: AgentMessage[] = [
      asst([
        { type: "thinking", text: "想一\n想二" },
        { type: "text", text: "答" },
        { type: "toolCall", id: "t1", name: "read", arguments: {} },
      ]),
      {
        role: "toolResult",
        toolCallId: "t1",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      },
      asst([{ type: "thinking", text: "再想" }]),
    ];
    const replay = entriesFromMessages(msgs);
    const live: Entry[] = [];
    for (const m of msgs) live.push(...entriesFromMessages([m]));
    expect(entriesToLines(live, 60, false)).toEqual(entriesToLines(replay, 60, false));
    expect(entriesToLines(live, 60, true)).toEqual(entriesToLines(replay, 60, true));
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
  it("C11:相邻两个 thinking 块 → 合并单条 think,全文保留(\\n 相接)", () => {
    const es = entriesFromMessages([
      asst([
        { type: "thinking", text: "第一段\n细节" },
        { type: "thinking", text: "第二段" },
        { type: "text", text: "答复" },
      ]),
    ]);
    expect(es.map((e) => e.kind)).toEqual(["think", "bot"]);
    expect(es[0]!.text).toBe("第一段\n细节\n第二段");
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

// ---- C12:仅 bot 行过 markdown(顺序契约:分块→行内→wrapLines→前缀)----
describe("C12 bot markdown 接线", () => {
  const BB = "\x1b[1m";
  const DD = "\x1b[2m";
  const GG = "\x1b[32m";
  const RR = "\x1b[0m";
  const BULLET = String.fromCodePoint(0x2022); // •
  const VBAR_LINE = String.fromCodePoint(0x258d); // ▍
  const CHEV = String.fromCodePoint(0x203a); // ›
  it("bot 条目全谱:head/blank/bold/list 各成逻辑行,首行 ▍ 续行两空格(手算逐字符)", () => {
    const e: Entry = { kind: "bot", text: "# 标题\n\n**甲乙丙丁**\n\n- 项" };
    expect(entryLines(e, 10)).toEqual([
      `${GG}${VBAR_LINE}${RR} ${BB}标题${RR}`,
      "  ",
      `  ${BB}甲乙丙丁${RR}`,
      "  ",
      `  ${BULLET} 项`,
    ]);
  });
  it("AC-3:超宽 bold CJK 折行 = 每物理行自闭(尾 RESET 头重开)且 vw ≤ w", () => {
    const e: Entry = { kind: "bot", text: "**甲乙丙丁**" };
    // w=8 → 折行宽 6:三字 6 列断,丁独行重开 bold(独立于实现手算)。
    expect(entryLines(e, 8)).toEqual([`${GG}${VBAR_LINE}${RR} ${BB}甲乙丙${RR}`, `  ${BB}丁${RR}`]);
    expect(entryLines(e, 8).every((l) => vw(l) <= 8)).toBe(true);
  });
  it("AC-4:user/tool 行 #/** 保持字面,不过 markdown(逐字节=旧行为)", () => {
    expect(entryLines({ kind: "user", text: "# x\n**y**" }, 40)).toEqual([
      `${BB}${CHEV}${RR} # x`,
      "  **y**",
    ]);
    expect(entryLines({ kind: "tool", text: "**t**" }, 40)).toEqual([`${DD}▸${RR} **t**`]);
  });
  it("流式半开围栏 live bot = code 行不崩(liveEntry 同走 entryLines 派生链)", () => {
    expect(entryLines({ kind: "bot", text: "```\nabc" }, 40)).toEqual([
      `${GG}${VBAR_LINE}${RR} ${DD}abc${RR}`,
    ]);
  });
  it("AC-5:整屏多块 markdown 后 renderView 行数 ≤ height(预算算术不变)", () => {
    const big: Entry = {
      kind: "bot",
      text: Array.from(
        { length: 6 },
        (_, i) => `# 头${i}\n\n**中中中中中中中中**\n\n- 甲\n\n> 沟`,
      ).join("\n\n"),
    };
    const out = renderView(view({ entries: [big], height: 20 }));
    expect(out.split("\n").length).toBeLessThanOrEqual(20);
    // 弹层在场时预算收紧:框 3 + 顶空 1 + body ≥1,comp ≤ height−8。
    const withComp = renderView(
      view({
        entries: [big],
        height: 20,
        completion: {
          items: Array.from({ length: 12 }, (_, i) => ({
            name: `c${i}`,
            description: "",
            highlighted: false,
          })),
        },
      }),
    );
    expect(withComp.split("\n").length).toBeLessThanOrEqual(20);
  });
});
