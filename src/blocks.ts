// 卡 4(ADR-005):content blocks = ToolResult 与 messages 共用的最小共享物,独立成顶层叶子。
// 为什么不在任何一缝家里:blocks 留 loop/types 时,LoopContext.tools: Tool[] 一敲实就生环
// (loop→tools 取 Tool、tools→loop 取 TextBlock)。ADR-003 规矩「共享物住叶子」的同款解法。
// 方向锁:本文件零 import(叶子);loop/tools/stream 只能指过来,绝不指回去。

// ---- content 块 ----
export interface TextBlock {
  type: "text";
  text: string;
}
export interface ThinkingBlock {
  type: "thinking";
  text: string;
}
export interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}
export type ContentBlock = TextBlock | ThinkingBlock | ToolCallBlock;
