// M1:SessionManager —— append-only JSONL 树(DECISIONS ③ M1/M2/M4)。
// 路径 <baseDir>/<cwd编码>/<时间>_<uuidv7>.jsonl;首行 header {type:"session",version:1,id,cwd};
// 写策略 = 首建 wx + 逐行 appendFileSync(即时落盘,崩溃可恢复);v1 entry 仅 5 种。
// M2 加:append 显式 parentId = 分支;rebuild(leafId) 沿 parentId 回溯;open() 换进程接回(torn 末行截回换行)。
// compaction 窗口投影 = M3。
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  statSync,
  truncateSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AgentMessage } from "../loop/types.js";

export interface SessionHeader {
  type: "session";
  version: 1;
  id: string; // = 文件名里的 session uuidv7
  cwd: string;
}

// header 只由首建自动写;append() 可写的 entry 类型(5 种减 header)。
export type AppendableType = "message" | "model_change" | "compaction" | "session_info";

export interface SessionEntry {
  type: AppendableType;
  id: string; // 8 位 hex(照 pi)
  parentId: string | null; // 链回前驱;首条 = header.id
  ts: number; // epoch ms
  payload?: unknown;
}

const APPENDABLE: ReadonlySet<string> = new Set([
  "message",
  "model_change",
  "compaction",
  "session_info",
]);

// node v24 crypto.uuidV7 不存在(实测 undefined)→ 自写:48bit ms + 74bit random。
function uuidv7(): string {
  const b = randomBytes(16);
  let v = BigInt(Date.now());
  for (let i = 5; i >= 0; i--, v >>= 8n) b[i] = Number(v & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70; // version 7
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function encodeCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]+/g, "-");
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

export interface SessionManagerOptions {
  baseDir: string; // 生产 = ~/.mini/sessions;测试 = 临时目录(PRD S3 注入缝)
  cwd: string;
}

export interface SessionOpenOptions extends SessionManagerOptions {
  sessionId?: string; // 会话 uuidv7;缺省 = 时间戳最新
}

export class SessionManager {
  private readonly dir: string;
  private readonly cwd: string;
  private file: string | null = null; // 延迟首建:第一次 append 才落盘
  private leafId: string | null = null;

  constructor(opts: SessionManagerOptions) {
    this.cwd = opts.cwd;
    this.dir = join(opts.baseDir, encodeCwd(opts.cwd));
  }

  // M2 崩溃恢复:换进程按 baseDir+cwd 接回会话(最新 = mtime,见下方注)。
  // 只读盘恢复 file + leafId(末行 id;仅 header 时 = header.id 树根),不写不新建。
  // 无 sessionId = 最新会话(H1 --continue);有则按 <时间>_<sessionId>.jsonl 精确挑(--resume)。
  static open(opts: SessionOpenOptions): SessionManager {
    const sm = new SessionManager(opts);
    const names = readdirSync(sm.dir)
      .filter((n) => n.endsWith(".jsonl"))
      .sort();
    // 时间戳前缀只到秒 → 同秒两个会话(新建/测试快跑)字典序由 uuid 随机位决定,不可靠;
    // "最新"以 mtime 为准(续写也会刷新 mtime = 最近使用),同 ms 再按名字降序兜底。
    let name: string | undefined;
    if (opts.sessionId === undefined) {
      name = names
        .map((n) => ({ n, t: statSync(join(sm.dir, n)).mtimeMs }))
        .sort((a, b) => b.t - a.t || (a.n < b.n ? 1 : -1))[0]?.n;
    } else {
      name = names.find((n) => n.endsWith(`_${opts.sessionId}.jsonl`));
    }
    if (name === undefined) {
      throw new Error(
        `no session to resume under ${sm.dir}${opts.sessionId ? ` (id=${opts.sessionId})` : ""}`,
      );
    }
    const file = join(sm.dir, name);
    let raw = readFileSync(file, "utf8");
    if (!raw.endsWith("\n")) {
      // torn 末行:进程死在 appendFileSync 中途。半行从未提交成 entry,
      // 截回最后一个换行 = 回到崩溃前的一致状态(不是"删旧行")。
      const end = raw.lastIndexOf("\n");
      if (end < 0) throw new Error(`session file has no complete line: ${file}`);
      truncateSync(file, end + 1);
      raw = raw.slice(0, end + 1);
    }
    const lines = raw.trimEnd().split("\n");
    sm.file = file;
    sm.leafId = (JSON.parse(lines[lines.length - 1]!) as { id: string }).id;
    return sm;
  }

  // parentId 缺省 = 续当前 leaf(线性);显式传 = 挂到旧 entry → 生成分支(M2)。
  append(input: { type: AppendableType; payload?: unknown; parentId?: string }): SessionEntry {
    if (!APPENDABLE.has(input.type)) {
      throw new Error(`unknown entry type: ${String(input.type)}`);
    }
    if (this.file === null) {
      const sessionId = uuidv7();
      this.file = join(this.dir, `${stamp()}_${sessionId}.jsonl`);
      mkdirSync(this.dir, { recursive: true });
      const header: SessionHeader = { type: "session", version: 1, id: sessionId, cwd: this.cwd };
      this.leafId = header.id; // 首条 entry 的 parentId = header.id(树根)
      // wx:同秒撞名(fork/并发)直接报错,绝不覆盖旧会话(旧行永不删)。
      writeFileSync(this.file, `${JSON.stringify(header)}\n`, { flag: "wx" });
    }
    const entry: SessionEntry = {
      type: input.type,
      id: randomBytes(4).toString("hex"),
      parentId: input.parentId ?? this.leafId,
      ts: Date.now(),
      payload: input.payload,
    };
    this.leafId = entry.id;
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  // M2 rebuild:读盘全部行(磁盘 = 真相源)→ 从 leaf 沿 parentId 回溯到根(header.id = 根哨兵)
  // → 路径正序投影 message 进 messages、路径上末条 model_change 定 model。
  // leafId 缺省 = 文件末行 entry(= 最新写入的 leaf,线性会话下与 M1 行为一致)。
  // compaction 窗口投影 = M3。
  rebuild(leafId?: string): { messages: AgentMessage[]; model?: string } {
    const messages: AgentMessage[] = [];
    let model: string | undefined;
    if (this.file === null) return { messages, model };

    const lines = readFileSync(this.file, "utf8").trimEnd().split("\n");
    const header = JSON.parse(lines[0]!) as SessionHeader;
    const byId = new Map<string, SessionEntry & { payload?: { model?: string } }>();
    let curId: string | null = header.id; // 末行 entry id;仅 header 时停在根
    for (const raw of lines.slice(1)) {
      const e = JSON.parse(raw) as SessionEntry & { payload?: { model?: string } };
      byId.set(e.id, e);
      curId = e.id;
    }

    const path: (SessionEntry & { payload?: { model?: string } })[] = [];
    for (let id: string | null = leafId ?? curId; id !== null && id !== header.id;) {
      const e = byId.get(id);
      // 未知 leaf / 断链:静默返空会被调用方当成"空会话"续写 → 历史被绕开,必须抛。
      if (e === undefined) throw new Error(`unknown leaf: ${id} in ${this.file}`);
      path.push(e);
      id = e.parentId;
    }
    path.reverse();
    for (const e of path) {
      if (e.type === "message") messages.push(e.payload as AgentMessage);
      else if (e.type === "model_change") model = e.payload?.model;
    }
    return { messages, model };
  }
}
