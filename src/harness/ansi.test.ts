// P2 SGR 常量叶子自动测:值逐条码点钉死(漂移探测器,同 tui-view.test 精神);
// 契约两条:ansi 零依赖叶子、tui-view 单向依赖且重导出保对外面。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { B, BG, CYAN, DIM, GREEN, ITALIC, RED, RESET, YELLOW } from "./ansi.ts";
import * as tuiView from "./tui-view.ts";

describe("ansi.ts 常量叶子", () => {
  it("SGR 码逐条钉死(码点构造,防同形漂移)", () => {
    expect(B).toBe("\x1b[1m");
    expect(DIM).toBe("\x1b[2m");
    expect(ITALIC).toBe("\x1b[3m");
    expect(RED).toBe("\x1b[31m"); // C19 diff − 行
    expect(GREEN).toBe("\x1b[32m");
    expect(YELLOW).toBe("\x1b[33m");
    expect(CYAN).toBe("\x1b[36m");
    expect(BG).toBe("\x1b[48;5;238m"); // C23 user 灰底带(256 色深灰)
    expect(RESET).toBe("\x1b[0m");
  });
  it("tui-view 重导出同一对象:B 对外 import 面零改", () => {
    expect(tuiView.B).toBe(B);
  });
  it("叶子零依赖:ansi.ts 不 import 任何项目模块(单向 tui-view → ansi)", () => {
    const src = readFileSync(fileURLToPath(new URL("./ansi.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/from\s+"(\.\.?\/|src\/|@\/)/);
  });
});
