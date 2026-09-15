// 卡 3(ADR-004):纪要配方住这儿 —— 「什么构成纪要」= 七段指令 + 对话正文 + 一条 user 消息喂模型
// + 排空取文本。此前这段在 harness/cli.ts,与 summarize-prompt.ts、serialize.ts 三处撕开,且 cli.ts
// 整文件 CI 不可见。SessionManager.compact 的签名不变(仍收 summarizeFn),本文件只提供生产用的那一份
// 实现:注入 llm = StreamFn 形状(loop/stream 的既有缝),测试喂假流即零网络(S4 教条)。
import type { AgentMessage } from "../loop/types.ts";
import type { StreamFn } from "../stream/protocol.ts";
import { serializeConversation } from "./serialize.ts";
import { buildSummarizePrompt } from "./summarize-prompt.ts";

export function makeSummarizeFn(
  llm: StreamFn,
): (toSummarize: AgentMessage[], previousSummary?: string) => Promise<string> {
  return async (toSummarize, previousSummary) => {
    const prompt = `${buildSummarizePrompt(previousSummary)}\n${serializeConversation(toSummarize)}`;
    let text = "";
    for await (const ev of llm({ messages: [{ role: "user", content: prompt }], tools: [] })) {
      if (ev.type === "text_delta") text += ev.delta;
      // error 进流 = 纪要不可信,必须上抛(绝不拿半截文本当纪要落盘);文案沿用原 cli 侧口径。
      else if (ev.type === "error") throw new Error(ev.errorMessage ?? "summarize 流错误");
    }
    return text;
  };
}
