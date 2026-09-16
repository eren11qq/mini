import { describe, expect, it } from "vitest";
import { resolveModel } from "./resolve-model.ts";

// S-d 缝:启动时「用哪个厂商」的优先级裁决。放纯函数(而非塞进 HITL 的 cli.ts)= 让这条
// 规则可测。规则:显式 --model > resume 会话末条 model_change > 全局 config > 无(defaultAlias 已废)。
// 断言的是「哪个来源胜出」的行为,不是复述 ?? 链。
describe("S-d resolveModel 优先级", () => {
  it("显式 --model 覆盖 resume 恢复的 model", () => {
    expect(resolveModel({ cliModel: "kimi", rebuiltModel: "glm", configModel: "deepseek" })).toBe(
      "kimi",
    );
  });

  it("无 --model → 用 resume 路径末条 model_change(config 在场也不赢)", () => {
    expect(
      resolveModel({ cliModel: undefined, rebuiltModel: "glm", configModel: "deepseek" }),
    ).toBe("glm");
  });

  it("cli 与会话皆无 → 用全局 config(修「每次打开掉回出厂默认」的根案)", () => {
    expect(
      resolveModel({ cliModel: undefined, rebuiltModel: undefined, configModel: "qwen" }),
    ).toBe("qwen");
  });

  it("三源皆无 → undefined(cli 层负责 warn 引导 /connect,零默认)", () => {
    expect(
      resolveModel({ cliModel: undefined, rebuiltModel: undefined, configModel: undefined }),
    ).toBeUndefined();
  });
});
