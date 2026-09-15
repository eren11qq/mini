import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "./session-manager.ts";
import { SUMMARY_SECTIONS, buildSummarizePrompt } from "./summarize-prompt.ts";
import { runLoop } from "../loop/run-loop.ts";
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  LoopContext,
  UserMessage,
} from "../loop/types.ts";
import type { ProviderEvent, StreamFn } from "../stream/protocol.ts";

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

const user = (t: string): UserMessage => ({ role: "user", content: t });
const asst = (t: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: t }],
  stopReason: "stop",
});

describe("M2 rebuild:leaf 回溯", () => {
  it("AC-M2-2 append 带 parentId 造多分支 → rebuild(leafId) = 该 leaf 沿 parentId 回溯到根的路径投影,不含兄弟分支", async () => {
    const cwd = join(dir, "branch");
    const sm = new SessionManager({ baseDir: dir, cwd });
    const root = sm.append({ type: "message", payload: user("u1") });
    const a = sm.append({ type: "message", payload: asst("A") }); // 隐式续 root
    const b = sm.append({ type: "message", payload: asst("B"), parentId: root.id }); // 分叉
    const b2 = sm.append({ type: "message", payload: asst("B2"), parentId: b.id }); // 分支上再一跳

    // 回溯必须多跳且排除兄弟:A 分支看不到 B 分支的行,反之亦然。
    expect(sm.rebuild(a.id).messages).toEqual([user("u1"), asst("A")]);
    expect(sm.rebuild(b2.id).messages).toEqual([user("u1"), asst("B"), asst("B2")]);
  });

  it("AC-M2-2 model 取路径上末条,不取文件末行:文件最后写的是 B 分支 model_change,rebuild(A leaf).model 仍是 A 分支模型", async () => {
    const cwd = join(dir, "xswitch");
    const sm = new SessionManager({ baseDir: dir, cwd });
    const root = sm.append({ type: "message", payload: user("u1") });
    const a = sm.append({ type: "model_change", payload: { model: "model-A" }, parentId: root.id });
    // 之后文件末尾属于 B 分支,且带不同模型。
    const b = sm.append({ type: "model_change", payload: { model: "model-B" }, parentId: root.id });
    expect(sm.rebuild(b.id).model).toBe("model-B");
    expect(sm.rebuild(a.id).model).toBe("model-A"); // 线性投影会读到 model-B(文件末行)→ 红
  });
});

describe("M2 崩溃恢复:open 重开同一 jsonl", () => {
  it("AC-M2-4 append 两条后丢弃实例(模拟 kill)→ open({baseDir,cwd}) 接最新会话:已 flush entry 全在、不新建文件、append 续在最新 leaf 之后", async () => {
    const cwd = join(dir, "crash");
    const sm = new SessionManager({ baseDir: dir, cwd });
    sm.append({ type: "message", payload: user("u1") });
    const e2 = sm.append({ type: "message", payload: asst("a1") });
    const file = await soleSessionFile("crash");
    void sm; // kill:此后不再用该实例,只当磁盘是真相

    const reopened = SessionManager.open({ baseDir: dir, cwd });
    expect(reopened.rebuild().messages).toEqual([user("u1"), asst("a1")]);

    const e3 = reopened.append({ type: "message", payload: user("u2") });
    // 同一文件(未新建)、行数 3→4、新行 parentId 指回 kill 前 leaf。
    expect(await soleSessionFile("crash")).toBe(file);
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    expect(parse(lines[3]!)).toMatchObject({ id: e3.id, parentId: e2.id });
  });

  it("AC-M2-4 kill 落在写入中途(末行 = 半截 JSON)→ open 截到末个换行:已提交 entry 一条不丢、rebuild 不炸、续写 parentId 指回最后完好 entry", async () => {
    const cwd = join(dir, "torn");
    const sm = new SessionManager({ baseDir: dir, cwd });
    sm.append({ type: "message", payload: user("u1") });
    const e2 = sm.append({ type: "message", payload: asst("a1") });
    const file = await soleSessionFile("torn");
    // 半行:无换行结尾的残缺 JSON(等价于进程死在 appendFileSync 中途)。
    await appendFile(file, '{"type":"message","id":"deadbeef","parent');

    const reopened = SessionManager.open({ baseDir: dir, cwd });
    expect(reopened.rebuild().messages).toEqual([user("u1"), asst("a1")]);

    const e3 = reopened.append({ type: "message", payload: user("u2") });
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(4); // header + u1 + a1 + u2:半行被截,不留残迹
    expect(parse(lines[3]!)).toMatchObject({ id: e3.id, parentId: e2.id });
  });

  it("AC-M2-4 open({sessionId}) 挑指定历史会话(非最新)→ 重建该会话,不碰最新那个:H1 --resume 路径", async () => {
    const cwd = join(dir, "pick");
    const older = new SessionManager({ baseDir: dir, cwd });
    older.append({ type: "message", payload: user("老会话") });
    const sub = (await readdir(dir)).find((s) => s.includes("pick"))!;
    const olderFile = (await readdir(join(dir, sub))).find((f) => f.endsWith(".jsonl"))!;
    const olderId = olderFile.slice(0, -".jsonl".length).split("_").pop()!;

    // mtime 粒度 = 前提:同 ms 建两个会话时"最近"无定义,impl 只能按名字兜底。
    await new Promise((r) => setTimeout(r, 5));
    const newer = new SessionManager({ baseDir: dir, cwd });
    newer.append({ type: "message", payload: user("新会话") });

    expect(SessionManager.open({ baseDir: dir, cwd }).rebuild().messages).toEqual([user("新会话")]);
    expect(
      SessionManager.open({ baseDir: dir, cwd, sessionId: olderId }).rebuild().messages,
    ).toEqual([user("老会话")]);
    // 挑历史不得往最新会话写任何东西
    expect((await readdir(join(dir, sub))).filter((f) => f.endsWith(".jsonl"))).toHaveLength(2);
  });
});

// H1 装配发现:全新机器(~/.mini 不存在)首次运行 = open 的正路,不是异常。
// 原实现 readdirSync 直接 ENOENT 抛穿 harness;修 = 目录缺失按"无历史"处理。
describe("M2 open:无任何历史(首次运行)", () => {
  it("open({baseDir,cwd}) 不抛 → rebuild 空 → append 首建 jsonl → 历史可读", () => {
    const cwd = join(dir, "first");
    const sm = SessionManager.open({ baseDir: dir, cwd });
    expect(sm.rebuild().messages).toEqual([]);

    sm.append({ type: "message", payload: user("u1") });
    expect(sm.rebuild().messages).toEqual([user("u1")]);
  });
});

describe("M2 rebuild:中间坏行抛错", () => {
  it("AC-M2-4 非末行 JSON 不可 parse(文件真坏了)→ rebuild 抛错,不静默丢历史", async () => {
    const cwd = join(dir, "rot");
    const sm = new SessionManager({ baseDir: dir, cwd });
    sm.append({ type: "message", payload: user("u1") });
    sm.append({ type: "message", payload: asst("a1") }); // 坏了首条 entry = 坏中间行(末行仍完好)
    const file = await soleSessionFile("rot");
    const body = await readFile(file, "utf8");
    await writeFile(file, body.replace('"type":"message"', '"type":"mess"{'));

    expect(() => SessionManager.open({ baseDir: dir, cwd }).rebuild()).toThrowError();
  });
});

async function* fakeStream(): AsyncGenerator<ProviderEvent> {
  yield { type: "start" };
  yield { type: "text_delta", delta: "ok" };
  yield { type: "done", stopReason: "stop" };
}

describe("M2 rebuild 喂 runLoop", () => {
  it("AC-M2-3 rebuild().messages 当 LoopContext.messages → runLoop(假流) 跑完一轮:agent_end 出现、provider 只看到重建的 2 条(model_change 不入 provider)、末态 3 条", async () => {
    const cwd = join(dir, "feedloop");
    const sm = new SessionManager({ baseDir: dir, cwd });
    sm.append({ type: "message", payload: user("u1") });
    sm.append({ type: "model_change", payload: { model: "gpt-4o" } });
    sm.append({ type: "message", payload: asst("a1") });
    const rebuilt = sm.rebuild();

    let seen: AgentMessage[] | undefined;
    const streamFn: StreamFn = (ctx) => {
      seen = [...ctx.messages];
      return fakeStream();
    };
    const context: LoopContext = { messages: rebuilt.messages };
    const events: AgentEvent[] = [];
    for await (const ev of runLoop(streamFn, [], context, {})) events.push(ev);

    expect(events.some((e) => e.type === "agent_end")).toBe(true);
    expect(seen).toEqual([user("u1"), asst("a1")]);
    expect(context.messages).toHaveLength(3); // 重建 2 条 + 本轮 assistant
  });
});

describe("M2 append-only:旧行永不删", () => {
  it("AC-M2-5 线性 append / 分支 append / rebuild(旧 leaf) / rebuild() / open() 全程:行数单调非减 + 已有行逐字不变", async () => {
    const cwd = join(dir, "appendonly");
    const sm = new SessionManager({ baseDir: dir, cwd });
    const root = sm.append({ type: "message", payload: user("u1") });
    const file = await soleSessionFile("appendonly");

    const ops: (() => unknown)[] = [
      () => sm.append({ type: "message", payload: asst("x1") }),
      () => sm.append({ type: "message", payload: asst("x2"), parentId: root.id }),
      () => sm.rebuild(root.id),
      () => sm.rebuild(),
      () => SessionManager.open({ baseDir: dir, cwd }).rebuild(),
    ];

    let prev = (await readFile(file, "utf8")).trimEnd().split("\n");
    for (const op of ops) {
      op();
      const now = (await readFile(file, "utf8")).trimEnd().split("\n");
      expect(now.length).toBeGreaterThanOrEqual(prev.length); // 行数只增不减
      expect(now.slice(0, prev.length)).toEqual(prev); // 旧行不得被删/重写(比计数更强)
      prev = now;
    }
  });
});

describe("M2 rebuild:未知 leaf", () => {
  it("AC-M2-2 rebuild(不存在的 leafId)→ 抛错并带上那个 id,不静默返回空历史(空历史会被 H1 当成新会话续写)", async () => {
    const cwd = join(dir, "badleaf");
    const sm = new SessionManager({ baseDir: dir, cwd });
    sm.append({ type: "message", payload: user("u1") });
    expect(() => sm.rebuild("ffffffff")).toThrowError(/ffffffff/);
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

// ================= M3 compaction =================

const asstU = (t: string, pt: number, ct: number): AssistantMessage => ({
  ...asst(t),
  usage: { prompt_tokens: pt, completion_tokens: ct },
});

describe("M3 compact:触发阈值", () => {
  it("AC-M3-2 累计 usage 40000 > 50000−16384 → 触发:写 compaction entry(摘要进 payload);累计 7000 → 返回 null、summarizeFn 不调用、文件一字不动", async () => {
    const cwd = join(dir, "trig");
    const sm = new SessionManager({ baseDir: dir, cwd });
    sm.append({ type: "message", payload: user("u1") });
    sm.append({ type: "message", payload: asstU("a1", 30000, 10000) }); // prompt+completion 合计 40000

    const entry = await sm.compact({ contextWindow: 50000, summarizeFn: () => "摘要T" });
    expect(entry).not.toBeNull();
    expect(entry!.type).toBe("compaction");

    const file = await soleSessionFile("trig");
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(4); // header + 旧 2 行不动 + compaction 新行
    const last = parse(lines[3]!);
    expect(last["id"]).toBe(entry!.id);
    expect(last).toMatchObject({ type: "compaction", payload: { summary: "摘要T" } });

    // 不触发例:7000 ≪ 33616 → null,零副作用
    const sm2 = new SessionManager({ baseDir: dir, cwd: join(dir, "trig2") });
    sm2.append({ type: "message", payload: user("u1") });
    sm2.append({ type: "message", payload: asstU("a1", 5000, 2000) });
    const file2 = await soleSessionFile("trig2");
    expect(
      await sm2.compact({
        contextWindow: 50000,
        summarizeFn: () => {
          throw new Error("不触发却调用了 summarizeFn");
        },
      }),
    ).toBeNull();
    const lines2 = (await readFile(file2, "utf8")).trimEnd().split("\n");
    expect(lines2).toHaveLength(3); // header+u1+a1 原样;
  });
});

describe("M3 compact:切点 firstKeptEntryId + rebuild 窗口", () => {
  it("AC-M3-3 tokenOf=1000、keepRecent=2500 → firstKeptEntryId=倒数第2条;summarizeFn 只收被弃旧段;compact 后 append → rebuild = 摘要+保留段+新行;旧行逐字不删", async () => {
    const cwd = join(dir, "cut");
    const sm = new SessionManager({ baseDir: dir, cwd });
    const ids: string[] = [];
    for (let i = 0; i < 24; i++)
      ids.push(sm.append({ type: "message", payload: user(`m${i}`) }).id);
    ids.push(sm.append({ type: "message", payload: asstU("m24", 40000, 0) }).id); // usage 供触发阈值
    const file = await soleSessionFile("cut");
    const before = (await readFile(file, "utf8")).trimEnd().split("\n");

    let got: AgentMessage[] | undefined;
    const entry = await sm.compact({
      contextWindow: 50000,
      keepRecent: 2500,
      tokenOf: () => 1000,
      summarizeFn: (old) => {
        got = old;
        return "摘要X";
      },
    });
    expect(entry).not.toBeNull();
    // 从近往远:1000(m24)+1000(m23)=2000 ≤2500,再加 m22 → 3000 超 → 切点 = m23
    const comp = parse((await readFile(file, "utf8")).trimEnd().split("\n").at(-1)!);
    expect(comp["payload"]).toMatchObject({ summary: "摘要X", firstKeptEntryId: ids[23] });
    // 被弃旧段 = m0..m22(摘要只该看到刀口之前的)
    expect(got).toEqual(Array.from({ length: 23 }, (_, i) => user(`m${i}`)));

    sm.append({ type: "message", payload: user("新行") });
    expect(sm.rebuild().messages).toEqual([
      user("摘要X"),
      user("m23"),
      asstU("m24", 40000, 0),
      user("新行"),
    ]);

    const after = (await readFile(file, "utf8")).trimEnd().split("\n");
    expect(after.length).toBe(before.length + 2); // +compaction +新行
    expect(after.slice(0, before.length)).toEqual(before); // Must not:旧行被删
  });
});

const asstCall = (id: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name: "read", arguments: { path: "a" } }],
  stopReason: "tool_use",
});
const callU = (id: string): AssistantMessage => ({
  ...asstCall(id),
  usage: { prompt_tokens: 40000, completion_tokens: 0 },
});
const tr = (id: string) => ({
  role: "toolResult" as const,
  toolCallId: id,
  toolName: "read",
  content: [{ type: "text" as const, text: "ok" }],
  isError: false,
});

describe("M3 compact:刀口不劈配对", () => {
  it("AC-M3-4 预算断在 toolResult 上 → 切点回退到配对 assistant;保留段 toolCall/toolResult 成对;旧段 = 刀口前全部", async () => {
    const cwd = join(dir, "pair");
    const sm = new SessionManager({ baseDir: dir, cwd });
    const ids = [
      sm.append({ type: "message", payload: user("u0") }).id,
      sm.append({ type: "message", payload: asstCall("t1") }).id,
      sm.append({ type: "message", payload: tr("t1") }).id,
      sm.append({ type: "message", payload: user("u3") }).id,
      sm.append({ type: "message", payload: callU("t2") }).id, // 触发阈值(usage 40000)
      sm.append({ type: "message", payload: tr("t2") }).id,
    ];
    const file = await soleSessionFile("pair");

    let got: AgentMessage[] | undefined;
    await sm.compact({
      contextWindow: 50000,
      keepRecent: 1600,
      // 天真累计:tr(t2)=1500 收下后 asst(t2)=700 → 2200 超 → 刀口本应落在 toolResult(t2) = 劈配对
      tokenOf: (m) => (m.role === "toolResult" ? 1500 : m.role === "assistant" ? 700 : 100),
      summarizeFn: (old) => {
        got = old;
        return "摘要P";
      },
    });
    const comp = parse((await readFile(file, "utf8")).trimEnd().split("\n").at(-1)!);
    expect(comp["payload"]).toMatchObject({ summary: "摘要P", firstKeptEntryId: ids[4] });
    expect(got).toEqual([user("u0"), asstCall("t1"), tr("t1"), user("u3")]);
    // 热替换窗口:摘要 + 完整配对
    expect(sm.rebuild().messages).toEqual([user("摘要P"), callU("t2"), tr("t2")]);
  });
});

// ================= M4 纪要七段 + 增量合并 + 拒压 =================

const SECTIONS = [
  "目的",
  "做到哪了",
  "关键要点",
  "引用文件",
  "关键决定",
  "下一步",
  "关键背景",
] as const;
const SEVEN = SECTIONS.map((s) => `## ${s}\n(内容略)`).join("\n");

describe("M4 纪要七段 + prompt 单源", () => {
  it("AC-M4-2 假 summarizeFn 的七段中文原样进 payload 与 rebuild 摘要行;SUMMARY_SECTIONS = 七段单源;buildSummarizePrompt 含七段标题,带旧纪要再含 UPDATE 合并指令", async () => {
    const cwd = join(dir, "seven");
    const sm = new SessionManager({ baseDir: dir, cwd });
    sm.append({ type: "message", payload: user("u1") });
    sm.append({ type: "message", payload: asstU("a1", 40000, 0) });

    // 每条 100:a1 收下(=100≤150),u1 使累计 200 超预算 → 刀口 = a1,保留段 1 条(避开 M3 全弃路径)。
    await sm.compact({
      contextWindow: 50000,
      keepRecent: 150,
      tokenOf: () => 100,
      summarizeFn: () => SEVEN,
    });

    // 纪要七段原样流转:盘上 payload.summary + rebuild 投影摘要行都含全部七段标题。
    const file = await soleSessionFile("seven");
    const comp = parse((await readFile(file, "utf8")).trimEnd().split("\n").at(-1)!);
    const summary = (comp.payload as { summary: string }).summary;
    for (const s of SECTIONS) expect(summary).toContain(`## ${s}`);
    const rebuilt = sm.rebuild().messages;
    expect(rebuilt).toHaveLength(2); // 摘要行 + 保留段(a1 单条 ≤ keepRecent)
    for (const s of SECTIONS) expect((rebuilt[0] as UserMessage).content).toContain(`## ${s}`);

    // 七段标题源码单源。
    expect(SUMMARY_SECTIONS).toEqual(SECTIONS);

    // prompt builder:无旧纪要 = 从零生成指令,含七段标题;有旧纪要 = UPDATE 合并指令。
    const fresh = buildSummarizePrompt();
    for (const s of SECTIONS) expect(fresh).toContain(s);
    const merged = buildSummarizePrompt("旧纪要文本");
    for (const s of SECTIONS) expect(merged).toContain(s);
    expect(merged).toContain("旧纪要文本");
    expect(merged).toContain("合并");
  });
});

describe("M4 二次压缩:增量合并(纪要恒一份)", () => {
  it("AC-M4-3 第二次 compact 的 summarizeFn 收 previousSummary = 首轮纪要、toSummarize = 仅首轮刀口后新入弃段(首轮弃段不重发);rebuild 摘要行恒一;盘上 2 条 compaction entry、旧行逐字不变", async () => {
    const cwd = join(dir, "merge2");
    const sm = new SessionManager({ baseDir: dir, cwd });
    const ids: string[] = [];
    for (let i = 0; i < 10; i++)
      ids.push(sm.append({ type: "message", payload: user(`m${i}`) }).id);
    ids.push(sm.append({ type: "message", payload: asstU("m10", 40000, 0) }).id); // 40000 > 50000−16384 → 触发

    const calls: { old: AgentMessage[]; prev: string | undefined }[] = [];
    const opts = {
      contextWindow: 50000,
      keepRecent: 250,
      tokenOf: () => 100,
      summarizeFn: (old: AgentMessage[], previousSummary?: string) => {
        calls.push({ old, prev: previousSummary });
        return previousSummary === undefined ? "第一轮回要" : "合并纪要";
      },
    };

    // 首轮:近往远 m10(100)+m9(200),m8 使 300>250 → 刀口 = m9,弃 m0..m8。
    await sm.compact(opts);
    expect(calls[0]!.prev).toBeUndefined();
    expect(calls[0]!.old).toEqual(Array.from({ length: 9 }, (_, i) => user(`m${i}`)));
    const file = await soleSessionFile("merge2");
    const snap = (await readFile(file, "utf8")).trimEnd().split("\n");
    const keptOf = (line: string) =>
      (parse(line).payload as { firstKeptEntryId: string | null }).firstKeptEntryId;
    expect(keptOf(snap.at(-1)!)).toBe(ids[9]);

    // 压缩后继续对话:a12 usage = 压缩后窗口的 provider 精确数(触发口径)。
    ids.push(sm.append({ type: "message", payload: user("m11") }).id);
    ids.push(sm.append({ type: "message", payload: asstU("a12", 40000, 0) }).id);

    // 二轮(可弃窗 = 首轮保留段 m9 起):a12(100)+m11(200),m10 使 300>250 → 刀口 = m11。
    await sm.compact(opts);
    // 红①:现实现单参调用 → prev 恒 undefined。
    expect(calls[1]!.prev).toBe("第一轮回要");
    // 红②:现实现会把首轮已弃 m0..m8 重发一遍。
    expect(calls[1]!.old).toEqual([user("m9"), asstU("m10", 40000, 0)]);
    expect(keptOf((await readFile(file, "utf8")).trimEnd().split("\n").at(-1)!)).toBe(ids[11]);

    sm.append({ type: "message", payload: user("新行") });
    // 投影纪要恒一 = 第二次 UPDATE 产物,首轮纪要被折叠覆盖、不堆叠。
    expect(sm.rebuild().messages).toEqual([
      user("合并纪要"),
      user("m11"),
      asstU("a12", 40000, 0),
      user("新行"),
    ]);

    const after = (await readFile(file, "utf8")).trimEnd().split("\n");
    expect(after.filter((l) => parse(l).type === "compaction")).toHaveLength(2); // append-only
    expect(after.slice(0, snap.length)).toEqual(snap); // 旧行逐字不变
  });
});

describe("M4 compact:旧段超窗拒压", () => {
  it("AC-M4-4 最近单条 tokenOf > keepRecent(压缩数学上救不了)→ 抛错提示手动处理;summarizeFn 零调用、文件一字不动(不全弃静默压 / 不删旧行)", async () => {
    const cwd = join(dir, "refuse");
    const sm = new SessionManager({ baseDir: dir, cwd });
    sm.append({ type: "message", payload: user("u0") });
    sm.append({ type: "message", payload: asstU("a1", 40000, 0) }); // usage 过触发阈值
    const file = await soleSessionFile("refuse");
    const before = (await readFile(file, "utf8")).trimEnd().split("\n");

    await expect(
      sm.compact({
        contextWindow: 50000,
        keepRecent: 50,
        tokenOf: () => 100, // 最近单条 100 > 50 → 无有效刀口
        summarizeFn: () => {
          throw new Error("拒压路径不得调用 summarizeFn");
        },
      }),
    ).rejects.toThrowError(/手动处理/);

    const after = (await readFile(file, "utf8")).trimEnd().split("\n");
    expect(after).toEqual(before); // 行数不减 + 旧行逐字不变
  });
});

describe("M4 compact:注入 summarizeFn 零网络", () => {
  it("AC-M4-5 触发压缩全程(阈值判定 + 切点 + 注入摘要)globalThis.fetch 零调用", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      const cwd = join(dir, "nonet");
      const sm = new SessionManager({ baseDir: dir, cwd });
      sm.append({ type: "message", payload: user("u1") });
      sm.append({ type: "message", payload: asstU("a1", 40000, 0) });

      await sm.compact({ contextWindow: 50000, summarizeFn: () => "摘要N" });

      expect(spy).not.toHaveBeenCalled();
      // 摘要确已进 payload(证明确实走了压缩而非静默 no-op)。
      const file = await soleSessionFile("nonet");
      const comp = parse((await readFile(file, "utf8")).trimEnd().split("\n").at(-1)!);
      expect((comp.payload as { summary: string }).summary).toBe("摘要N");
    } finally {
      spy.mockRestore();
    }
  });
});

// ================= H3 手动 /compact =================

describe("H3 compact:force 手动路径", () => {
  it("AC-H3-2 usage 远低阈值:不带 force 返 null 零副作用;{force:true} 照样压 —— summarizeFn 只收刀口前旧段,compaction 落盘,rebuild 投影摘要+保留段", async () => {
    const cwd = join(dir, "force");
    const sm = new SessionManager({ baseDir: dir, cwd });
    sm.append({ type: "message", payload: user("u1") });
    const keptId = sm.append({ type: "message", payload: asst("a1") }).id;
    const file = await soleSessionFile("force");
    const before = (await readFile(file, "utf8")).trimEnd().split("\n");

    // 不触发(usage 口径零条)→ null,与 M3 行为一致。
    expect(
      await sm.compact({
        contextWindow: 50000,
        summarizeFn: () => {
          throw new Error("非 force 未达阈值不得调用 summarizeFn");
        },
      }),
    ).toBeNull();
    expect((await readFile(file, "utf8")).trimEnd().split("\n")).toEqual(before);

    // force:跳阈值,切点/配对逻辑照旧(tokenOf=100、keepRecent=100 → 刀口 = a1,u1 入旧段)。
    let got: AgentMessage[] | undefined;
    const entry = await sm.compact({
      contextWindow: 50000,
      keepRecent: 100,
      tokenOf: () => 100,
      force: true,
      summarizeFn: (old) => {
        got = old;
        return "手动纪要";
      },
    });
    expect(entry).not.toBeNull();
    expect(got).toEqual([user("u1")]); // 只收被弃旧段
    const comp = parse((await readFile(file, "utf8")).trimEnd().split("\n").at(-1)!);
    expect(comp).toMatchObject({
      type: "compaction",
      payload: { summary: "手动纪要", firstKeptEntryId: keptId },
    });
    expect(sm.rebuild().messages).toEqual([user("手动纪要"), asst("a1")]);
  });
});
