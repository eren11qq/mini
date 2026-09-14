// M4:纪要七段规格单源(PRD #28 / DECISIONS ③ M3)。compact 只调注入的 summarizeFn、自身零网络 ——
// 生产路径上层(H3 /compact、阈值钩子)拿本 prompt 配同模型流生成纪要;测试注入假函数即 AC-M4-5 零网络。
// 二次压缩 = UPDATE 式:传 previousSummary 时指令要求"与旧纪要增量合并成一份",而非另起一份。

export const SUMMARY_SECTIONS = [
  "目的",
  "做到哪了",
  "关键要点",
  "引用文件",
  "关键决定",
  "下一步",
  "关键背景",
] as const;

export type SummarySection = (typeof SUMMARY_SECTIONS)[number];

// 生成给 LLM 的中文指令(不含对话正文 —— 上层把 serializeConversation(messages) 拼在后面)。
// previousSummary 缺省 = 从零生成;给定 = 旧纪要 + 新段增量合并(纪要恒一份)。
export function buildSummarizePrompt(previousSummary?: string): string {
  const sections = SUMMARY_SECTIONS.map((s) => `## ${s}`).join("\n");
  const task =
    previousSummary === undefined
      ? "请把下面的对话历史压缩成一份中文纪要,严格使用以下七段格式(标题原样保留,内容用中文):"
      : "之前的对话已经压缩成一份纪要。请把旧纪要与下面新增的对话内容增量合并更新为一份中文纪要(按段合并/覆盖,禁止堆叠成两份),严格使用以下七段格式(标题原样保留,内容用中文):";
  const old =
    previousSummary === undefined
      ? ""
      : `\n<previous_summary>\n${previousSummary}\n</previous_summary>\n`;
  return `${task}\n${sections}\n${old}`;
}
