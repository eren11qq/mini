// T3 write 工具:seam = Tool 公共接口(types.ts:110)。
// 签名照 pi tools/write.ts:11-14 = {path, content} 整文件落盘。
// AC-T3-3 同文件写队列:pi 走 file-mutation-queue 共享模块,mini 减 = 队列自持在本工具
// (edit 已合无队列、bash 不需要,不外抽;需要时再提)。key = resolve(path) 归一化,
// 同路径按调用序 FIFO 串行,不同路径互不阻塞;尾条目完成即删,表不单调膨胀。
// 工具层可 try/catch(loop 层零 try/catch 约束不含 src/tools/,同 read.ts/edit.ts)。
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { diffDetails } from "../util/diff.ts";
import { pathMatchOf, pathInput, type Tool, type ToolResult } from "./tool.ts";

// 每路径一条 promise 链:新任务挂到当前尾巴后面 → 落盘严格串行。
const tails = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  // prev 成功或失败都接跑 task(链不断;task 自身按契约不 reject,兜底而已)。
  const next = prev.then(task, task);
  tails.set(key, next);
  const cleanup = () => {
    if (tails.get(key) === next) tails.delete(key);
  };
  next.then(cleanup, cleanup);
  return next;
}

function err(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
function ok(text: string, details?: ToolResult["details"]): ToolResult {
  return { content: [{ type: "text", text }], isError: false, ...(details && { details }) };
}
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const writeTool: Tool = {
  name: "write",
  description:
    "Create or overwrite a file with the exact `content` given (whole file, not a patch). Use edit for small changes to an existing file.",
  // AC-T2-4 同款:loop run 前 ajv 校验(旁挂 JSON Schema,PRD tools 行)。
  schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  // C1:种子与判据都只看 path(内容变化不再击落 always 规则);cwd 外种子 → `*` 拒粘。
  // C5:判据 cwd 外给 `path:`+绝对供黑名单查;matchKind:"path" = 危险路径层开关。
  matchOf: pathMatchOf,
  prefixOf: pathInput,
  matchKind: "path",
  async run(args: unknown): Promise<ToolResult> {
    const a = args as { path?: unknown; content?: unknown };
    const path = String(a.path);
    return enqueue(resolve(path), async () => {
      // C20(docs/ISSUES.md):enqueue 串行段内 best-effort 读旧(零新并发面)。
      // ENOENT=新建、其他读失败=降级,两种都按空串 diff;展示层不饿死主功能,写入照常。
      let old = "";
      try {
        old = await readFile(path, "utf8");
      } catch {
        /* 读旧失败 → 按新建 */
      }
      try {
        await writeFile(path, String(a.content));
      } catch (e) {
        return err(`write failed: ${path}: ${msg(e)}`);
      }
      // C20:成功才挂 details(失败零 details → warn 路径逐字节旧样),机器同 edit(C19)。
      return ok(`wrote ${path}`, diffDetails(path, old, String(a.content)));
    });
  },
};
