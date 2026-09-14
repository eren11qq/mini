// H2 S-b 缝:命令行 flag 手工解析(DECISIONS H2「flags 全集仅 3 个」;照 pi 无第三方库)。
// --model <alias> 取值;--continue / --resume 布尔。本函数纯:只记录出现,continue/resume
// 优先级与选会话在 cli 组装层裁决。--model 缺值抛错(绝不静默降级成「未给」)。
export interface ParsedArgs {
  model?: string;
  continue: boolean;
  resume: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { model: undefined, continue: false, resume: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--model") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) {
        throw new Error("--model 需要一个厂商 alias(如 --model glm)");
      }
      out.model = v;
    } else if (a === "--continue") {
      out.continue = true;
    } else if (a === "--resume") {
      out.resume = true;
    }
  }
  return out;
}
