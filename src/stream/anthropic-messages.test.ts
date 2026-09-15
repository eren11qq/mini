import { describe, it, expect } from "vitest";
import { createStream } from "./core.ts";
import type { ProviderConfig, ProviderEvent, Transport } from "./protocol.ts";

// AC-S3-2: thinking_delta 映射
// Scenario:录制 anthropic SSE(含 thinking 块,脱敏)
// Action:stream(config dialect=anthropic-messages)
// Expected:thinking 块翻成 thinking_delta 事件;其余 text/toolcall 同 S1 协议
// Verification:vitest — 断言 thinking_delta 出现、事件类型 ⊆ 契约六类

const anthropicCfg: ProviderConfig = {
  dialect: "anthropic-messages",
  base_url: "https://api.anthropic.example/v1",
  key_env: "ANTHROPIC_API_KEY",
  models: [{ id: "claude-test", contextWindow: 200000 }],
};

// 脱敏合成 anthropic SSE:thinking 块 + text 块 + end_turn 收尾。
const thinkingFixture = [
  `event: message_start`,
  `data: {"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[],"model":"claude-test","stop_reason":null,"usage":{"input_tokens":5,"output_tokens":0}}}`,
  ``,
  `event: content_block_start`,
  `data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`,
  ``,
  `event: content_block_delta`,
  `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think"}}`,
  ``,
  `event: content_block_stop`,
  `data: {"type":"content_block_stop","index":0}`,
  ``,
  `event: content_block_start`,
  `data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
  ``,
  `event: content_block_delta`,
  `data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi there"}}`,
  ``,
  `event: content_block_stop`,
  `data: {"type":"content_block_stop","index":1}`,
  ``,
  `event: message_delta`,
  `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":5,"output_tokens":3}}`,
  ``,
  `event: message_stop`,
  `data: {"type":"message_stop"}`,
];

function replayTransport(lines: string[]): Transport {
  return async function* () {
    for (const line of lines) yield line;
  };
}

async function drain(streamFn: ReturnType<typeof createStream>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const ev of streamFn({ messages: [] })) events.push(ev);
  return events;
}

describe("AC-S3-2 thinking_delta 映射", () => {
  it("thinking 块 → thinking_delta,text 块 → text_delta,done 收尾", async () => {
    const streamFn = createStream(anthropicCfg, { transport: replayTransport(thinkingFixture) });
    const events = await drain(streamFn);

    const allowed = new Set([
      "start",
      "text_delta",
      "toolcall_delta",
      "done",
      "error",
      "thinking_delta",
    ]);
    for (const e of events) expect(allowed.has(e.type)).toBe(true);

    expect(events.at(0)?.type).toBe("start");
    const thinking = events.filter((e) => e.type === "thinking_delta");
    expect(thinking).toHaveLength(1);
    const first = thinking[0] as { delta: string } | undefined;
    expect(first).toBeDefined();
    expect(first!.delta).toBe("Let me think");

    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(text).toBe("Hi there");

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.stopReason).toBe("stop");
      expect(done.usage).toEqual({ prompt_tokens: 5, completion_tokens: 3 });
    }
  });

  it("toolcall 块 → toolcall_delta(done stopReason=tool_use,同 S1 协议)", async () => {
    const toolFixture = [
      `event: content_block_start`,
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_9","name":"echo","input":{}}}`,
      ``,
      `event: content_block_delta`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\""}}`,
      ``,
      `event: content_block_delta`,
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":":\\"/x\\",\\"limit\\":2}"}}`,
      ``,
      `event: content_block_stop`,
      `data: {"type":"content_block_stop","index":0}`,
      ``,
      `event: message_delta`,
      `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":4,"output_tokens":2}}`,
      ``,
      `event: message_stop`,
      `data: {"type":"message_stop"}`,
    ];
    const streamFn = createStream(anthropicCfg, { transport: replayTransport(toolFixture) });
    const events = await drain(streamFn);

    const tcd = events.filter((e) => e.type === "toolcall_delta") as {
      id: string;
      name: string;
      arguments: unknown;
    }[];
    expect(tcd.length).toBeGreaterThan(0);
    expect(tcd.at(-1)!.id).toBe("call_9");
    expect(tcd.at(-1)!.name).toBe("echo");
    expect(tcd.at(-1)!.arguments).toEqual({ path: "/x", limit: 2 });

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") expect(done.stopReason).toBe("tool_use");
  });
});

// AC-SEAM-2/3/4/9(PRD 审计②③④⑨): anthropic 线请求体 —— 序列化器 + system + tools + 双鉴权头。
// Scenario:context = systemPrompt + user + assistant(thinking+text+toolCall) + 两条连续 toolResult,
//         tools 含 echo 注册表项。
// Expected:messages 为 anthropic 块格式;连续 toolResult 并入同一 user(role 交替);thinking 丢弃;
//         body.system 存在;tools[].input_schema 映射;x-api-key 与 Authorization: Bearer 双头。
describe("AC-SEAM-2/3/4/9 anthropic 请求体", () => {
  it("内部格式 → anthropic 线格式 + system + tools + 双头", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const transport: Transport = async function* (url, init) {
      captured = { url, init };
      yield `data: {"type":"message_stop"}`;
    };
    process.env.ANTHROPIC_API_KEY = "test-key-xxx-not-real";
    try {
      const streamFn = createStream(anthropicCfg, { transport });
      for await (const _ of streamFn({
        systemPrompt: "SYS",
        messages: [
          { role: "user", content: "call echo" },
          {
            role: "assistant",
            content: [
              { type: "thinking", text: "hmm" },
              { type: "text", text: "doing" },
              { type: "toolCall", id: "c1", name: "echo", arguments: { path: "/a" } },
            ],
            stopReason: "tool_use",
          },
          {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "echo",
            content: [{ type: "text", text: "r1" }],
            isError: false,
          },
          {
            role: "toolResult",
            toolCallId: "c2",
            toolName: "echo",
            content: [{ type: "text", text: "r2" }],
            isError: true,
          },
        ],
        tools: [
          {
            name: "echo",
            description: "echo a path",
            schema: { type: "object", properties: { path: { type: "string" } } },
            // 方言只读声明不执行;假 run 兜底 = 误跑也只会回 error,不碰 fs。
            run: async () => ({ content: [], isError: true }),
          },
        ],
      }))
        void _;
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
    const body = JSON.parse(captured!.init.body as string);
    expect(body.system).toBe("SYS");
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "call echo" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "doing" },
          { type: "tool_use", id: "c1", name: "echo", input: { path: "/a" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: "r1", is_error: false },
          { type: "tool_result", tool_use_id: "c2", content: "r2", is_error: true },
        ],
      },
    ]);
    expect(body.tools).toEqual([
      {
        name: "echo",
        description: "echo a path",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key-xxx-not-real");
    expect(headers.Authorization).toBe("Bearer test-key-xxx-not-real");
  });

  it("systemPrompt/tools 缺省 → body 不含对应字段", async () => {
    let captured: RequestInit | null = null;
    const transport: Transport = async function* (_url, init) {
      captured = init;
      yield `data: {"type":"message_stop"}`;
    };
    const streamFn = createStream(anthropicCfg, { transport });
    for await (const _ of streamFn({ messages: [{ role: "user", content: "hi" }] })) void _;
    const body = JSON.parse(captured!.body as string);
    expect(body.system).toBeUndefined();
    expect(body.tools).toBeUndefined();
  });
});

// AC-S3-4: 加厂商只配置行
// Scenario:加 glm/kimi(同方言)厂商
// Action:仅加配置行
// Expected:适配器源文件 diff = 0
// Verification:vitest + git diff — 断言源文件 0 改动(行为:新配置走新 base_url)
describe("AC-S3-4 加厂商只配置行(anthropic 方言)", () => {
  it("新厂商配置 → transport 收新 base_url + 新 model,适配器源无改", async () => {
    const glmAnthropic: ProviderConfig = {
      dialect: "anthropic-messages",
      base_url: "https://glm.example/api",
      key_env: "GLM_API_KEY",
      models: [{ id: "glm-4", contextWindow: 128000 }],
    };
    let captured: { url: string; body: string } | null = null;
    const transport: Transport = async function* (url, init) {
      captured = { url, body: init.body as string };
      yield `data: {"type":"message_stop"}`;
    };
    process.env.GLM_API_KEY = "glm-test";
    try {
      const streamFn = createStream(glmAnthropic, { transport });
      for await (const _ of streamFn({ messages: [] })) void _;
    } finally {
      delete process.env.GLM_API_KEY;
    }
    expect(captured!.url).toBe("https://glm.example/api/messages");
    expect(JSON.parse(captured!.body).model).toBe("glm-4");
  });
});
