// H3 S-c 纯缝:AgentMessage[] → `[role]` 行文本,供生产 summarizeFn 拼在
// buildSummarizePrompt 之后(M4 注的"上层")。thinking 块丢 —— 内部推理不进纪要
// (方言适配器回传 provider 时也丢它,口径一致)。isError 保标记:失败是被压缩历史的一部分。
import type { AgentMessage, TextBlock } from "../loop/types.ts";

const textOf = (blocks: TextBlock[]): string => blocks.map((b) => b.text).join(" ");

export function serializeConversation(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      lines.push(`[user] ${m.content}`);
      continue;
    }
    if (m.role === "toolResult") {
      lines.push(`[toolResult${m.isError ? " isError" : ""}] ${m.toolName} ${textOf(m.content)}`);
      continue;
    }
    // assistant:text 逐块成行,toolCall 单行(args JSON 化);thinking 丢 → 全空则整条不发声。
    for (const b of m.content) {
      if (b.type === "text") lines.push(`[assistant] ${b.text}`);
      else if (b.type === "toolCall")
        lines.push(`[toolCall] ${b.name} ${JSON.stringify(b.arguments)}`);
    }
  }
  return lines.join("\n");
}
