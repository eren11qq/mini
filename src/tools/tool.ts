// 卡 4(ADR-005):L2 工具注册表词汇住 tools 家 —— Tool/ToolResult。此前住 loop/types.ts,
// 而 LoopContext.tools 是 unknown[] 逃生舱 → 方言 (t: any) 鸭子 + cli 预映射,一个 tool 三种表示。
// 本刀敲实:LoopContext.tools?: Tool[](类型在 loop/types.ts),方言直接从注册表映射 wire
// (schema→parameters/input_schema),cli 的 providerTools 预映射删除。
// Tool.run 失败靠返回 isError:true ToolResult 回喂,不 throw(L3 error 进流同样约束)。
// confirm gate 留 T2(beforeToolCall hook),L2 工具直接执行。
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { TextBlock } from "../blocks.ts";
import type { ToolDetails } from "../util/diff.ts";

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
  // bash 的 `git push` → `git:*`。C2 起落盘值与判据输入分离:种子只决定"存什么"。
  // 缺省 = 用 matchOf(再缺省 = JSON.stringify(args))同值,整串相等。
  prefixOf?: (args: unknown) => string;
  // C2(docs/ISSUES.md):确认门判据输入 = 完整待执行事实(bash 给整条命令、文件类给
  // `path:`+规范化路径),交 rules.ruleMatches 判家族/glob/相等。
  // 缺省 = JSON.stringify(args)(无域知识工具整串精确匹配,旧语义)。
  matchOf?: (args: unknown) => string;
  // C3(docs/ISSUES.md):声明 matchOf 输入是 shell 命令 → loop 用 bash-parse 拆段逐段过检,
  // 任一段不命中即弹;always 落盘逐段种子。缺省 = C2 单输入路径。
  // 域知识 = 一个枚举标记,解析语法知识住 loop/bash-parse.ts,matcher 仍零工具名知识。
  // C5(docs/ISSUES.md):"path" = matchOf 输入是 `path:` 域 → loop 过 danger.dangerOfPath 黑名单。
  matchKind?: "shell" | "path";
  // Story 16 / T4:loop 把 options.signal 透传给 run,工具(尤其 bash)据此中断/杀进程树。
  // 可选参 → 不观测 signal 的既有工具零改动。
  run(args: unknown, signal?: AbortSignal): Promise<ToolResult>;
}
// C1(docs/ISSUES.md):种子抽取(prefixOf)= `path:` + cwd 内规范化相对路径(正斜杠);
// cwd 外/盘根 → 返 `*` = AC-T2-8 既有拒写标记,always 退化一次性 yes(loop 零新码)。
export function pathInput(a: unknown): string {
  const r = pathRelOrMarker(a);
  return r === null ? "*" : r;
}

// C5(docs/ISSUES.md):判据抽取(matchOf)= cwd 内同上;cwd 外不再塌成 `*` 而是
// `path:`+绝对 —— 危险黑名单(`~/.ssh/**` `~/.aws/**` `**/*.env`)要有料可查。
// 现有规则全为相对种子 → 绝对输入永不命中,弹/C1 拒粘行为零变化。
export function pathMatchOf(a: unknown): string {
  const r = pathRelOrMarker(a);
  return (
    r ??
    `path:${resolve(String((a as { path?: unknown }).path ?? ""))
      .split(sep)
      .join("/")}`
  );
}

function pathRelOrMarker(a: unknown): string | null {
  const abs = resolve(String((a as { path?: unknown }).path ?? ""));
  const rel = relative(process.cwd(), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return `path:${rel.split(sep).join("/")}`;
}

export interface ToolResult {
  content: TextBlock[];
  isError: boolean;
  // AC-L3-5:某 ToolResult 标 terminate=true → 该批 tool_execution_end 全完后停。
  terminate?: boolean;
  // C19(docs/ISSUES.md):结构化展示侧信道(如 edit 的红绿 diff)。
  // 持久化只走 content → provider 每轮重吃大 diff 的 token 污染从根上绕开;
  // run-loop 把 result 按引用塞进 tool_execution_end 事件,loop/stream 零改动。
  details?: ToolDetails;
}
