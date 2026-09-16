import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiffDetails } from "../util/diff.ts";
import { writeTool } from "./write.ts";

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

// C20(docs/ISSUES.md):write 覆盖 → 全文件 diff。seam = run() 返回的 details(纯侧信道,
// content 面零变)。旧串 = enqueue 段内 best-effort 读;diff 机器/色规/折叠全复用 C19。
describe("C20 write:全文件 diff details", () => {
  // AC-1 新建(ENOENT):旧串按空 diff = 全绿。行模型下 "" 是一行,故用带尾换行的
  // content(真文件常态)让公共后缀吃掉尾空行 → removed=0(无尾换行时 diff 机器会
  // 显一条 -"" 空行,属 C19 尾换行翻转既定样式,非本片变量)。
  // 尾 " " 空行 = C19 ±2 ctx 窗把后缀吃掉的尾行回推(机既定,非本片变量)。
  it("新建 → 全 + 行、removed=0、added=行数", async () => {
    const path = join(dir, "c20-new.txt");
    const result = await writeTool.run({ path, content: "X\nY\n" });

    expect(result.isError).toBe(false);
    const d = result.details as DiffDetails;
    expect(d.kind).toBe("diff");
    expect(d.path).toBe(path);
    expect([d.added, d.removed]).toEqual([2, 0]);
    expect(d.hunks).toEqual([
      {
        oldStart: 1,
        newStart: 1,
        rows: [
          { t: "+", s: "X" },
          { t: "+", s: "Y" },
          { t: " ", s: "" },
        ],
      },
    ]);
  });

  // AC-2 覆盖既有文件 → 红绿真 diff(期望 = 手算 git 式窗:±2 上下文,C 行换 x 行)。
  it("覆盖 → 红绿真 diff(-C +x,前后 ctx)", async () => {
    const path = join(dir, "c20-over.txt");
    await writeFile(path, "A\nB\nC\nD\nE\n", "utf8");
    const result = await writeTool.run({ path, content: "A\nB\nx\nD\nE\n" });

    expect(result.isError).toBe(false);
    const d = result.details as DiffDetails;
    expect([d.added, d.removed]).toEqual([1, 1]);
    expect(d.hunks).toEqual([
      {
        oldStart: 1,
        newStart: 1,
        rows: [
          { t: " ", s: "A" },
          { t: " ", s: "B" },
          { t: "-", s: "C" },
          { t: "+", s: "x" },
          { t: " ", s: "D" },
          { t: " ", s: "E" },
        ],
      },
    ]);
    expect(await readFile(path, "utf8")).toBe("A\nB\nx\nD\nE\n");
  });

  // AC-3 旧文件读失败(EACCES)→ details 按新建算,但写入照常成功(展示层不饿死主功能)。
  // 构造 = mode 0200(Linux 非 root:O_RDONLY 拒、O_WRONLY 放行)。root 下权限位不拦 → 跳。
  it.skipIf(process.getuid?.() === 0)("旧文件 EACCES → details 按新建算且写入不失败", async () => {
    const path = join(dir, "c20-eacces.txt");
    await writeFile(path, "old-secret-lines\n", "utf8");
    await chmod(path, 0o200);
    try {
      const result = await writeTool.run({ path, content: "N1\nN2\n" });

      expect(result.isError).toBe(false);
      const d = result.details as DiffDetails;
      expect(d.kind).toBe("diff");
      expect([d.added, d.removed]).toEqual([2, 0]);
      // 无 - 行 = 按新建(尾 " " 空行 ctx 同 AC-1 机既定)。
      expect(d.hunks[0]!.rows.every((r) => r.t !== "-")).toBe(true);
      await chmod(path, 0o600); // 写后权限位原样,断言自读需先放行
      expect(await readFile(path, "utf8")).toBe("N1\nN2\n");
    } finally {
      await chmod(path, 0o600); // 防 rm 后 tmp 残留不可读(尽力清理)
    }
  });
});
