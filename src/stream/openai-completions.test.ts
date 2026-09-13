import { describe, it, expect } from "vitest";
import { createStream } from "./openai-completions.js";
import type { ProviderConfig, ProviderEvent, Transport } from "../loop/types.js";

// AC-S1-2:协议映射
// Scenario:录制一段 deepseek 真实 SSE(脱敏存 fixture)
// Action:stream(config, context) 喂 fixture(经假 transport)
// Expected:输出 ProviderEvent 序列仅含 start/text_delta/toolcall_delta/done/error;
//         字段与协议契约一致

const deepseekConfig: ProviderConfig = {
  dialect: "openai-completions",
  base_url: "https://api.deepseek.example/v1",
  key_env: "DEEPSEEK_API_KEY",
  models: [{ id: "deepseek-chat", contextWindow: 64000 }],
};

// 脱敏合成 SSE:纯文本 + usage 收尾,无真实密钥。
const textFixture = [
  `data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}`,
  `data: {"id":"c1","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}`,
  `data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}`,
  `data: [DONE]`,
];

function replayTransport(lines: string[]): Transport {
  return async function* () {
    for (const line of lines) yield line;
  };
}

describe("AC-S1-2 协议映射", () => {
  it("纯文本 fixture → start/text_delta*/done,类型 ⊆ 契约六类", async () => {
    const streamFn = createStream(deepseekConfig, {
      transport: replayTransport(textFixture),
    });
    const events: ProviderEvent[] = [];
    for await (const ev of streamFn({ messages: [] })) {
      events.push(ev);
    }

    const types = events.map((e) => e.type);
    const allowed = new Set([
      "start",
      "text_delta",
      "toolcall_delta",
      "done",
      "error",
      "thinking_delta",
    ]);
    for (const t of types) expect(allowed.has(t)).toBe(true);

    expect(types[0]).toBe("start");
    expect(types.filter((t) => t === "text_delta")).toHaveLength(2);
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.stopReason).toBe("stop");
    }
  });

  it("text_delta 负载按 fixture 顺序拼接还原全文", async () => {
    const streamFn = createStream(deepseekConfig, {
      transport: replayTransport(textFixture),
    });
    const events: ProviderEvent[] = [];
    for await (const ev of streamFn({ messages: [] })) events.push(ev);

    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(text).toBe("Hello world");
  });
});

// AC-S1-3:usage 记录
// Scenario:fixture 含 usage:{prompt_tokens,completion_tokens}
// Action:stream
// Expected:done 事件 payload 含 usage,prompt+completion token 数 = fixture 值
describe("AC-S1-3 usage 记录", () => {
  it("done.usage 两数与 fixture 对齐", async () => {
    const streamFn = createStream(deepseekConfig, {
      transport: replayTransport(textFixture),
    });
    const events: ProviderEvent[] = [];
    for await (const ev of streamFn({ messages: [] })) events.push(ev);

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 2,
      });
    }
  });

  it("fixture 无 usage → done.usage 缺省不抛", async () => {
    const noUsage = [
      `data: {"choices":[{"index":0,"delta":{"content":"x"},"finish_reason":null}]}`,
      `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
      `data: [DONE]`,
    ];
    const streamFn = createStream(deepseekConfig, {
      transport: replayTransport(noUsage),
    });
    const events: ProviderEvent[] = [];
    for await (const ev of streamFn({ messages: [] })) events.push(ev);
    const done = events.at(-1);
    expect(done?.type).toBe("done");
  });
});

// AC-S1-4:密钥只 env
// Scenario:config.key_env="DEEPSEEK_API_KEY"
// Action:stream
// Expected:从 process.env 读取;不在 config/仓库文件留密钥值
// Must not:任何源文件或 fixture 含真实密钥(grep sk-/DEEPSEEK_API_KEY= 赋值零命中)
describe("AC-S1-4 密钥只 env", () => {
  it("密钥从 process.env 读,transport 收到 Bearer 头", async () => {
    const key = "test-key-xxx-not-real";
    process.env.DEEPSEEK_API_KEY = key;
    let captured: { url: string; init: RequestInit } | null = null;
    const transport: Transport = async function* (url, init) {
      captured = { url, init };
      yield `data: [DONE]`;
    };
    try {
      const streamFn = createStream(deepseekConfig, { transport });
      for await (const _ of streamFn({ messages: [] })) {
        void _;
      }
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
    }
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${key}`);
  });

  it("key_env 缺省 → 空串不抛(密钥不入仓库)", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    let captured: RequestInit | null = null;
    const transport: Transport = async function* (_url, init) {
      captured = init;
      yield `data: [DONE]`;
    };
    const streamFn = createStream(deepseekConfig, { transport });
    for await (const _ of streamFn({ messages: [] })) {
      void _;
    }
    const headers = captured!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ");
  });
});

// AC-S1-5:厂商配置行换厂商
// Scenario:新增 glm 配置行(base_url+model+key_env)
// Action:仅改配置
// Expected:stream 走新 base_url;适配器代码无改动
describe("AC-S1-5 厂商配置行换厂商", () => {
  it("glm 配置 → transport 收到新 base_url + 新 model", async () => {
    const glmConfig: ProviderConfig = {
      dialect: "openai-completions",
      base_url: "https://open.bigmodel.example/api/paas/v4",
      key_env: "GLM_API_KEY",
      models: [{ id: "glm-4-flash", contextWindow: 128000 }],
    };
    let captured: { url: string; init: RequestInit } | null = null;
    const transport: Transport = async function* (url, init) {
      captured = { url, init };
      yield `data: [DONE]`;
    };
    process.env.GLM_API_KEY = "glm-test";
    try {
      const streamFn = createStream(glmConfig, { transport });
      for await (const _ of streamFn({ messages: [] })) {
        void _;
      }
    } finally {
      delete process.env.GLM_API_KEY;
    }
    expect(captured!.url).toBe("https://open.bigmodel.example/api/paas/v4/chat/completions");
    const body = JSON.parse(captured!.init.body as string);
    expect(body.model).toBe("glm-4-flash");
  });
});

// AC-S1-6:salvage 尽力解析
// Scenario:fixture 的 toolcall 参数分多 delta,中途前缀不完整
// Action:stream
// Expected:toolcall_delta 实时流出已可解析前缀(UI 不空白)
//         中途 toolcall_delta payload 非空
const toolFixture = [
  `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"echo","arguments":""}}]}}]}`,
  `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\""}}]}}]}`,
  `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"/a/b\\""}}]}}]}`,
  `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":",\\"limit\\":5}"}}]}}]}`,
  `data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":3}}`,
  `data: [DONE]`,
];

describe("AC-S1-6 salvage 尽力解析", () => {
  it("中途 toolcall_delta.arguments 非空(已解析前缀)", async () => {
    const streamFn = createStream(deepseekConfig, {
      transport: replayTransport(toolFixture),
    });
    const events: ProviderEvent[] = [];
    for await (const ev of streamFn({ messages: [] })) events.push(ev);

    const tcDeltas = events.filter((e) => e.type === "toolcall_delta");
    expect(tcDeltas.length).toBeGreaterThan(0);
    for (const ev of tcDeltas) {
      const args = (ev as { arguments: unknown }).arguments;
      expect(args).toBeTruthy();
      // 已解析为对象(前缀)
      expect(typeof args).toBe("object");
      expect(Object.keys(args as object).length).toBeGreaterThan(0);
    }
  });

  it("定稿合法 → done stopReason=tool_use + 最终 arguments 完整", async () => {
    const streamFn = createStream(deepseekConfig, {
      transport: replayTransport(toolFixture),
    });
    const events: ProviderEvent[] = [];
    for await (const ev of streamFn({ messages: [] })) events.push(ev);

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") expect(done.stopReason).toBe("tool_use");

    const last = events.filter((e) => e.type === "toolcall_delta").at(-1) as
      { id: string; name: string; arguments: unknown } | undefined;
    expect(last?.id).toBe("call_1");
    expect(last?.name).toBe("echo");
    expect(last?.arguments).toEqual({ path: "/a/b", limit: 5 });
  });
});

// AC-S4-2 前置:tools 序列化进请求体
// Scenario:context.tools 含工具(name/description/parameters schema)
// Action:stream 经假 transport 回放,捕获 init.body
// Expected:body.tools 为 openai function-tool 数组,透传 name/description/parameters
//         context.tools 缺省 → body 不含 tools 字段(不发空数组)
describe("AC-S4-2 前置 tools 序列化进请求体", () => {
  it("context.tools → body.tools[] openai function 格式,透传 schema", async () => {
    let captured: RequestInit | null = null;
    const transport: Transport = async function* (_url, init) {
      captured = init;
      yield `data: [DONE]`;
    };
    const streamFn = createStream(deepseekConfig, { transport });
    const tools = [
      {
        name: "echo",
        description: "echo a path",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ];
    for await (const _ of streamFn({
      messages: [{ role: "user", content: "call echo" }],
      tools,
    })) {
      void _;
    }
    const body = JSON.parse(captured!.body as string);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "echo",
        description: "echo a path",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    });
  });

  it("context.tools 缺省 → body 不含 tools 字段", async () => {
    let captured: RequestInit | null = null;
    const transport: Transport = async function* (_url, init) {
      captured = init;
      yield `data: [DONE]`;
    };
    const streamFn = createStream(deepseekConfig, { transport });
    for await (const _ of streamFn({ messages: [] })) void _;
    const body = JSON.parse(captured!.body as string);
    expect(body.tools).toBeUndefined();
  });
});

// AC-S1-7:salvage 定稿截断整批拒执
// Scenario:fixture toolcall 定稿时参数 JSON 截断不可解析
// Action:stream
// Expected:流出 error 事件(标该 toolCall 拒执);不产合法 toolcall_delta done
// Must not:循环崩;拒执后 runLoop 仍返回
const truncatedFixture = [
  `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_2","type":"function","function":{"name":"echo","arguments":""}}]}}]}`,
  `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"/a/b\\",\\"limit\\""}}]}}]}`,
  `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":5"}}]}}]}`,
  // 定稿:argString = {"path":"/a/b","limit":5  ← 截断,无闭合 }
  `data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
  `data: [DONE]`,
];

describe("AC-S1-7 定稿截断整批拒执", () => {
  it("截断 → 流 error 事件且无 done(stopReason=tool_use)", async () => {
    const streamFn = createStream(deepseekConfig, {
      transport: replayTransport(truncatedFixture),
    });
    const events: ProviderEvent[] = [];
    for await (const ev of streamFn({ messages: [] })) events.push(ev);

    const err = events.find((e) => e.type === "error");
    expect(err).toBeDefined();
    expect(events.at(-1)?.type).toBe("error");
    expect(events.some((e) => e.type === "done")).toBe(false);
  });
});
