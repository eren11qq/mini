import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.js";
import type { AssistantMessage, UserMessage } from "../loop/types.js";

// M1 seam:SessionManager({baseDir,cwd}) 公共边界(PRD S3:SessionManager(tempDir) 写读断言)。
// 磁盘 jsonl = 唯一真相源;不断言私有字段内部。

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mini-session-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const userMsg: UserMessage = { role: "user", content: "hi" };

// jsonl 行 = 磁盘外部真相;测试只看字段,不 import 实现的 entry 类型。
const parse = (line: string): Record<string, unknown> =>
  JSON.parse(line) as Record<string, unknown>;

// 按 cwd 编码子目录(以 cwdTag 唯一片段定位)找该会话唯一 jsonl。
async function soleSessionFile(cwdTag: string): Promise<string> {
  const subs = await readdir(dir);
  const sub = subs.find((s) => s.includes(cwdTag));
  expect(sub).toBeDefined();
  const files = await readdir(join(dir, sub!));
  expect(files).toHaveLength(1);
  return join(dir, sub!, files[0]!);
}

describe("M1 append:落盘格式", () => {
  it("AC-M1-2 append message → <cwd编码>/<时间>_<uuidv7>.jsonl;首行 header {type:session,version:1,id,cwd};第 2 行含 id/parentId/ts/type/payload", async () => {
    const cwd = join(dir, "proj");
    const sm = new SessionManager({ baseDir: dir, cwd });

    sm.append({ type: "message", payload: userMsg });

    const file = await soleSessionFile("proj");
    // 文件名:<时间>_<uuidv7>.jsonl(uuidv7 = 标准 8-4-4-4-12,version 位 7)
    expect(file).toMatch(
      /\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jsonl$/,
    );

    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(2);

    const header = parse(lines[0]!);
    expect(header).toMatchObject({ type: "session", version: 1, cwd });
    expect(typeof header.id).toBe("string");

    const entry = parse(lines[1]!);
    expect(entry.type).toBe("message");
    expect(entry.id).toMatch(/^[0-9a-f]{8}$/);
    expect(entry.parentId).toBe(header.id);
    expect(typeof entry.ts).toBe("number");
    expect(entry.payload).toEqual(userMsg);
  });
});

describe("M1 append:即时落盘", () => {
  it("AC-M1-3 append 返回后立即 readFile(不关句柄、不等进程退出)→ 文件已含该行;第二条同理逐行可见", async () => {
    const cwd = join(dir, "flush");
    const sm = new SessionManager({ baseDir: dir, cwd });

    const e1 = sm.append({ type: "message", payload: userMsg });
    const file = await soleSessionFile("flush");
    let lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(parse(lines[1]!).id).toBe(e1.id);

    const e2 = sm.append({ type: "message", payload: { role: "user", content: "again" } });
    lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(parse(lines[2]!).id).toBe(e2.id);
  });
});

describe("M1 append:entry 类型限制", () => {
  it("AC-M1-4 append type=custom(非 5 种之一)→ 抛错且不写入文件(行数不变)", async () => {
    const cwd = join(dir, "restrict");
    const sm = new SessionManager({ baseDir: dir, cwd });
    sm.append({ type: "message", payload: userMsg });
    const file = await soleSessionFile("restrict");
    const before = (await readFile(file, "utf8")).trimEnd().split("\n");

    // 运行时边界:类型系统外的假 type(DEFERRED 砍件 custom 不得混入 v1 5 种)。
    expect(() =>
      sm.append({ type: "custom", payload: {} } as unknown as Parameters<
        SessionManager["append"]
      >[0]),
    ).toThrowError(/custom/);
    // 首建前就拒绝:也不产生任何文件/目录。
    const sm2 = new SessionManager({ baseDir: dir, cwd: join(dir, "restrict2") });
    expect(() =>
      sm2.append({ type: "label" } as unknown as Parameters<SessionManager["append"]>[0]),
    ).toThrowError();
    const subs = await readdir(dir);
    expect(subs.some((s) => s.includes("restrict2"))).toBe(false);

    const after = (await readFile(file, "utf8")).trimEnd().split("\n");
    expect(after).toEqual(before);
  });
});

describe("M1 model_change + rebuild", () => {
  it("AC-M1-5 append model_change → 行落盘 type=model_change;rebuild() messages 投影 message 行、model = 切后模型", async () => {
    const cwd = join(dir, "model");
    const sm = new SessionManager({ baseDir: dir, cwd });
    const asst: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      stopReason: "stop",
    };

    sm.append({ type: "message", payload: userMsg });
    sm.append({ type: "model_change", payload: { model: "gpt-4o" } });
    sm.append({ type: "message", payload: asst });

    const file = await soleSessionFile("model");
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    expect(parse(lines[2]!)).toMatchObject({ type: "model_change", payload: { model: "gpt-4o" } });

    const ctx = sm.rebuild();
    expect(ctx.messages).toEqual([userMsg, asst]); // model_change 不投影进 messages
    expect(ctx.model).toBe("gpt-4o"); // 线性路径末条 model_change = 切后模型
  });
});
