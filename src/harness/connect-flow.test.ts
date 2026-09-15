import { describe, expect, it } from "vitest";
import { reduceConnect, type ConnectState } from "./connect-flow.ts";

// C17 主缝:connect-flow reducer 迁移表(照 kilo dialog-provider API-key 分支)。
// reducer 零 I/O 零状态:⏎ 非空只发 submit 意图,saveKey/switchModel 由 cli 消费 effect。
describe("C17 connect reducer —— 迁移表", () => {
  const idle: ConnectState = { step: "idle" };

  it("open:idle → pick,sel=0,aliases 入态", () => {
    expect(reduceConnect(idle, { type: "open", aliases: ["qwen", "glm"] })).toEqual({
      state: { step: "pick", sel: 0, aliases: ["qwen", "glm"] },
    });
  });

  const abc: ConnectState = { step: "pick", sel: 0, aliases: ["a", "b", "c"] };
  it("↑↓ 环绕:中段平移;末位 down → 0;首位 up → 末位(kilo 环绕语义)", () => {
    expect(reduceConnect(abc, { type: "down" })).toEqual({
      state: { step: "pick", sel: 1, aliases: ["a", "b", "c"] },
    });
    expect(
      reduceConnect({ step: "pick", sel: 2, aliases: ["a", "b", "c"] }, { type: "down" }),
    ).toEqual({
      state: { step: "pick", sel: 0, aliases: ["a", "b", "c"] },
    });
    expect(reduceConnect(abc, { type: "up" })).toEqual({
      state: { step: "pick", sel: 2, aliases: ["a", "b", "c"] },
    });
  });

  it("pick ⏎ → keyIn:alias = sel 命中,buf 空(单 method,跳过多选)", () => {
    expect(
      reduceConnect({ step: "pick", sel: 1, aliases: ["a", "b", "c"] }, { type: "enter" }),
    ).toEqual({
      state: { step: "keyIn", alias: "b", buf: "" },
    });
  });

  it("keyIn 字符追加 / backspace 删尾;pick 态打字 = 忽略(kilo 明文输入,不打码)", () => {
    const k: ConnectState = { step: "keyIn", alias: "qwen", buf: "sk-" };
    expect(reduceConnect(k, { type: "char", ch: "a" })).toEqual({
      state: { step: "keyIn", alias: "qwen", buf: "sk-a" },
    });
    expect(reduceConnect(k, { type: "backspace" })).toEqual({
      state: { step: "keyIn", alias: "qwen", buf: "sk" },
    });
    expect(reduceConnect(abc, { type: "char", ch: "x" })).toEqual({ state: abc });
  });

  it("keyIn ⏎ 空(含纯空白)→ 不关继续等,零 effect(kilo 语义)", () => {
    const k: ConnectState = { step: "keyIn", alias: "qwen", buf: "" };
    expect(reduceConnect(k, { type: "enter" })).toEqual({ state: k });
    expect(reduceConnect({ step: "keyIn", alias: "qwen", buf: "   " }, { type: "enter" })).toEqual({
      state: { step: "keyIn", alias: "qwen", buf: "   " },
    });
  });

  it("keyIn ⏎ 非空 → idle + submit 意图(key = trim 后原文,reducer 零落盘)", () => {
    expect(
      reduceConnect({ step: "keyIn", alias: "qwen", buf: " sk-a1 " }, { type: "enter" }),
    ).toEqual({
      state: { step: "idle" },
      effect: { type: "submit", alias: "qwen", key: "sk-a1" },
    });
  });

  it("Esc 两步均整层 cancel(零落盘);idle 态 Esc/⏎/打字 = 忽略", () => {
    expect(reduceConnect(abc, { type: "esc" })).toEqual({
      state: idle,
      effect: { type: "cancel" },
    });
    expect(reduceConnect({ step: "keyIn", alias: "qwen", buf: "sk-x" }, { type: "esc" })).toEqual({
      state: idle,
      effect: { type: "cancel" },
    });
    expect(reduceConnect(idle, { type: "esc" })).toEqual({ state: idle });
    expect(reduceConnect(idle, { type: "enter" })).toEqual({ state: idle });
    expect(reduceConnect(idle, { type: "char", ch: "x" })).toEqual({ state: idle });
  });
});
