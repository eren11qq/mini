import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.ts";

// S-b 缝:flags 全集现 5 个(DECISIONS H2;D2 加 --no-trace)。手工解析(照 pi,无第三方库)。
// 只记录出现与否,continue/resume 优先级留给 cli 组装(本函数纯)。
describe("S-b parseArgs", () => {
  it("--model 带值 → model=alias,其余缺省", () => {
    expect(parseArgs(["--model", "glm"])).toEqual({
      model: "glm",
      continue: false,
      resume: false,
      autoAcceptEdits: false,
      trace: true,
    });
  });

  it("--continue / --resume 布尔开关", () => {
    expect(parseArgs(["--continue"])).toEqual({
      model: undefined,
      continue: true,
      resume: false,
      autoAcceptEdits: false,
      trace: true,
    });
    expect(parseArgs(["--resume"])).toEqual({
      model: undefined,
      continue: false,
      resume: true,
      autoAcceptEdits: false,
      trace: true,
    });
  });

  it("组合:--model 与 --continue 同时给,各自记录", () => {
    expect(parseArgs(["--model", "deepseek", "--continue"])).toEqual({
      model: "deepseek",
      continue: true,
      resume: false,
      autoAcceptEdits: false,
      trace: true,
    });
  });

  it("空 argv → 全缺省", () => {
    expect(parseArgs([])).toEqual({
      model: undefined,
      continue: false,
      resume: false,
      autoAcceptEdits: false,
      trace: true,
    });
  });

  it("--model 缺值 → 抛错(不静默当未给)", () => {
    expect(() => parseArgs(["--model"])).toThrow(/--model/);
  });

  it("--auto-accept-edits 缺省 → false", () => {
    expect(parseArgs([]).autoAcceptEdits).toBe(false);
  });

  it("--auto-accept-edits 布尔开关 → true(不吞后续值)", () => {
    expect(parseArgs(["--auto-accept-edits"])).toEqual({
      model: undefined,
      continue: false,
      resume: false,
      autoAcceptEdits: true,
      trace: true,
    });
  });

  it("--auto-accept-edits 与 --model/--continue 任意顺序共存", () => {
    expect(parseArgs(["--model", "glm", "--auto-accept-edits"])).toEqual({
      model: "glm",
      continue: false,
      resume: false,
      autoAcceptEdits: true,
      trace: true,
    });
    expect(parseArgs(["--auto-accept-edits", "--continue", "--model", "glm"])).toEqual({
      model: "glm",
      continue: true,
      resume: false,
      autoAcceptEdits: true,
      trace: true,
    });
  });

  it("未知近似 flag --auto-accept-edits-x 不算数(仅精确匹配)", () => {
    expect(parseArgs(["--auto-accept-edits-x"]).autoAcceptEdits).toBe(false);
  });

  // D2(docs/ISSUES.md):trace 缺省即开,--no-trace 关。布尔同款 C7 先例。
  it("--no-trace 缺省 → trace=true(缺省即开)", () => {
    expect(parseArgs([]).trace).toBe(true);
  });

  it("--no-trace 布尔开关 → trace=false(不吞后续值)", () => {
    expect(parseArgs(["--no-trace"])).toEqual({
      model: undefined,
      continue: false,
      resume: false,
      autoAcceptEdits: false,
      trace: false,
    });
    expect(parseArgs(["--no-trace", "--model", "glm"])).toEqual({
      model: "glm",
      continue: false,
      resume: false,
      autoAcceptEdits: false,
      trace: false,
    });
  });

  it("未知近似 flag --no-tracex 不算数(仍缺省开)", () => {
    expect(parseArgs(["--no-tracex"]).trace).toBe(true);
  });
});
