import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.ts";

// S-b 缝:flags 全集仅 3 个(DECISIONS H2)。手工解析(照 pi,无第三方库)。
// 只记录出现与否,continue/resume 优先级留给 cli 组装(本函数纯)。
describe("S-b parseArgs", () => {
  it("--model 带值 → model=alias,其余缺省", () => {
    expect(parseArgs(["--model", "glm"])).toEqual({
      model: "glm",
      continue: false,
      resume: false,
    });
  });

  it("--continue / --resume 布尔开关", () => {
    expect(parseArgs(["--continue"])).toEqual({
      model: undefined,
      continue: true,
      resume: false,
    });
    expect(parseArgs(["--resume"])).toEqual({
      model: undefined,
      continue: false,
      resume: true,
    });
  });

  it("组合:--model 与 --continue 同时给,各自记录", () => {
    expect(parseArgs(["--model", "deepseek", "--continue"])).toEqual({
      model: "deepseek",
      continue: true,
      resume: false,
    });
  });

  it("空 argv → 全缺省", () => {
    expect(parseArgs([])).toEqual({ model: undefined, continue: false, resume: false });
  });

  it("--model 缺值 → 抛错(不静默当未给)", () => {
    expect(() => parseArgs(["--model"])).toThrow(/--model/);
  });
});
