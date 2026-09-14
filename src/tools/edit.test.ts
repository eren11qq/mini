import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editTool } from "./edit.ts";

// T2 seam:editTool via Tool.run(types.ts:107 公共接口)。磁盘状态 = 唯一真相源。
// AC-T2-2:多锚点全命中 → 全部落盘、isError:false。

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mini-edit-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("T2 edit:多锚点原子替换", () => {
  it("AC-T2-2 两锚点全命中 → 文件含 AAA+BBB,result 成功", async () => {
    const path = join(dir, "t22.txt");
    await writeFile(path, "aaa x bbb y\n");

    const result = await editTool.run({
      path,
      edits: [
        { oldText: "aaa", newText: "AAA" },
        { oldText: "bbb", newText: "BBB" },
      ],
    });

    expect(result.isError).toBe(false);
    expect(await readFile(path, "utf8")).toBe("AAA x BBB y\n");
  });

  it("AC-T2-3 一锚点不命中 → 整批失败、文件字节级原样(无部分落盘)", async () => {
    const path = join(dir, "t23.txt");
    const original = "aaa x bbb y\n";
    await writeFile(path, original);

    const result = await editTool.run({
      path,
      edits: [
        { oldText: "aaa", newText: "AAA" }, // 命中
        { oldText: "zzz", newText: "ZZZ" }, // 不命中 → 整批拒
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content.map((b) => b.text).join("")).toMatch(/not found/);
    // 原子性核心:首个锚点已命中的 "AAA" 也绝不能落盘
    expect(await readFile(path, "utf8")).toBe(original);
  });
});
