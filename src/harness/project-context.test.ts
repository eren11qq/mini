// H3 S-b 纯缝(带 fs 边界):findProjectContext —— cwd 向上找 AGENTS.md/CLAUDE.md。
// 裁决:跨目录恒近者赢;同目录 AGENTS.md 赢;皆无 = null。root 参数 = 向上停点
// (测试锁真文件系统上层不被误读;生产缺省走到文件系统根)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectContext } from "./project-context.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mini-ctx-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const put = async (rel: string, content: string) => {
  const abs = join(dir, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, content, "utf8");
};

describe("S-b findProjectContext", () => {
  it("AC-H3-4 /a/CLAUDE.md 与 /a/b/AGENTS.md 并存,起于 /a/b/c → 用近者 /a/b/AGENTS.md", async () => {
    await put("prox/a/CLAUDE.md", "远的 CLAUDE");
    await put("prox/a/b/AGENTS.md", "近的 AGENTS");
    await mkdir(join(dir, "prox/a/b/c"), { recursive: true });
    const ctx = findProjectContext({
      cwd: join(dir, "prox/a/b/c"),
      root: join(dir, "prox"),
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.path).toBe(join(dir, "prox/a/b/AGENTS.md"));
    expect(ctx!.content).toBe("近的 AGENTS");
  });

  it("同目录并存 → AGENTS.md 赢(跨目录近者优先不变)", async () => {
    await put("same/AGENTS.md", "AGENTS 内容");
    await put("same/CLAUDE.md", "CLAUDE 内容");
    const ctx = findProjectContext({ cwd: join(dir, "same"), root: join(dir, "same") });
    expect(ctx!.path).toBe(join(dir, "same/AGENTS.md"));
  });

  it("cwd 自己都没有、上级有 CLAUDE.md → 用上级那份", async () => {
    await put("up/CLAUDE.md", "上级 CLAUDE");
    await mkdir(join(dir, "up/x/y"), { recursive: true });
    const ctx = findProjectContext({ cwd: join(dir, "up/x/y"), root: join(dir, "up") });
    expect(ctx!.path).toBe(join(dir, "up/CLAUDE.md"));
  });

  it("一路到 root 都没有 → null(启动照常,project_instructions 段省略)", async () => {
    await mkdir(join(dir, "bar/baz"), { recursive: true });
    expect(findProjectContext({ cwd: join(dir, "bar/baz"), root: join(dir, "bar") })).toBeNull();
  });
});
