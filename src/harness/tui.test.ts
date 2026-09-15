import { describe, expect, it } from "vitest";
import { frameBytes, mapConfirm } from "./tui.ts";

// C16 防叠框钉:帧写序列禁 2J(Windows Terminal 把每帧整屏滚进 scrollback = 连续框带),
// 覆写全靠 home 顶格重写 + 帧尾 [J + renderView 行满宽 pad。
describe("C16 frameBytes 帧写序列", () => {
  it("home 起帧、帧尾 [J,全程不出现 2J", () => {
    const s = frameBytes("", "BODY");
    expect(s).toBe("\x1b[HBODY\x1b[0m\x1b[J");
    expect(s).not.toContain("\x1b[2J");
  });
});

// C6 AC-1/AC-5 键位侧:四档 1/2/3/4。旧三档映射(2=always)作废 —— session 档插进 2,
// always 顺位到 3,no 到 4。TUI 与 plain 两条输入流共用本纯函数(唯一答案翻译点)。
describe("C6 mapConfirm 四档键位", () => {
  it("1=一次性 / 2=session / 3=always / 4=拒绝", () => {
    expect(mapConfirm("1")).toEqual({ kind: "yes" });
    expect(mapConfirm("2")).toEqual({ kind: "session" });
    expect(mapConfirm("3")).toEqual({ kind: "always" });
    expect(mapConfirm("4")).toEqual({ kind: "no" });
  });

  it('y/yes 兼容 1;空串与乱输入仍判拒(Ctrl+C 送 "no" 走此支)', () => {
    expect(mapConfirm("y")).toEqual({ kind: "yes" });
    expect(mapConfirm("yes")).toEqual({ kind: "yes" });
    expect(mapConfirm("no")).toEqual({ kind: "no" });
    expect(mapConfirm("")).toEqual({ kind: "no" });
    expect(mapConfirm("随便打字")).toEqual({ kind: "no" });
  });

  // AC-3 输入侧:理由 = 档位后的同行文本(单行输入,TUI/plain 两流同式,零额外状态)。
  it("4 <理由> → no + reason;裸 4 = 无 reason;理由内空白保留", () => {
    expect(mapConfirm("4 这条会覆盖远端历史")).toEqual({
      kind: "no",
      reason: "这条会覆盖远端历史",
    });
    expect(mapConfirm("4")).toEqual({ kind: "no" });
    expect(mapConfirm("4  带 空格 的理由")).toEqual({ kind: "no", reason: "带 空格 的理由" });
  });
});
