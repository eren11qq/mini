// T2 edit 工具:seam = Tool 公共接口(types.ts:107)。
// 签名照 pi tools/edit.ts:32-40 = {path, edits:[{oldText,newText}]} 多锚点全批原子。
// 原子 = 先全部在内存 working copy 上校验+替换,任一锚点不命中 → 不落盘返回 error(AC-T2-3);
// 全命中 → 一次 writeFile 落盘(AC-T2-2)。锚点按序应用(后锚在前锚结果上找,同 pi edit-diff)。
// 工具层可 try/catch(loop 层零 try/catch 约束不含 src/tools/,同 read.ts)。
import { readFile, writeFile } from "node:fs/promises";
import type { Tool, ToolResult } from "./tool.ts";

function err(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: false };
}
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const editTool: Tool = {
  name: "edit",
  description:
    "Edit a file by exact text anchors. Each edit.oldText must occur in the file; its first occurrence is replaced by newText, anchors applied in order. A missing anchor aborts the whole call and writes nothing.",
  // AC-T2-4:loop run 前 ajv 校验(旁挂 JSON Schema,PRD tools 行"旁挂 JSON Schema")。
  schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      edits: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            oldText: { type: "string", minLength: 1 },
            newText: { type: "string" },
          },
          required: ["oldText", "newText"],
          additionalProperties: false,
        },
      },
    },
    required: ["path", "edits"],
    additionalProperties: false,
  },
  async run(args: unknown): Promise<ToolResult> {
    const a = args as { path?: unknown; edits?: unknown };
    const path = String(a.path);
    const edits = a.edits as { oldText: string; newText: string }[];

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (e) {
      return err(`edit failed: read ${path}: ${msg(e)}`);
    }

    let cur = raw;
    for (const [i, ed] of edits.entries()) {
      const idx = cur.indexOf(ed.oldText);
      if (idx === -1) {
        return err(
          `edit aborted: anchor ${i} (oldText=${JSON.stringify(ed.oldText)}) not found in ${path}; no changes written`,
        );
      }
      cur = cur.slice(0, idx) + ed.newText + cur.slice(idx + ed.oldText.length);
    }

    try {
      await writeFile(path, cur);
    } catch (e) {
      return err(`edit failed: write ${path}: ${msg(e)}`);
    }
    return ok(`edited ${path}: ${edits.length} anchor(s) applied`);
  },
};
