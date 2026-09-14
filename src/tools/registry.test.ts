import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLoop } from "../loop/run-loop.js";
import type {
  AgentEvent,
  LoopContext,
  ProviderEvent,
  StreamFn,
  ToolResultMessage,
} from "../loop/types.js";
import { readTool } from "./read.js";

// T1 seam 2:注册表分发 = runLoop(streamFn, [readTool], ctx, opts) 公共入口。
// AC-T1-2/3 的 read 经 toolCall 走通整链;AC-T1-4(T1 可测部分):无任何确认 gate,
// 直接执行并回填(beforeToolCall hook 归 T2,届时 read 须恒放行)。

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mini-registry-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function collect(gen: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe("T1 注册表分发:toolCall→read→toolResult 整链", () => {
  it("假流吐 toolCall read{offset:10,limit:5} → 回填恰第 10–14 行、id/name 配对、直接执行", async () => {
    const path = join(dir, "f100.txt");
    await writeFile(path, Array.from({ length: 100 }, (_, i) => `L${i + 1}`).join("\n"));

    // 第 1 圈吐 toolCall(交 loop 分发),第 2 圈纯文本(停)。
    const turn1: AsyncIterable<ProviderEvent> = (async function* () {
      yield { type: "start" };
      yield {
        type: "toolcall_delta",
        id: "c1",
        name: "read",
        arguments: { path, offset: 10, limit: 5 },
      };
      yield { type: "done", stopReason: "tool_use" };
    })();
    const turn2: AsyncIterable<ProviderEvent> = (async function* () {
      yield { type: "start" };
      yield { type: "text_delta", delta: "done" };
      yield { type: "done", stopReason: "stop" };
    })();
    let turn = 0;
    const streamFn: StreamFn = () => (++turn === 1 ? turn1 : turn2);

    const context: LoopContext = { messages: [{ role: "user", content: "read f100" }] };
    const events = await collect(runLoop(streamFn, [readTool], context, {}));

    // 分发事件对:start→end,end 载成功 result(= read 直接执行,无确认挂起)
    const start = events.find((e) => e.type === "tool_execution_start");
    const end = events.find((e) => e.type === "tool_execution_end");
    expect(start?.type).toBe("tool_execution_start");
    expect(end?.type).toBe("tool_execution_end");
    if (start?.type !== "tool_execution_start" || end?.type !== "tool_execution_end") return;
    expect([start.toolCallId, start.toolName]).toEqual(["c1", "read"]);
    expect([end.toolCallId, end.isError]).toEqual(["c1", false]);

    // 回填 messages:role=toolResult,toolCallId/toolName 配对,content 恰 10–14 行带行号
    const toolMsg = context.messages.find((m): m is ToolResultMessage => m.role === "toolResult");
    expect(toolMsg).toBeDefined();
    expect([toolMsg?.toolCallId, toolMsg?.toolName, toolMsg?.isError]).toEqual([
      "c1",
      "read",
      false,
    ]);
    expect(toolMsg?.content.map((b) => b.text).join("")).toBe(
      ["10\tL10", "11\tL11", "12\tL12", "13\tL13", "14\tL14"].join("\n"),
    );
  });
});
