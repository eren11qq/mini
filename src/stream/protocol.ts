// 卡 4(ADR-005):stream 缝契约住 stream 家 —— ProviderEvent(统一事件流)+ ModelDef/ProviderConfig
// (厂商配置)+ Transport(网络注入缝)+ StreamFn(loop 收下的函数形状)。此前五个挤 loop/types.ts,
// 任何缝契约变动都要动 loop 的文件,与「loop = 深模块、其余各管各缝」的所有权相反。
// 方向锁:protocol→loop/types(取 LoopContext/StopReason/Usage);loop/types 绝不 import 本文件,
// 否则 ADR-003 斩过的环从类型层复活。ProviderEvent 6 类照 PRD line 106(mini 减法:
// provider 层 start/text_delta/thinking_delta/toolcall_delta/done/error)。
import type { LoopContext, StopReason, Usage } from "../loop/types.ts";

// ---- provider 事件(流进 runLoop)----
// toolcall_delta 载 parsed args prefix(id+name+arguments);raw 累积 + salvage
// 解析归 S1 stream adapter(PRD S6),loop 只取最新 arguments 快照。pi 同理。
// AC-S1-3:done.usage? 为 M3 压缩阈值与成本核对来源;adapter 填,loop 透传。
export type ProviderEvent =
  | { type: "start" }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "toolcall_delta"; id: string; name: string; arguments: unknown }
  | { type: "done"; stopReason: StopReason; usage?: Usage }
  | { type: "error"; stopReason: "error" | "aborted"; errorMessage?: string };

// ---- S1 stream adapter 缝 ----
// createStream(config) 把 config 绑进 StreamFn(loop 缝不变)。
// Transport 是离线测试零网络关键:喂假 transport 回放 SSE 行;S2 mock fetch 走同缝。
export interface ModelDef {
  id: string;
  contextWindow: number;
}
export interface ProviderConfig {
  dialect: "openai-completions" | "anthropic-messages";
  base_url: string;
  key_env: string;
  models: ModelDef[];
}
export type Transport = (
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
) => AsyncIterable<string>;

// ---- streamFn 缝 ----
// 注:(config, context) 形态的 config 绑定留 S1 真 adapter;L1 假流只用 context。
// signal:Story 16"中断当前 LLM 流"——loop 把 options.signal 传进来,真 adapter 透传给
// transport→fetch(原 L3 注释"留 S1"的欠账);假流可忽略第二参。
export type StreamFn = (context: LoopContext, signal?: AbortSignal) => AsyncIterable<ProviderEvent>;
