import { describe, it, expect } from "vitest";
import { createStream, TransportError } from "./openai-completions.js";
import type { ProviderConfig, ProviderEvent, Transport } from "../loop/types.js";

// AC-S2-2: 5xx 重试 1 次成功
// Scenario:mock fetch 第 1 次 503、第 2 次 200+正常 SSE
// Action:stream
// Expected:重试 1 次,流出正常事件流
// Verification:vitest — 断言 fetch 调用 2 次、事件正常

const cfg: ProviderConfig = {
  dialect: "openai-completions",
  base_url: "https://api.deepseek.example/v1",
  key_env: "DEEPSEEK_API_KEY",
  models: [{ id: "deepseek-chat", contextWindow: 64000 }],
};

const okFixture = [
  `data: {"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}`,
  `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}`,
  `data: [DONE]`,
];

function flakyTransport(opts: {
  failStatus?: number;
  isTimeout?: boolean;
  alwaysFail?: boolean;
  lines: string[];
}): { transport: Transport; calls: () => number } {
  let n = 0;
  const transport: Transport = async function* () {
    n += 1;
    const shouldFail = opts.alwaysFail || n === 1;
    if (shouldFail && (opts.failStatus || opts.isTimeout)) {
      throw new TransportError(opts.isTimeout ? "timeout" : `HTTP ${opts.failStatus}`, {
        status: opts.failStatus,
        isTimeout: opts.isTimeout,
      });
    }
    for (const line of opts.lines) yield line;
  };
  return { transport, calls: () => n };
}

async function drain(streamFn: ReturnType<typeof createStream>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const ev of streamFn({ messages: [] })) events.push(ev);
  return events;
}

describe("AC-S2-2 5xx 重试 1 次成功", () => {
  it("503 第1次 → 重试 → 正常事件流,transport 调 2 次", async () => {
    const { transport, calls } = flakyTransport({ failStatus: 503, lines: okFixture });
    const streamFn = createStream(cfg, { transport });
    const events = await drain(streamFn);

    expect(calls()).toBe(2);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)?.type).toBe("done");
    if (events.at(-1)?.type === "done") {
      expect((events.at(-1) as { stopReason: string }).stopReason).toBe("stop");
    }
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(text).toBe("Hi");
  });
});

// AC-S2-3: 5xx 二次仍败
// Scenario:mock fetch 恒 503
// Action:stream
// Expected:流出 error 事件(含 503/原因);不 throw 中断 runLoop
// Verification:vitest — 断言 error 事件、stream 不 reject
describe("AC-S2-3 5xx 二次仍败", () => {
  it("恒 503 → error 事件含 503,stream 不 reject", async () => {
    const { transport, calls } = flakyTransport({
      alwaysFail: true,
      failStatus: 503,
      lines: okFixture,
    });
    const streamFn = createStream(cfg, { transport });
    const events = await drain(streamFn);

    expect(calls()).toBe(2); // 初试 + 重试1次
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect((err as { errorMessage?: string }).errorMessage).toContain("503");
    expect(events.some((e) => e.type === "done")).toBe(false);
  });
});

// AC-S2-4: 4xx 即停
// Scenario:mock fetch 401
// Action:stream
// Expected:不重试,立即流出 error 事件(含 401+原因)
// Must not:fetch 调用 >1 次
// Verification:vitest — 断言 fetch 调用 = 1、error 事件含 401
describe("AC-S2-4 4xx 即停", () => {
  it("401 → 不重试,transport 调 1 次,error 含 401", async () => {
    const { transport, calls } = flakyTransport({
      alwaysFail: true,
      failStatus: 401,
      lines: okFixture,
    });
    const streamFn = createStream(cfg, { transport });
    const events = await drain(streamFn);

    expect(calls()).toBe(1);
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect((err as { errorMessage?: string }).errorMessage).toContain("401");
  });
});

// AC-S2-5: 超时同 5xx
// Scenario:mock fetch 超过 timeout
// Action:stream
// Expected:走重试路径(同 AC-S2-2/S2-3)
// Verification:vitest — 超时 fixture 走重试断言
describe("AC-S2-5 超时同 5xx", () => {
  it("timeout 第1次 → 重试 → 成功,transport 调 2 次", async () => {
    const { transport, calls } = flakyTransport({ isTimeout: true, lines: okFixture });
    const streamFn = createStream(cfg, { transport });
    const events = await drain(streamFn);

    expect(calls()).toBe(2);
    expect(events.at(-1)?.type).toBe("done");
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("恒 timeout → error 事件,transport 调 2 次", async () => {
    const { transport, calls } = flakyTransport({
      alwaysFail: true,
      isTimeout: true,
      lines: okFixture,
    });
    const streamFn = createStream(cfg, { transport });
    const events = await drain(streamFn);

    expect(calls()).toBe(2);
    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
  });
});
