// 卡 4(ADR-005):L2 工具注册表词汇住 tools 家 —— Tool/ToolResult。此前住 loop/types.ts,
// 而 LoopContext.tools 是 unknown[] 逃生舱 → 方言 (t: any) 鸭子 + cli 预映射,一个 tool 三种表示。
// 本刀敲实:LoopContext.tools?: Tool[](类型在 loop/types.ts),方言直接从注册表映射 wire
// (schema→parameters/input_schema),cli 的 providerTools 预映射删除。
// Tool.run 失败靠返回 isError:true ToolResult 回喂,不 throw(L3 error 进流同样约束)。
// confirm gate 留 T2(beforeToolCall hook),L2 工具直接执行。
import type { TextBlock } from "../blocks.ts";

export interface Tool {
  name: string;
  // H1 装配发现:方言适配器把 context.tools 翻成 provider 的 function 数组时要用
  // description,而真工具原先只有 name → 模型看不见说明。
  // 缺省 = 不发(假工具/测试零改动)。
  description?: string;
  // T2 AC-T2-4:旁挂 JSON Schema,loop 在 run 前 ajv 校验(照 pi prepare→validate);
  // 失败 → error toolResult 回喂,不执行 run、不断循环。缺省 = 不校验。
  schema?: object;
  // T2 AC-T2-5/6:声明豁免 beforeToolCall 确认门(= 只读类,read 置 true)。
  // 缺省 false → 新工具自动过安检(story 24,确认逻辑在 loop 不在工具)。
  skipConfirm?: boolean;
  // T2 AC-T2-7:"always" 落盘的规则种子抽取器(工具声明域知识,确认逻辑仍在 loop)。
  // bash 的 `git push` → `git:*`。loop 对同工具的新调用再抽一次,字符串相等 = 免弹。
  // 缺省 = 用 JSON.stringify(args) 整参精确匹配。
  prefixOf?: (args: unknown) => string;
  // Story 16 / T4:loop 把 options.signal 透传给 run,工具(尤其 bash)据此中断/杀进程树。
  // 可选参 → 不观测 signal 的既有工具零改动。
  run(args: unknown, signal?: AbortSignal): Promise<ToolResult>;
}
export interface ToolResult {
  content: TextBlock[];
  isError: boolean;
  // AC-L3-5:某 ToolResult 标 terminate=true → 该批 tool_execution_end 全完后停。
  terminate?: boolean;
}
