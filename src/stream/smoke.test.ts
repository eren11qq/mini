import { describe, it, expect } from "vitest";
import { createStream } from "./core.ts";
import type { ProviderConfig, ProviderEvent } from "../loop/types.ts";

// AC-S4-1 验收句:deepseek 真实在线 smoke —— 持 DEEPSEEK_API_KEY 跑 createStream(默认 transport
// = 真 fetch),收 ProviderEvent 流;断言 text_delta 与 toolcall_delta 均出现(模型真用工具)。
// 默认无密钥 → skipIf 不跑 → 零网络(AC-S4-3)。绿需人工触发(vitest run src/stream/smoke.test.ts)。

// AC-S4-2: 在线 smoke 跑通
// Scenario:env 有 DEEPSEEK_API_KEY
// Action:vitest run src/stream/smoke.test.ts(人工触发)
// Expected:deepseek 真实流;text_delta 与 toolcall_delta 均出现
// Verification:绿(人工触发);默认 npm test 因 skipIf 跳过 → 零网络(AC-S4-3)
// 注:vitest 3.2 无 --tag/选项,故用文件定向跑替代 plan 的 --tag smoke。

const deepseekReal: ProviderConfig = {
  dialect: "openai-completions",
  base_url: "https://api.deepseek.com/v1",
  key_env: "DEEPSEEK_API_KEY",
  models: [{ id: "deepseek-chat", contextWindow: 64000 }],
};

const echoTool = {
  name: "echo",
  description: "Echo back the given path. Call this tool when the user asks to echo.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "path to echo" } },
    required: ["path"],
  },
};

describe("AC-S4-2 deepseek 在线 smoke", () => {
  // AC-S4-3:无 DEEPSEEK_API_KEY → 跳过(默认 npm test 零网络)。
  it.skipIf(!process.env.DEEPSEEK_API_KEY)(
    "真实流:text_delta 与 toolcall_delta 均出现",
    { timeout: 60_000 },
    async () => {
      const streamFn = createStream(deepseekReal);
      const events: ProviderEvent[] = [];
      for await (const ev of streamFn({
        messages: [
          {
            role: "user",
            content: "Briefly say the word 'checking', then call the echo tool with path '/x'.",
          },
        ],
        tools: [echoTool],
      })) {
        events.push(ev);
        const last = events.at(-1)?.type;
        if (last === "done" || last === "error") break;
      }
      expect(events.some((e) => e.type === "text_delta")).toBe(true);
      expect(events.some((e) => e.type === "toolcall_delta")).toBe(true);
      expect(["done", "error"]).toContain(events.at(-1)?.type);
    },
  );
});
