import { describe, expect, it } from "vitest";
import { resolveModel } from "./resolve-model.ts";

// S-d 缝:启动时「用哪个厂商」的优先级裁决。放纯函数(而非塞进 HITL 的 cli.ts)= 让这条
// 规则可测。规则:显式 --model > resume 会话末条 model_change > 默认。
// 断言的是「哪个来源胜出」的行为,不是复述 ?? 链。
describe("S-d resolveModel 优先级", () => {
  it("显式 --model 覆盖 resume 恢复的 model", () => {
    expect(resolveModel({ cliModel: "kimi", rebuiltModel: "glm", defaultAlias: "deepseek" })).toBe(
      "kimi",
    );
  });

  it("无 --model → 用 resume 路径末条 model_change", () => {
    expect(
      resolveModel({ cliModel: undefined, rebuiltModel: "glm", defaultAlias: "deepseek" }),
    ).toBe("glm");
  });

  it("两者皆无 → 默认厂商", () => {
    expect(
      resolveModel({ cliModel: undefined, rebuiltModel: undefined, defaultAlias: "deepseek" }),
    ).toBe("deepseek");
  });
});
