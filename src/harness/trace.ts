// D2(docs/ISSUES.md)纯叶:AgentEvent → trace JSONL 单行(裁决零 fs —— append 住 cli 订阅环)。
// 行形状 = {ts, agentId?, ...event}:事件名与字段原样保留,仅加 ts(毫秒,注入 clock,与
// RunLoopOptions.clock 同款);D4 给事件加 agentId 后自动随行(spread 位 = ts 之后),零特判。
// 为什么这么抠:trace ≈ MAF OpenTelemetry 导出面,格式先钉死(故事 10),日后转 OTLP 不改行。
import type { AgentEvent } from "../loop/types.ts";

export function traceLine(event: AgentEvent, clock: () => number): string {
  // agentId 提升位 = ts 之后(D2 卡行形状 {ts, agentId?, ...event};D4 契约扩已入
  // types.ts,预留 cast 摘除)。缺省 undefined → JSON.stringify 零键 = 主代理行 diff-0。
  const { agentId, ...rest } = event;
  return JSON.stringify({ ts: clock(), agentId, ...rest });
}
