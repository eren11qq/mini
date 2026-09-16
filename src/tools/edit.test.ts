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

  it("C19: 成功 run → details = diffDetails(全文旧,全文新):± 行 = 锚点区,未触行成 ctx", async () => {
    const path = join(dir, "c19.txt");
    await writeFile(path, "aaa x\nbbb y\n");

    const result = await editTool.run({ path, edits: [{ oldText: "aaa x", newText: "AAA x" }] });
    expect(result.isError).toBe(false);
    // 手算:尾换行 phantom 空行按 split 模型成 ctx 行(卡钉「尾换行翻转显 ± 空行」同一模型,W2 眼验)。
    expect(result.details).toEqual({
      kind: "diff",
      path,
      added: 1,
      removed: 1,
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          rows: [
            { t: "-", s: "aaa x" },
            { t: "+", s: "AAA x" },
            { t: " ", s: "bbb y" },
            { t: " ", s: "" },
          ],
        },
      ],
    });
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

  it("C19: abort/读失败 → details === undefined(warn 路径零侧信道)", async () => {
    const path = join(dir, "c19-abort.txt");
    await writeFile(path, "aaa x\n");
    const miss = await editTool.run({ path, edits: [{ oldText: "zzz", newText: "Z" }] });
    expect(miss.isError).toBe(true);
    expect(miss.details).toBeUndefined();
    const noFile = await editTool.run({
      path: join(dir, "c19-none.txt"),
      edits: [{ oldText: "a", newText: "b" }],
    });
    expect(noFile.isError).toBe(true);
    expect(noFile.details).toBeUndefined();
  });
});
