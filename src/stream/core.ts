// S3 派发器 = stream 缝入口:dialect=anthropic-messages → anthropicStream;else openai(已有)。
// withRetry 统一包一层(两边共 Transport 缝)。createStream(config, deps) 签名不变 → 上层零改动
// (AC-S3-3);调用方唯一变化 = import 落点从 openai-completions.ts 改为本文件。
// 卡 1(ADR-003):dispatch 必须独立成文件且不被方言导入 —— 否则 core⇄方言 环 import 复活;
// 共享物(salvage/transport)住叶子,方向只有 方言→叶子、core→{叶子,方言}。
import type {
  LoopContext,
  ProviderConfig,
  ProviderEvent,
  StreamFn,
  Transport,
} from "../loop/types.ts";
import { defaultTransport, withRetry } from "./transport.ts";
import { openaiStream } from "./openai-completions.ts";
import { anthropicStream } from "./anthropic-messages.ts";

export interface StreamDeps {
  transport?: Transport;
}

export function createStream(config: ProviderConfig, deps?: StreamDeps): StreamFn {
  const transport = withRetry(deps?.transport ?? defaultTransport, 1);
  return function stream(context: LoopContext, signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    return config.dialect === "anthropic-messages"
      ? anthropicStream(config, transport, context, signal)
      : openaiStream(config, transport, context, signal);
  };
}
