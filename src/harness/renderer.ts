// H1 renderer:AgentEvent 流 → stdout 字符串。缝 = (write) => (event) => void,
// 故 CLI 的 I/O 与测试的数组 sink 共用同一份逻辑(DECISIONS W2:harness 其余不留自动测试)。
// 契约:loop 每个 delta 都 yield 累积快照(run-loop.ts:73-76),所以这里必须按下标记住
// 已打长度、只补后缀 —— 直接打快照 = 整块重打,违 AC-H1-2「非整块」。
import type { AgentEvent } from "../loop/types.ts";

const DIM = "\x1b[2m";
const DIM_OFF = "\x1b[22m";

export function createRenderer(write: (s: string) => void): (event: AgentEvent) => void {
  const printed: number[] = []; // 当前 message 各 content 块已打字符数
  let sawContent = false;
  let dim = false;

  return (event: AgentEvent) => {
    switch (event.type) {
      case "message_start":
        printed.length = 0;
        sawContent = false;
        break;
      case "message_update": {
        const blocks = event.message.content;
        for (let i = 0; i < blocks.length; i++) {
          const block = blocks[i];
          // !block:noUncheckedIndexedAccess 下 blocks[i] 含 undefined,不排掉则窄化失败。
          if (!block || (block.type !== "text" && block.type !== "thinking")) continue;
          const already = printed[i] ?? 0;
          if (block.text.length <= already) continue;
          // thinking 淡显:进段开一次 dim,出段关一次(逐 delta 重复转义 = 无谓闪)。
          if (block.type === "thinking") {
            if (!dim) {
              write(DIM);
              dim = true;
            }
          } else if (dim) {
            write(DIM_OFF);
            dim = false;
          }
          write(block.text.slice(already));
          printed[i] = block.text.length;
          sawContent = true;
        }
        break;
      }
      case "message_end": {
        if (dim) {
          write(DIM_OFF);
          dim = false;
        }
        if (sawContent) write("\n");
        // AC-L3-2 / AC-L3-4:provider error 与外部 abort 都编码进 message
        // (stopReason/errorMessage 不在 content 里),不另印 = 用户只看空屏。
        const reason = event.message.stopReason;
        if (reason === "error" || reason === "aborted") {
          const text = reason === "error" ? event.message.errorMessage : undefined;
          write(text ? `[${reason}] ${text}\n` : `[${reason}]\n`);
        }
        break;
      }
    }
  };
}
