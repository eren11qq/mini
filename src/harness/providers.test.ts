import { describe, expect, it } from "vitest";
import { resolveProvider } from "./providers.ts";

// S-a 缝:厂商只是配置行(PRD story 2 / G3「厂商≠方言」)。resolveProvider(alias)
// 查表返回 ProviderConfig;未知 alias 抛清晰错误。期望值取自配置行字面量(独立真相源),
// 不 recompute 实现。
describe("S-a resolveProvider:alias → 配置行", () => {
  it("deepseek → openai-completions 方言 + deepseek base_url + DEEPSEEK_API_KEY", () => {
    const p = resolveProvider("deepseek");
    expect(p.dialect).toBe("openai-completions");
    expect(p.base_url).toBe("https://api.deepseek.com/v1");
    expect(p.key_env).toBe("DEEPSEEK_API_KEY");
    expect(p.models[0]!.id).toBe("deepseek-chat");
  });

  it("glm 是独立配置行(不同 base_url/不同 key_env),非复用 deepseek", () => {
    const p = resolveProvider("glm");
    expect(p.base_url).not.toBe(resolveProvider("deepseek").base_url);
    expect(p.key_env).toBe("ZHIPU_API_KEY");
  });

  it("qwen → token-plan maas 端点 + QWEN_API_KEY + 1M 窗口(配置行字面量独立核对)", () => {
    const p = resolveProvider("qwen");
    expect(p.dialect).toBe("openai-completions");
    expect(p.base_url).toBe("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
    expect(p.key_env).toBe("QWEN_API_KEY");
    expect(p.models[0]!.id).toBe("qwen3.8-flash");
    expect(p.models[0]!.contextWindow).toBe(1000000);
  });

  it("未知 alias 抛错,提示可选厂商", () => {
    expect(() => resolveProvider("nope")).toThrow(/nope/);
  });
});
