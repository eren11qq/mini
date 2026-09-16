// H2 S-a 缝:厂商配置行表(G3「厂商≠方言」/ PRD story 2「加厂商只加配置行」)。
// 加一家 = PROVIDERS 加一行,零改代码。--model <alias> / model_change entry 都存 alias,
// 由此表翻成完整 ProviderConfig(dialect 决定用哪个适配器)。key_env 指向的 env 变量 = 第一源;
// 缺时由 harness/keys.ts 的 0600 落盘 store 兜底(C15;C18 后写盘入口唯一 = /connect)。
import type { ProviderConfig } from "../stream/protocol.ts";

export const PROVIDERS: Record<string, ProviderConfig> = {
  deepseek: {
    dialect: "openai-completions",
    base_url: "https://api.deepseek.com/v1",
    key_env: "DEEPSEEK_API_KEY",
    models: [{ id: "deepseek-chat", contextWindow: 64000 }],
  },
  glm: {
    dialect: "openai-completions",
    base_url: "https://open.bigmodel.cn/api/paas/v4",
    key_env: "ZHIPU_API_KEY",
    models: [{ id: "glm-4-plus", contextWindow: 128000 }],
  },
  // 阿里云百炼 token-plan MaaS 端点(OpenAI 兼容)。1M 窗口 = /compact 自动阈值按此算。
  qwen: {
    dialect: "openai-completions",
    base_url: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    key_env: "QWEN_API_KEY",
    models: [{ id: "qwen3.8-flash", contextWindow: 1000000 }],
  },
};

export function resolveProvider(alias: string): ProviderConfig {
  const p = PROVIDERS[alias];
  if (!p) {
    throw new Error(`unknown provider "${alias}" (可选:${Object.keys(PROVIDERS).join(" / ")})`);
  }
  return p;
}
