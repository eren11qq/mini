// D4(docs/ISSUES.md)task 子代理 = runLoop 递归包成普通 Tool(workflow-as-agent 图案,
// 源 PRD-V2 D4)。loop 对「子代理」零特判:child 也是一个 runLoop,tools = 只读白名单。
import { runLoop } from "../loop/run-loop.ts";
import type { AgentEvent, AgentMessage, ConfirmAnswer, LoopContext, Usage } from "../loop/types.ts";
import type { StreamFn } from "../stream/protocol.ts";
import { readTool } from "./read.ts";
import type { Tool, ToolResult } from "./tool.ts";

// 纯叶:child 的 confirm = headless-deny(卡 AC「deny 洞负例」的判据来源)。
// run-loop「缺 confirm = 放行」的洞不随 child 扩权限变越权面 —— child 恒有 confirm,
// 且凡走到弹面的(未 preapproved)一律拒;reason 走 loop 既有 `user rejected: <tool> — <reason>`
// 回喂文本,child 模型据此改方案。住家 = 本文件(卡「住 task.ts 或 loop 侧」→ D4 定此)。
export function confirmDeny(_prompt: string): ConfirmAnswer {
  return { kind: "no", reason: "sub-agent headless" };
}

export interface TaskToolDeps {
  streamFn: StreamFn;
  // 测试后门(deny 洞负例要往 child 塞假 bash):生产缺省 = 只读白名单。
  // "task" 恒被滤除 = 深度 1 硬编码,注入面也繁殖不出子-子(卡 AC「深度守卫」)。
  tools?: Tool[];
  maxTurns?: number; // 故事 21:child 独立更小保险丝,首版 20
  // child 事件上报缝(故事 23):事件已打 agentId,直连 cli 的 trace append —— 不进父
  // 事件流 ⇒ journal/TUI 天然零见 child = "child 不另建会话文件" 免费成立。
  onEvent?: (event: AgentEvent) => void;
}

// child 精简 systemPrompt = 任务说明 + read 工具清单(PRD-V2 D4 实现裁决)。不 import
// harness/system-prompt:方向锁(harness→tools 单向),且 child 本就不该看见父的工具全表。
const CHILD_SYSTEM_PROMPT = [
  "You are a read-only research sub-agent. Complete the assigned task using only the read tool,",
  "then reply with a concise final answer (conclusions + file:line evidence). Do not ask the",
  "user questions; you cannot write, edit, or run commands.",
  "Tools: read(path, offset?, limit?) — read a text file.",
].join(" ");

// AC-1:makeTaskTool 工厂 = streamFn/工具集/深度全靠 deps 注入,loop 侧零知子代理(故事 18)。
export function makeTaskTool(deps: TaskToolDeps): Tool {
  const childTools = (deps.tools ?? [readTool]).filter((t) => t.name !== "task");
  const maxTurns = deps.maxTurns ?? 20;
  let runSeq = 0; // 本实例内 child 计数;并行 N 个 task(D3 superstep)各拿独立 id,闭包 ++ 同步段无竞态
  return {
    name: "task",
    description:
      "Delegate a read-only research task to a sub-agent (only the read tool). " +
      "The sub-agent explores files and returns a concise final answer; its intermediate " +
      "reads do not enter your context. Input: prompt = a self-contained task description.",
    schema: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
      additionalProperties: false,
    },
    // 不声明 skipConfirm → task 本体在父侧过确认门(首版钱包保险)。也不声明 matchOf:
    // 默认 JSON.stringify(args) 精确匹配 = 换 prompt 必复弹,无家族豁免面。
    async run(args: unknown, signal?: AbortSignal): Promise<ToolResult> {
      const p = (args as { prompt?: unknown }).prompt;
      const prompt = typeof p === "string" ? p : "";
      const context: LoopContext = {
        systemPrompt: CHILD_SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
        tools: childTools,
      };
      // child 会话 = 内存独享:不另建 session 文件(故事 23);事件逐个打 agentId 走 onEvent
      // 旁挂(D2 trace 同源行形状,agent_end 载 usage 合计 = PRD 风险注「trace 必含」)。
      const agentId = `task-${++runSeq}`;
      let endReason: string | undefined;
      for await (const ev of runLoop(deps.streamFn, childTools, context, {
        confirm: confirmDeny,
        maxTurns,
        signal, // 故事 21:父 Ctrl+C 一并杀 child(透传,零新机制)
      })) {
        if (ev.type === "agent_end") {
          endReason = ev.reason;
          const usage = sumUsage(ev.messages);
          deps.onEvent?.({ ...ev, ...(usage && { usage }), agentId });
        } else {
          deps.onEvent?.({ ...ev, agentId });
        }
      }
      const lastAssistant = [...context.messages]
        .reverse()
        .find((m): m is Extract<typeof m, { role: "assistant" }> => m.role === "assistant");
      // abort 面(AC-6):父 Ctrl+C 杀到 child 中途 → 结论未形成,补 isError toolResult 走
      // 父批回填(配对不破,D3 AC-3b 同源机器)。
      if (endReason === "aborted") {
        return { content: [{ type: "text", text: "task aborted" }], isError: true };
      }
      // 失败面(卡「child error 行 → 父收 isError toolResult,父循环不断」):error 是 child
      // 侧终点,结论未形成,把 errorMessage 原文回喂父模型(父可改道/重派/自答)。
      if (endReason === "error") {
        return {
          content: [
            { type: "text", text: `task failed: ${lastAssistant?.errorMessage ?? "unknown"}` },
          ],
          isError: true,
        };
      }
      const text =
        lastAssistant?.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("") ?? "";
      return { content: [{ type: "text", text }], isError: false };
    },
  };
}

// child 各 turn usage 合计(纯函数;provider 静默无 usage 的轮跳过 = 全无则 undefined 零键,
// 与主代理行 diff-0 同款缺省语义)。
function sumUsage(messages: AgentMessage[]): Usage | undefined {
  let total: Usage | undefined;
  for (const m of messages) {
    if (m.role !== "assistant" || !m.usage) continue;
    total ??= { prompt_tokens: 0, completion_tokens: 0 };
    total.prompt_tokens += m.usage.prompt_tokens;
    total.completion_tokens += m.usage.completion_tokens;
  }
  return total;
}
