import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.ts";

// S-c 缝:SessionManager.list({baseDir,cwd}) —— --resume 编号选择器数据源(AC-H2-5)。
// 磁盘 jsonl = 真相源;只走公共边界断言:最新在前(mtime 降序)、sessionId 从文件名解析、
// model 取该会话末条 model_change。不碰私有字段。
const userMsg = { role: "user" as const, content: "hi" };
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// 文件名 <时间>_<uuidv7>.jsonl:时间无下划线、uuid 无下划线 → 首个 _ 后到 .jsonl 即 sessionId。
const sidOf = (name: string) => name.slice(name.indexOf("_") + 1, name.length - ".jsonl".length);

function sessionFiles(sub: string): string[] {
  return readdirSync(sub).filter((n) => n.endsWith(".jsonl"));
}

describe("S-c SessionManager.list", () => {
  it("目录不存在(这台机器从未跑过)→ []", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "mini-list-"));
    try {
      expect(SessionManager.list({ baseDir, cwd: "/nope/x" })).toEqual([]);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("同 cwd 三会话:最新在前;sessionId 解析;末条 model_change 定 model", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "mini-list-"));
    const cwd = join(baseDir, "proj");
    try {
      for (let i = 0; i < 3; i++) {
        new SessionManager({ baseDir, cwd }).append({ type: "message", payload: userMsg });
      }
      const sub = join(
        baseDir,
        readdirSync(baseDir).find((s) => s.includes("proj"))!,
      );
      const names = sessionFiles(sub);
      expect(names).toHaveLength(3);

      // 给「中间名字那个」会话挂 model_change(按 sessionId 精确 open,不靠 mtime 运气)。
      const modelTarget = names[1]!;
      SessionManager.open({ baseDir, cwd, sessionId: sidOf(modelTarget) }).append({
        type: "model_change",
        payload: { model: "glm" },
      });

      // 全部写完后设 mtime(append 会刷新 mtime):名字升序 ↔ 1000/2000/3000。
      const sorted = [...names].sort();
      utimesSync(join(sub, sorted[0]!), 1000, 1000);
      utimesSync(join(sub, sorted[1]!), 2000, 2000);
      utimesSync(join(sub, sorted[2]!), 3000, 3000);

      const list = SessionManager.list({ baseDir, cwd });

      // 严格 mtime 降序 = 最新在前(utimesSync 传秒,mtimeMs 是毫秒)。
      expect(list.map((s) => s.mtimeMs)).toEqual([3_000_000, 2_000_000, 1_000_000]);
      expect(list.map((s) => s.file)).toEqual([
        join(sub, sorted[2]!),
        join(sub, sorted[1]!),
        join(sub, sorted[0]!),
      ]);
      // sessionId = 文件名解析出的 uuidv7。
      for (const s of list) expect(s.sessionId).toMatch(uuidRe);
      expect(list.map((s) => s.sessionId)).toEqual([
        sidOf(sorted[2]!),
        sidOf(sorted[1]!),
        sidOf(sorted[0]!),
      ]);
      // 只有 modelTarget 那条带 model_change → 唯它有 model。
      expect(list.find((s) => s.sessionId === sidOf(modelTarget))!.model).toBe("glm");
      expect(list.filter((s) => s.model !== undefined)).toHaveLength(1);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
