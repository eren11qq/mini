// H1 renderer 缝(唯一自动测试缝;DECISIONS W2 harness 其余纯人工)。
// 契约:runLoop 每个 text_delta 都 yield 一条 message_update,载的是累积快照
// (run-loop.ts:73-76)。故 renderer 必须自己算后缀 —— 重打 = AC-H1-2「非整块」违。
import { describe, expect, it } from "vitest";
import { createRenderer } from "./renderer.ts";
import type { AssistantMessage, ContentBlock, StopReason } from "../loop/types.ts";

function msg(content: ContentBlock[], stopReason: StopReason = "stop"): AssistantMessage {
  return { role: "assistant", content, stopReason };
}

describe("AC-H1-2 文本流式", () => {
  it("message_update 快照只打新增后缀,全文一遍", () => {
    const out: string[] = [];
    const render = createRenderer((s) => out.push(s));

    render({ type: "agent_start" });
    render({ type: "turn_start" });
    render({ type: "message_start", message: msg([]) });
    render({ type: "message_update", message: msg([{ type: "text", text: "Hel" }]) });
    render({ type: "message_update", message: msg([{ type: "text", text: "Hello world" }]) });
    render({ type: "message_end", message: msg([{ type: "text", text: "Hello world" }]) });

    // 期望 = 全文一次 + 收尾换行(提示符不粘连)。已打前缀 "Hel" 不得重出现。
    expect(out.join("")).toBe("Hello world\n");
  });

  it("thinking 段被 dim 包裹,正文不被包裹", () => {
    const out: string[] = [];
    const render = createRenderer((s) => out.push(s));
    const full = [
      { type: "thinking", text: "Thi" },
      { type: "text", text: "Hi" },
    ] as ContentBlock[];

    render({ type: "message_start", message: msg([]) });
    render({ type: "message_update", message: msg([{ type: "thinking", text: "Th" }]) });
    render({ type: "message_update", message: msg(full) });
    render({ type: "message_end", message: msg(full) });

    // 进 thinking 开一次 dim,离开关一次;正文与换行在 dim 外。
    expect(out.join("")).toBe("\x1b[2mThi\x1b[22mHi\n");
  });

  it("error 圈有可见提示(不静默)", () => {
    const out: string[] = [];
    const render = createRenderer((s) => out.push(s));
    const bad: AssistantMessage = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "401 unauthorized",
    };

    render({ type: "message_start", message: msg([]) });
    render({ type: "message_end", message: bad });

    // AC-L3-2 的 error 编进 message_end;renderer 不印 = 用户只看空屏。
    expect(out.join("")).toBe("[error] 401 unauthorized\n");
  });

  it("Ctrl+C abort 有可见提示(已打正文不重复,只补一行)", () => {
    const out: string[] = [];
    const render = createRenderer((s) => out.push(s));
    const half: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "part" }],
      stopReason: "aborted",
    };

    render({ type: "message_start", message: msg([]) });
    render({ type: "message_update", message: msg([{ type: "text", text: "part" }]) });
    render({ type: "message_end", message: half });

    // AC-L3-4/L3-6:abort 编进 stopReason="aborted"。半截正文保留 + 明示中断。
    expect(out.join("")).toBe("part\n[aborted]\n");
  });
});
