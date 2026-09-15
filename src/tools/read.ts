// T1 read 工具:seam = Tool 公共接口(types.ts:107)。
// 语义(AC-T1-2):1-based offset,limit 行数;输出每行 `行号\t内容`(续读/edit 报得准行号)。
import { readFile } from "node:fs/promises";
import type { Tool, ToolResult } from "./tool.ts";

// AC-T1-3:超长保尾截断,阈值 2000 行 / 50KB 先到者(DECISIONS T5)。
// 返回体含首行截断提示(模型据此带 offset 重读)。
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

function truncatedNotice(kept: number, total: number): string {
  return `[truncated: showing last ${kept} of ${total} lines]`;
}

// T1 保尾 + T4 bash 共用(阈值单源,DECISIONS T5)。
export function tailTruncate(lines: string[]): string {
  const total = lines.length;
  const whole = lines.join("\n");
  if (total <= MAX_LINES && Buffer.byteLength(whole, "utf8") <= MAX_BYTES) return whole;
  // 单行(start=length)→ 只剩提示行,恒 fit → 二分必有解;单调:更小 start = 更大体。
  const fits = (start: number): boolean => {
    const kept = total - start;
    if (kept + 1 > MAX_LINES) return false;
    const text = truncatedNotice(kept, total) + "\n" + lines.slice(start).join("\n");
    return Buffer.byteLength(text, "utf8") <= MAX_BYTES;
  };
  let lo = 0;
  let hi = total;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) hi = mid;
    else lo = mid + 1;
  }
  return truncatedNotice(total - lo, total) + "\n" + lines.slice(lo).join("\n");
}

export const readTool: Tool = {
  name: "read",
  description:
    "Read a text file. Returns at most `limit` lines starting at 1-based `offset` (default line 1), each line prefixed with its line number. Very long output is tail-truncated with a [truncated: ...] notice — re-read with a larger offset to see earlier lines.",
  // AC-T2-5:只读工具放行,不过确认门(DECISIONS T3:确认范围 = bash/write/edit)。
  skipConfirm: true,
  // H1 装配发现:provider 要 parameters 才会带参调用(read 原先无 schema → 模型只能猜)。
  // 旁挂即入 loop 的 ajv 校验路径(run-loop.ts:180),形状与 run() 内读取一致。
  schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1 },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async run(args: unknown): Promise<ToolResult> {
    // 契约(types.ts:105 注):任何失败转 isError:true 回喂,run 不 throw。
    try {
      const a = args as { path?: unknown; offset?: unknown; limit?: unknown };
      const path = String(a.path);
      const start = (Number(a.offset ?? 1) || 1) - 1;
      const limit = a.limit == null ? undefined : Number(a.limit);

      const raw = await readFile(path, "utf8");
      const lines = raw.split("\n");
      const sliced = lines.slice(start, limit === undefined ? undefined : start + limit);
      const numbered = sliced.map((l, i) => `${start + i + 1}\t${l}`);
      return { content: [{ type: "text", text: tailTruncate(numbered) }], isError: false };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text", text: `read failed: ${msg}` }], isError: true };
    }
  },
};
