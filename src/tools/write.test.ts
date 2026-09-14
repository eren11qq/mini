import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTool } from "./write.js";

// T3 seam:writeTool via Tool.run(types.ts:110 公共接口)。磁盘状态 = 唯一真相源。
// AC-T3-2:write 整文件落盘,内容字节级 = 传入 content。

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mini-write-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("T3 write:整文件落盘", () => {
  it('AC-T3-2 write({path,content}) → 文件存在,内容字节级 = "X\\nY",result 成功', async () => {
    const path = join(dir, "t32.txt");

    const result = await writeTool.run({ path, content: "X\nY" });

    expect(result.isError).toBe(false);
    expect(await readFile(path, "utf8")).toBe("X\nY");
  });
});

describe("T3 write:同文件写队列串行", () => {
  it("AC-T3-3 并发同 path 两写(大A先发起/小B紧跟)→ 按调用序串行,最终 = B 完整;多轮恒成立、无交错", async () => {
    const path = join(dir, "t33.txt");
    const bigA = "A".repeat(2 * 1024 * 1024); // 2MB:无队列时落盘慢,后发起的 B 会反超 → 红
    const smallB = "B".repeat(64);

    // 多轮(AC Verification"多次并发"):每轮 A 先发起、B 不 await 紧跟。
    for (let round = 0; round < 20; round++) {
      const pA = writeTool.run({ path, content: bigA });
      const pB = writeTool.run({ path, content: smallB });
      const [rA, rB] = await Promise.all([pA, pB]);
      expect([rA.isError, rB.isError]).toEqual([false, false]);

      const final = await readFile(path, "utf8");
      // Must not:A/B 字节交错或部分落盘 —— 最终必是某次写入的完整字面量。
      expect(final === bigA || final === smallB).toBe(true);
      // 加强(用户已确认):队列保证调用序 = 落盘序,后发起的 B 最后落。
      expect(final).toBe(smallB);
    }
  });
});
