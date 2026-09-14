// M1:SessionManager —— append-only JSONL 树(DECISIONS ③ M1/M2/M4)。
// 路径 <baseDir>/<cwd编码>/<时间>_<uuidv7>.jsonl;首行 header {type:"session",version:1,id,cwd};
// 写策略 = 首建 wx + 逐行 appendFileSync(即时落盘,崩溃可恢复);v1 entry 仅 5 种。
// 多分支 leaf 回溯 / compaction 窗口 = M2/M3,此处不留接口空位。
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
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

export class SessionManager {
  private readonly dir: string;
  private readonly cwd: string;
  private file: string | null = null; // 延迟首建:第一次 append 才落盘
  private leafId: string | null = null;

  constructor(opts: SessionManagerOptions) {
    this.cwd = opts.cwd;
    this.dir = join(opts.baseDir, encodeCwd(opts.cwd));
  }

  append(input: { type: AppendableType; payload?: unknown }): SessionEntry {
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
      parentId: this.leafId,
      ts: Date.now(),
      payload: input.payload,
    };
    this.leafId = entry.id;
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  // M1 最小线性 rebuild(用户确认,判卷注记):读盘全部行(磁盘 = 真相源)→
  // message 投影 messages、model = 末条 model_change.payload.model。
  // 多分支 leaf 回溯 = M2;compaction 窗口投影 = M3。
  rebuild(): { messages: AgentMessage[]; model?: string } {
    const messages: AgentMessage[] = [];
    let model: string | undefined;
    if (this.file !== null) {
      const lines = readFileSync(this.file, "utf8").trimEnd().split("\n");
      for (const raw of lines.slice(1)) {
        // skip header
        const e = JSON.parse(raw) as SessionEntry & { payload?: { model?: string } };
        if (e.type === "message") messages.push(e.payload as AgentMessage);
        else if (e.type === "model_change") model = e.payload?.model;
      }
    }
    return { messages, model };
  }
}
