import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  LoopContext,
  RunLoopOptions,
  ToolResultMessage,
} from "./types.ts";
import type { TextBlock, ThinkingBlock, ToolCallBlock } from "../blocks.ts";
import type { Tool, ToolResult } from "../tools/tool.ts";
import type { StreamFn } from "../stream/protocol.ts";
import { isAbsolute } from "node:path";
import { validateArgs } from "./validate.ts";
import { bashParse, seedOf } from "./bash-parse.ts";
import { dangerOfPath, dangerOfShell } from "./danger.ts";
import { readOnlyParsed } from "./readonly.ts";
import { appendRule, isValidSeed, loadRules, ruleMatches, type Rule } from "./rules.ts";

// mini runLoop:L2。toolCall 执行(D3 同批两段式:A 弹检串行 / B 并发 / 调用序回填)+ toolResult 回填 + maxTurns 保险丝。
// 双层 while 形状照抄 pi(steering/followUp 队列不挂 → 外层由停止条件退)。
// loop 层零 try/catch:工具失败靠 run 返回 isError:true ToolResult 回喂(L3 error 进流同约束)。
// confirm gate 留 T2(beforeToolCall hook),L2 工具直接执行。
export async function* runLoop(
  streamFn: StreamFn,
  tools: Tool[],
  context: LoopContext,
  options: RunLoopOptions,
): AsyncGenerator<AgentEvent> {
  // PRD:maxTurns=50 唯一故意偏离(保险丝)。可配,缺省 50。
  const maxTurns = options.maxTurns ?? 50;
  const signal = options.signal;
  const newMessages: AgentMessage[] = [];
  // T2-7:rules 每次 agent run 开头读一遍(手删文件 = 下次 run 重新弹,撤销正路)。
  const rulesPath = options.rulesPath;
  let rules: Rule[] = rulesPath ? await loadRules(rulesPath) : [];
  // C5:黑名单"重定向出 cwd"与 pathInput 规范化同基准(进程 cwd,run 内不变)。
  const cwd = process.cwd();

  yield { type: "agent_start" };

  let turnCount = 0;
  while (true) {
    // maxTurns 保险丝:已达上限 → 强制停并告知(AC-L2-4/L2-5)。
    if (turnCount >= maxTurns) {
      yield { type: "agent_end", messages: newMessages, reason: "maxTurns" };
      return;
    }
    turnCount += 1;
    yield { type: "turn_start" };

    // ---- stream 一轮 assistant response ----
    const partial: AssistantMessage = {
      role: "assistant",
      content: [],
      stopReason: "stop",
    };
    let pushed = false;
    let messageEnded = false;

    // Story 16:signal 传进 streamFn → 真 adapter 透传 transport→fetch(流可中断)。
    for await (const event of streamFn(context, signal)) {
      // AC-L3-4:外部 abort 缝内查。命中 → 该 turn 立即停。
      if (signal?.aborted) {
        partial.stopReason = "aborted";
        if (pushed) context.messages[context.messages.length - 1] = partial;
        yield { type: "message_end", message: snapshot(partial) };
        messageEnded = true;
        break;
      }
      switch (event.type) {
        case "start": {
          pushed = true;
          context.messages.push(partial);
          yield { type: "message_start", message: snapshot(partial) };
          break;
        }
        case "text_delta": {
          appendText(partial, event.delta);
          if (pushed) context.messages[context.messages.length - 1] = partial;
          yield { type: "message_update", message: snapshot(partial) };
          break;
        }
        case "toolcall_delta": {
          applyToolCallDelta(partial, event);
          if (pushed) context.messages[context.messages.length - 1] = partial;
          yield { type: "message_update", message: snapshot(partial) };
          break;
        }
        case "done": {
          partial.stopReason = event.stopReason;
          // Story 9 / AC-S1-3:usage 透传落 AssistantMessage.usage(M3 压缩阈值数据源)。
          if (event.usage) partial.usage = event.usage;
          if (pushed) context.messages[context.messages.length - 1] = partial;
          yield { type: "message_end", message: snapshot(partial) };
          messageEnded = true;
          break;
        }
        case "error": {
          // AC-L3-2:provider error 编码进流,loop 不 throw。
          // 落 partial.stopReason/errorMessage → emit message_end → break →
          // 停止条件①判 stopReason 非 tool_use → turn_end + agent_end(reason)。
          partial.stopReason = event.stopReason;
          partial.errorMessage = event.errorMessage;
          if (!pushed) {
            context.messages.push(partial);
            pushed = true;
            yield { type: "message_start", message: snapshot(partial) };
          } else {
            context.messages[context.messages.length - 1] = partial;
          }
          yield { type: "message_end", message: snapshot(partial) };
          messageEnded = true;
          break;
        }
        case "thinking_delta": {
          // H1"thinking 淡显"来源:累积进 ThinkingBlock(同 text_delta 快照协议)。
          // 序列化回 provider 时 thinking 块会被方言适配器丢弃(不可回传),仅 UI 用。
          appendThinking(partial, event.delta);
          if (pushed) context.messages[context.messages.length - 1] = partial;
          yield { type: "message_update", message: snapshot(partial) };
          break;
        }
        default:
          break;
      }
      if (event.type === "done" || event.type === "error") break;
    }

    // AC-L3-4:stream 因 abort 自然结束(未发 done/error)→ 缝内查兜底。
    if (signal?.aborted && !messageEnded) {
      partial.stopReason = "aborted";
      if (pushed) context.messages[context.messages.length - 1] = partial;
      yield { type: "message_end", message: snapshot(partial) };
      messageEnded = true;
    }

    newMessages.push(partial);

    // 停止条件①:无 toolCall(stopReason 非 tool_use)→ 自然停(L1 行为)。
    // error/aborted 在此停:agent_end 带 reason(AC-L3-2 / AC-L3-6)。
    if (partial.stopReason !== "tool_use") {
      yield { type: "turn_end", message: partial, toolResults: [] };
      const reason =
        partial.stopReason === "error" || partial.stopReason === "aborted"
          ? partial.stopReason
          : undefined;
      yield {
        type: "agent_end",
        messages: newMessages,
        ...(reason !== undefined && { reason }),
      };
      return;
    }

    // ---- D3(docs/ISSUES.md)同批 toolCall 两段式:A 段逐 call 串行过门(零事件,弹窗照旧
    // 一次一个),收集过门 run 闭包;B 段前按调用序统一发 tool_execution_start,并发执行,
    // end 与回填按调用序(与完成序无关)。AC-L2-3 原「同批串行」钉被 D3 翻案;
    // 单 call 批事件序与旧逐字节同(锚 = AC-L2-2 零改)。----
    // AC-L3-4:abort 在 tool 批前命中 → 不执行工具,该 turn 停。
    if (signal?.aborted) {
      partial.stopReason = "aborted";
      if (pushed) context.messages[context.messages.length - 1] = partial;
      yield { type: "turn_end", message: partial, toolResults: [] };
      yield { type: "agent_end", messages: newMessages, reason: "aborted" };
      return;
    }
    const toolCalls = partial.content.filter((b): b is ToolCallBlock => b.type === "toolCall");
    const pendings: { call: ToolCallBlock; run: () => Promise<ToolResult> }[] = [];
    for (const call of toolCalls) {
      const tool = tools.find((t) => t.name === call.name);
      // 工具不在注册表 → error result 回喂(不断循环)。tool.run 契约不 throw。
      // AC-T2-4:schema 在 run 前校验(照 pi prepare→validate),失败 → error result,不执行 run。
      // Story 16 / T4:signal 透传给 run,bash 工具据此超时/中断杀进程树。
      if (!tool) {
        pendings.push({
          call,
          run: () =>
            Promise.resolve({
              content: [{ type: "text", text: `tool not found: ${call.name}` }],
              isError: true,
            }),
        });
        continue;
      }
      {
        // 顺序照 pi prepare→validate→beforeToolCall:先挡无效 args,再费用户一次确认。
        const vErr = tool.schema ? validateArgs(tool.schema, call.arguments) : null;
        if (vErr !== null) {
          pendings.push({
            call,
            run: () => Promise.resolve({ content: [{ type: "text", text: vErr }], isError: true }),
          });
          continue;
        }
        // AC-T2-5/6/7/8 beforeToolCall 确认门(逻辑在 loop,story 24;confirm 缺省 = 放行,
        // PRD「深度判据」confirm 条)。AC-T2-7+C2:命中 rules(ruleMatches:token 家族/path glob/相等,
        // 判据输入 = matchOf 完整事实)免弹;always 落盘 prefixOf 种子,
        // `*`/空种子拒写(AC-T2-8 无一键全允许)退化为一次性 yes。
        // C3:matchKind="shell" → bashParse 拆段逐段过检,任一段不命中即弹(展示完整原命令);
        // 解析失败(未闭合引号等)= ok:false 必弹,安全侧兜底。always 逐段落盘(每段一条,
        // 种子 = 前 2 token 家族,建议粒度见 bash-parse.seedOf);无效段种子静默跳过。
        const input = tool.matchOf?.(call.arguments) ?? JSON.stringify(call.arguments);
        const seed = tool.prefixOf?.(call.arguments) ?? input;
        const parsed = tool.matchKind === "shell" ? bashParse(input) : null;
        // C5(docs/ISSUES.md):危险黑名单先于一切 allow —— 命中必弹(规则/只读表/session/
        // 模式开关不可豁免;工具分级 skipConfirm 按分层顺序居黑名单之前,不受影响),
        // 弹头带 "⚠ 原因 —",always 亦不落盘(黑名单永远赢,写规则只误导)。
        // shell 查「整条+每段」两形态、path 查 `path:` 域,判定全在 danger 纯叶。
        const danger =
          tool.matchKind === "shell"
            ? dangerOfShell(input, cwd)
            : tool.matchKind === "path"
              ? dangerOfPath(input)
              : null;
        // C6 AC-1:session 档与持久规则同匹配器、同短路点 —— 唯一差别是不落盘,
        // 故判据输入 = rules ∪ sessionRules(黑名单 danger 仍在最外层压制,两者皆不可豁免)。
        const known = options.sessionRules ? rules.concat(options.sessionRules) : rules;
        const preapproved =
          danger === null &&
          (parsed === null
            ? known.some((r) => r.tool === tool.name && ruleMatches(r, input))
            : parsed.ok &&
              parsed.segments.length > 0 &&
              parsed.segments.every((seg) =>
                known.some((r) => r.tool === tool.name && ruleMatches(r, seg.text)),
              ));
        // C4(docs/ISSUES.md):内置只读白名单 —— 只读 shell 段整体免弹,且不产生规则
        // (不进 writable、不落盘)。与 preapproved 等价短路,判据取自 loop 侧数据表
        // (与 rules.json 无关);parsed!==null 恒意味 matchKind==="shell",非 shell 工具不受
        // 影响(AC-4);danger 黑名单仍在最外层前置压制。
        const readOnly = danger === null && parsed !== null && readOnlyParsed(parsed);
        // C7(docs/ISSUES.md):--auto-accept-edits —— matchKind:"path" 且种子为 cwd 内
        // 相对 `path:`(cwd 外 = `*`/绝对,已被上一行 danger 与 C1 拒粘拦住)直通免弹。
        // bash 不适用;flag 缺省 = 恒 false = 现行为零变化。
        const autoAccepted =
          options.autoAcceptEdits === true &&
          tool.matchKind === "path" &&
          danger === null &&
          seed.startsWith("path:") &&
          !isAbsolute(seed.slice(5));
        // C6 AC-2:建议规则集 = 弹面与落盘面的唯一来源(绝不两套字符串)。
        // shell = 每段一条(seedOf);非 shell = 一条 prefixOf 种子;无效种子(`*`/空)与
        // 解析失败(未闭合引号)不入面 → 打印数恒等于落盘数(AC-4)。
        const writable: Rule[] = (
          parsed !== null && parsed.ok
            ? parsed.segments.map((seg) => ({ tool: tool.name, prefix: seedOf(seg) }))
            : parsed === null
              ? [{ tool: tool.name, prefix: seed }]
              : []
        ).filter((r) => isValidSeed(r.prefix));
        if (tool.skipConfirm || !options.confirm || preapproved || readOnly || autoAccepted) {
          pendings.push({ call, run: () => tool.run(call.arguments, signal) });
        } else {
          // 三行弹面:原因+命令 / 四档键位 / 将落盘规则(黑名单命中 = 无第三行,always 亦不落盘)。
          const ruleLines =
            danger !== null || writable.length === 0
              ? []
              : writable.length === 1
                ? [`  3 将落盘 1 条规则: ${writable.map(fmtRule).join(" / ")}`]
                : [
                    `  3 将落盘 ${writable.length} 条规则:`,
                    ...writable.map((r) => `    ${fmtRule(r)}`),
                  ];
          const answer = await options.confirm(
            [
              `${danger ? `⚠ ${danger} — ` : ""}Execute: ${tool.name}(${JSON.stringify(call.arguments)})?`,
              "❯ 1 Yes (once)  2 Yes + session  3 Yes + always  4 No",
              ...ruleLines,
            ].join("\n"),
          );
          if (answer.kind === "no") {
            // C6 AC-3:理由原文随拒因回喂(模型据此改方案重试;无理由 = 与旧文本逐字等价)。
            pendings.push({
              call,
              run: () =>
                Promise.resolve({
                  content: [
                    {
                      type: "text",
                      text: answer.reason
                        ? `user rejected: ${tool.name} — ${answer.reason}`
                        : `user rejected: ${tool.name}`,
                    },
                  ],
                  isError: true,
                }),
            });
          } else {
            // D3:副作用紧随应答在 A 段发生(规则对同批后 call 可见序 = 旧序),run 交 B 段闭包。
            // C5:黑名单命中时 always 不落盘(答了也白写,下次仍弹 = 只误导)。
            if (answer.kind === "always" && rulesPath && danger === null) {
              for (const r of writable) {
                rules = await appendRule(rulesPath, r);
              }
            }
            // C6 AC-1:session = 同一份建议集进内存数组,永不写盘(新进程复弹)。
            if (answer.kind === "session" && options.sessionRules && danger === null) {
              options.sessionRules.push(...writable);
            }
            pendings.push({ call, run: () => tool.run(call.arguments, signal) });
          }
        }
      }
    }
    // D3 AC-3a:A→B 复查 abort(弹窗 await 是 A 段唯一可落缝的 abort 点)。命中 = 零 tool
    // 事件、批前已收集的应答作废,整批走 AC-L3-4 既有路径(形状逐字节同;悬空配对由 D1 补)。
    if (signal?.aborted) {
      partial.stopReason = "aborted";
      if (pushed) context.messages[context.messages.length - 1] = partial;
      yield { type: "turn_end", message: partial, toolResults: [] };
      yield { type: "agent_end", messages: newMessages, reason: "aborted" };
      return;
    }
    // ---- B 段:start 按调用序统一发 → 并发执行 → end/回填按调用序(end 事件与
    // messages/toolResults 皆与完成序无关,toolCallId 配对不破)。----
    for (const { call } of pendings) {
      yield {
        type: "tool_execution_start",
        toolCallId: call.id,
        toolName: call.name,
        args: call.arguments,
      };
    }
    // D3 AC-3b:allSettled 兜 run 死面(契约不 throw,但 abort 杀进程等可致 reject)→
    // 缺位合成 isError 补全,配对不破(悬空 toolCall = toWire 400,同 D1 病根)。文本卡钉 "aborted"。
    const settled = await Promise.allSettled(pendings.map((p) => p.run()));
    const toolResults: ToolResultMessage[] = [];
    let anyTerminate = false;
    for (const [i, outcome] of settled.entries()) {
      const call = pendings[i]!.call;
      const result: ToolResult =
        outcome.status === "fulfilled"
          ? outcome.value
          : { content: [{ type: "text", text: "aborted" }], isError: true };
      yield {
        type: "tool_execution_end",
        toolCallId: call.id,
        toolName: call.name,
        result,
        isError: result.isError,
      };
      if (result.terminate) anyTerminate = true;
      const resultMsg: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        isError: result.isError,
      };
      context.messages.push(resultMsg);
      newMessages.push(resultMsg);
      toolResults.push(resultMsg);
    }

    yield { type: "turn_end", message: partial, toolResults };

    // AC-L3-5:整批 terminate。某 ToolResult.terminate=true → 该批后停。
    if (anyTerminate) {
      yield { type: "agent_end", messages: newMessages, reason: "terminate" };
      return;
    }
    // 继续 next turn(模型收 toolResult 后决定停或续)
  }
}

// C6 AC-2:规则行格式 = `<tool>  <prefix>`(双空格)。弹面与落盘解析共用,一处定义。
function fmtRule(r: Rule): string {
  return `${r.tool}  ${r.prefix}`;
}

function snapshot(m: AssistantMessage): AssistantMessage {
  // 深拷贝 content 块:TextBlock.text 不可变,但块本身随 delta 原地突变
  // (appendText 改 last.text += delta)。浅拷数组会让各快照共享同一块 →
  // 时间旅行错乱(AC-L3-3:message_end 前每快照内容 = 当时已收 delta)。
  return { ...m, content: m.content.map((b) => ({ ...b })) };
}

function appendText(m: AssistantMessage, delta: string): void {
  const last = m.content[m.content.length - 1];
  if (last && last.type === "text") {
    (last as TextBlock).text += delta;
  } else {
    m.content.push({ type: "text", text: delta });
  }
}

// thinking_delta 同 text_delta 累积语义:末块是 thinking 则拼接,否则新起一块
//(thinking 与 text 交错时各留各的块)。
function appendThinking(m: AssistantMessage, delta: string): void {
  const last = m.content[m.content.length - 1];
  if (last && last.type === "thinking") {
    (last as ThinkingBlock).text += delta;
  } else {
    m.content.push({ type: "thinking", text: delta });
  }
}

// toolcall_delta 载 parsed args prefix;loop 取最新 arguments 快照(salvage 归 S1)。
// 同 id 的块累积更新;新 id 建块。name 随 delta 更新(适配器定稿前可能先发 name)。
function applyToolCallDelta(
  m: AssistantMessage,
  event: { id: string; name: string; arguments: unknown },
): void {
  const existing = m.content.find(
    (b): b is ToolCallBlock => b.type === "toolCall" && b.id === event.id,
  );
  if (existing) {
    existing.name = event.name;
    existing.arguments = event.arguments;
  } else {
    m.content.push({
      type: "toolCall",
      id: event.id,
      name: event.name,
      arguments: event.arguments,
    });
  }
}
