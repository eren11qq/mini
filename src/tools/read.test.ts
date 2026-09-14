import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../loop/types.js";
import { readTool } from "./read.js";

// T1 seam 1:read:Tool 公共接口。临时文件驱动,只断言 ToolResult 对外可见面,
// 不触碰 read.ts 内部(实现可换,seam 不变)。

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mini-read-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function resultText(result: ToolResult): string {
  return result.content.map((b) => b.text).join("");
}

// AC-T1-2: offset/limit 切片
// Scenario:临时文件 100 行,每行 "L<行号>"(L1..L100)
// Action:read({path, offset:10, limit:5})
// Expected:isError:false;单一 TextBlock = "10\tL10".."14\tL14"
//         (1-based:offset:10 → 从第 10 行起,含行号前缀)
// Must not:含 L9 或 L15
describe("AC-T1-2 read offset/limit 切片", () => {
  it("offset:10 limit:5 → 恰第 10–14 行带行号前缀", async () => {
    const path = join(dir, "f100.txt");
    await writeFile(path, Array.from({ length: 100 }, (_, i) => `L${i + 1}`).join("\n"));

    const result = await readTool.run({ path, offset: 10, limit: 5 });

    expect(result.isError).toBe(false);
    expect(resultText(result)).toBe(
      ["10\tL10", "11\tL11", "12\tL12", "13\tL13", "14\tL14"].join("\n"),
    );
  });
});

// AC-T1-3: 超长保尾截断
// Scenario:临时文件 10000 行("L1".."L10000",全文 ~90KB > 50KB)
// Action:read({path}) 不带 limit
// Expected:保尾 —— 末行 "10000\tL10000" 在内;返回体(含首行截断提示)
//         总行数 ≤2000 且总字节 ≤50KB;首行含 "truncated"(模型可察觉、带 offset 重读)
// Must not:返回体超阈值;含首行 L1(已被截掉)
describe("AC-T1-3 超长保尾截断", () => {
  it("10000 行不带 limit → ≤2000 行且 ≤50KB、含末行、首行截断提示", async () => {
    const path = join(dir, "f10000.txt");
    await writeFile(path, Array.from({ length: 10000 }, (_, i) => `L${i + 1}`).join("\n"));

    const result = await readTool.run({ path });

    expect(result.isError).toBe(false);
    const text = resultText(result);
    const lines = text.split("\n");
    expect(lines.length).toBeLessThanOrEqual(2000);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(50 * 1024);
    expect(lines[lines.length - 1]).toBe("10000\tL10000");
    expect(lines[0]).toMatch(/truncated/);
    expect(text).not.toMatch(/^1\tL1$/m);
  });
});

// Tool 契约(types.ts:105 注):run 失败 → isError:true 回喂,不 throw(loop 层零 try/catch)。
// Scenario:path 指向不存在文件
// Action:read({path: nope})
// Expected:Promise 兑现(不 reject);isError:true;content 载错误信息
// Must not:throw / reject
describe("Tool 契约:文件不存在 → isError 回喂不 throw", () => {
  it("nonexistent path → isError:true 且 promise 兑现", async () => {
    const result = await readTool.run({ path: join(dir, "nope.txt") });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/ENOENT|no such file/i);
  });
});
