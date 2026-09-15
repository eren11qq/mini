import { describe, expect, it } from "vitest";
import type {
  AgentMessage,
  LoopContext,
  ProviderEvent,
  StreamFn,
  UserMessage,
} from "../loop/types.ts";
import { makeSummarizeFn } from "./compaction.ts";

// 卡 3(ADR-004)锚点直测:「什么构成纪要」的配方从 harness 下沉 memory 缝。此前这段知识撕在
// cli.ts(拼接 + 流排空 + error 抛)、summarize-prompt.ts(七段规格)、serialize.ts(正文格式)
// 三处,而 cli.ts 是仓库唯一无自动测试的文件(CI 不可见)。
// 注入 llm = StreamFn 形状 → 假流零网络(S4 教条)。期望值 = 独立手写字面量(七段规格 = M4/PRD #28),
// 不调用被测实现算期望。

function fakeLlm(events: ProviderEvent[]): { llm: StreamFn; seen: LoopContext[] } {
  const seen: LoopContext[] = [];
  const llm: StreamFn = (context) => {
    seen.push(context);
    return (async function* () {
      for (const e of events) yield e;
    })();
  };
  return { llm, seen };
}

const OK_DONE: ProviderEvent[] = [{ type: "done", stopReason: "stop" }];

describe("makeSummarizeFn:配方拼接(下沉自 cli.ts summarizeFn)", () => {
  it("首轮(无旧纪要):llm 收到单条 user 消息 = 七段指令 + 空行 + 序列化正文,tools 为空", async () => {
    const old: AgentMessage[] = [
      { role: "user", content: "你好" },
      { role: "assistant", content: [{ type: "text", text: "嗨" }], stopReason: "stop" },
    ];
    const { llm, seen } = fakeLlm(OK_DONE);
    await makeSummarizeFn(llm)(old);

    const TASK =
      "请把下面的对话历史压缩成一份中文纪要,严格使用以下七段格式(标题原样保留,内容用中文):";
    const SECTIONS = ["目的", "做到哪了", "关键要点", "引用文件", "关键决定", "下一步", "关键背景"];
    const expected = [
      TASK,
      ...SECTIONS.map((s) => `## ${s}`),
      "",
      "[user] 你好",
      "[assistant] 嗨",
    ].join("\n");

    expect(seen).toHaveLength(1);
    expect(seen[0]!.messages).toEqual([{ role: "user", content: expected }]);
    expect(seen[0]!.tools).toEqual([]);
  });

  it("排空:多个 text_delta 拼成完整纪要;thinking/toolcall/agent done 不进气泡", async () => {
    const { llm } = fakeLlm([
      { type: "start" },
      { type: "thinking_delta", delta: "内部推理不该进纪要" },
      { type: "text_delta", delta: "## 目的\n" },
      { type: "toolcall_delta", id: "t1", name: "read", arguments: { path: "a" } },
      { type: "text_delta", delta: "读文件" },
      { type: "done", stopReason: "stop" },
    ]);
    await expect(makeSummarizeFn(llm)([{ role: "user", content: "hi" }])).resolves.toBe(
      "## 目的\n读文件",
    );
  });

  it("error 事件 → 抛 errorMessage(半截纪要不静默当成功)", async () => {
    const { llm } = fakeLlm([
      { type: "text_delta", delta: "半截纪要" },
      { type: "error", stopReason: "error", errorMessage: "上游 500" },
    ]);
    await expect(makeSummarizeFn(llm)([{ role: "user", content: "hi" }])).rejects.toThrow(
      "上游 500",
    );

    // 无 errorMessage 的 error 事件 → 兜底串(照原 cli 口径)。
    const bare = fakeLlm([{ type: "error", stopReason: "aborted" }]);
    await expect(makeSummarizeFn(bare.llm)([{ role: "user", content: "hi" }])).rejects.toThrow(
      "summarize 流错误",
    );
  });

  it("二次压缩:旧纪要进 <previous_summary> 段 + UPDATE 增量合并指令,且排在正文之前", async () => {
    const { llm, seen } = fakeLlm(OK_DONE);
    await makeSummarizeFn(llm)([{ role: "user", content: "再一轮" }], "旧纪要");

    const prompt = (seen[0]!.messages[0] as UserMessage).content;
    expect(prompt).toContain("增量合并");
    expect(prompt).toContain("<previous_summary>\n旧纪要\n</previous_summary>");
    expect(prompt.indexOf("<previous_summary>")).toBeLessThan(prompt.indexOf("[user] 再一轮"));
  });
});
