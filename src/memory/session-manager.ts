// M1:SessionManager —— append-only JSONL 树(DECISIONS ③ M1/M2/M4)。
// 路径 <baseDir>/<cwd编码>/<时间>_<uuidv7>.jsonl;首行 header {type:"session",version:1,id,cwd};
// 写策略 = 首建 wx + 逐行 appendFileSync(即时落盘,崩溃可恢复);v1 entry 仅 5 种。
// M2 加:append 显式 parentId = 分支;rebuild(leafId) 沿 parentId 回溯;open() 换进程接回(torn 末行截回换行)。
// compaction 窗口投影 = M3。
import {
  existsSync,
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
import type { AgentMessage } from "../loop/types.ts";
import { repairDangling } from "./journal.ts";
import { filenameStamp } from "../util/time.ts";

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

export interface SessionManagerOptions {
  baseDir: string; // 生产 = ~/.mini/sessions;测试 = 临时目录(PRD S3 注入缝)
  cwd: string;
}

export interface SessionOpenOptions extends SessionManagerOptions {
  sessionId?: string; // 会话 uuidv7;缺省 = 时间戳最新
}

// H2 S-c list() 产物:--resume 编号选择器每行一条。
export interface SessionSummary {
  sessionId: string; // 文件名解析出的 uuidv7
  file: string; // 绝对路径
  mtimeMs: number; // 排序键(最新 = 最近使用)
  model?: string; // 末条 model_change 的 alias;未切过 = undefined
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
    // 目录不存在 = 这台机器还没跑过 mini(首次运行正路)→ 按"无历史"处理,不 ENOENT 抛穿调用方。
    // D2:同目录旁挂 `<会话>.trace.jsonl` 必须排除 —— trace mtime 恒新,不排除 = open()
    // 把它当"最新会话"接回,rebuild 炸行/续写假会话(D2 红测实证 .trace.trace.jsonl)。
    const names = existsSync(sm.dir)
      ? readdirSync(sm.dir)
          .filter((n) => n.endsWith(".jsonl") && !n.endsWith(".trace.jsonl"))
          .sort()
      : [];
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
      // 无 sessionId 且一条会话都没有 = 新开(H1 首次运行),首 append 才建文件;
      // 显式给了 sessionId 却找不到 = 必须抛,静默返空会被当成空会话续写(M2 判卷注)。
      if (opts.sessionId === undefined) return sm;
      throw new Error(`no session to resume under ${sm.dir} (id=${opts.sessionId})`);
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

  // H2 S-c:--resume 编号选择器数据源。列 <cwd编码>/ 下全部会话,最新在前(mtime 降序,
  // 同 ms 按名字降序兜底,口径同 open())。sessionId 从文件名 <时间>_<uuidv7>.jsonl 解析;
  // model = 该会话末条 model_change.payload.model(未切过则 undefined)。torn 末行跳过(选择器
  // 只读不修,损坏交给 open())。
  static list(opts: SessionManagerOptions): SessionSummary[] {
    const sm = new SessionManager(opts);
    if (!existsSync(sm.dir)) return [];
    const out: SessionSummary[] = [];
    for (const name of readdirSync(sm.dir)) {
      if (!name.endsWith(".jsonl") || name.endsWith(".trace.jsonl")) continue; // D2 旁挂不算会话
      const file = join(sm.dir, name);
      let model: string | undefined;
      for (const raw of readFileSync(file, "utf8").trimEnd().split("\n").slice(1)) {
        let e: SessionEntry & { payload?: { model?: string } };
        try {
          e = JSON.parse(raw);
        } catch {
          break; // torn 末行:停止扫描,保留已见 model
        }
        if (e.type === "model_change") model = e.payload?.model;
      }
      out.push({
        sessionId: name.slice(name.indexOf("_") + 1, name.length - ".jsonl".length),
        file,
        mtimeMs: statSync(file).mtimeMs,
        model,
      });
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.file < b.file ? 1 : -1));
    return out;
  }

  // D2(docs/ISSUES.md):trace JSONL 旁挂路径 = 会话文件同名换 `.trace.jsonl`。会话文件名含
  // uuidv7 且延迟首建(只在类内)→ 本 getter 是唯一知情出口。首 append 前 = null;
  // 纯推路径永不碰盘(落盘动作住 cli 订阅环,"接线只有 append" 裁决)。
  traceFile(): string | null {
    return this.file === null ? null : this.file.replace(/\.jsonl$/, ".trace.jsonl");
  }

  // parentId 缺省 = 续当前 leaf(线性);显式传 = 挂到旧 entry → 生成分支(M2)。
  append(input: { type: AppendableType; payload?: unknown; parentId?: string }): SessionEntry {
    if (!APPENDABLE.has(input.type)) {
      throw new Error(`unknown entry type: ${String(input.type)}`);
    }
    if (this.file === null) {
      const sessionId = uuidv7();
      this.file = join(this.dir, `${filenameStamp()}_${sessionId}.jsonl`);
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
  // M3 compaction 窗口:刀口(firstKeptEntryId)前的已投影段折叠成摘要,盘上旧行不删。
  rebuild(leafId?: string): { messages: AgentMessage[]; model?: string } {
    const messages: AgentMessage[] = [];
    // srcIds[i] = 第 i 条 message 的来源 entry id(摘要行 = null),供 compaction 截点定位。
    const srcIds: (string | null)[] = [];
    let model: string | undefined;
    if (this.file === null) return { messages, model };

    for (const e of this.leafPath(leafId)) {
      if (e.type === "message") {
        messages.push(e.payload as AgentMessage);
        srcIds.push(e.id);
      } else if (e.type === "model_change") {
        model = e.payload?.model;
      } else if (e.type === "compaction") {
        const p = e.payload as CompactionPayload;
        const cut = p.firstKeptEntryId === null ? -1 : srcIds.indexOf(p.firstKeptEntryId);
        const keptFrom = cut < 0 ? messages.length : cut; // null / 切点被更早 compaction 折叠 → 全折
        messages.splice(0, keptFrom, { role: "user", content: p.summary });
        srcIds.splice(0, keptFrom, null);
      }
    }
    // D1:出口悬空修复(journal.repairDangling,投影不写盘)。崩溃批次的 toolCall 补合成
    // isError 行 → 两方言 toWire 配对完整,--continue 不再必 400。loop/cli 零感知。
    return { messages: repairDangling(messages).messages, model };
  }

  // 磁盘 → 全 entry map → 从 leafId(缺省 = 末行)沿 parentId 回溯到根,正序返回(rebuild/compact 共用)。
  private leafPath(leafId?: string): (SessionEntry & { payload?: { model?: string } })[] {
    const lines = readFileSync(this.file!, "utf8").trimEnd().split("\n");
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
    return path;
  }

  // M3 compaction:触发 = 窗口 usage > contextWindow − reserve;产物 = compaction entry(append,旧行不删);
  // 切点 = 从近往远累计 tokenOf 至 keepRecent 处,刀口不劈 toolCall/toolResult 配对。
  // M4 增量合并:末条 compaction 定 floor(可弃窗下界 = 其保留段起点)与 previousSummary;
  // 触发口径 = 投影后窗口末条 assistant usage(弃段/旧纪要不再重复计入,否则压缩永不收敛)。
  async compact(opts: CompactOptions): Promise<SessionEntry | null> {
    if (this.file === null) return null;
    const path = this.leafPath();

    let floor = 0;
    let previousSummary: string | undefined;
    for (let i = path.length - 1; i >= 0; i--) {
      const e = path[i]!;
      if (e.type !== "compaction") continue;
      const p = e.payload as CompactionPayload;
      previousSummary = p.summary;
      // 保留段起点 = 可弃窗下界;保留段为空(null)或切点行不在本路径(换分支)→ 下界退为该 entry 之后。
      const k =
        p.firstKeptEntryId === null ? -1 : path.findIndex((x) => x.id === p.firstKeptEntryId);
      floor = k >= 0 ? k : i + 1;
      break;
    }

    let total = 0;
    for (let i = path.length - 1; i >= floor; i--) {
      const e = path[i]!;
      if (e.type !== "message") continue;
      const m = e.payload as AgentMessage;
      if (m.role === "assistant" && m.usage) {
        total = m.usage.prompt_tokens + m.usage.completion_tokens;
        break;
      }
    }
    const reserve = opts.reserve ?? DEFAULT_RESERVE;
    // H3:手动 /compact 走 force = 跳阈值照压;自动/缺省路径仍阈值门(AC-M3-2)。
    if (!opts.force && total <= opts.contextWindow - reserve) return null;

    // 切点:从近往远按 tokenOf 累计,首个放不进 keepRecent 预算的 message 即刀口(下界 = floor)。
    const tokenOf = opts.tokenOf ?? defaultTokenOf;
    const keepRecent = opts.keepRecent ?? DEFAULT_KEEP_RECENT;
    let acc = 0;
    let cut = path.length; // 保持 = 最近单条放不下 → 无有效刀口,见下拒压
    for (let i = path.length - 1; i >= floor; i--) {
      const e = path[i]!;
      if (e.type !== "message") continue;
      const t = tokenOf(e.payload as AgentMessage);
      if (acc + t > keepRecent) break;
      acc += t;
      cut = i;
    }
    // M4 拒压:保留段至少含最近一条,而它已超 keepRecent → 压缩数学上救不了 →
    // 报错提示手动处理,绝不全弃静默压(分段兜底见 DEFERRED)。
    if (cut === path.length) {
      throw new Error(
        `compaction refused: newest message exceeds keepRecent=${keepRecent} tokens,需手动处理(分段兜底见 DEFERRED)`,
      );
    }
    // 刀口不劈 toolCall/toolResult 配对:保留段首条是 toolResult(其 toolCall 在被弃段)→ 回退到该 assistant。
    while (cut > floor && cut < path.length) {
      const e = path[cut]!;
      if (e.type !== "message" || (e.payload as AgentMessage).role !== "toolResult") break;
      cut--;
    }
    // cut===floor = 可弃窗内全部塞得进 keepRecent 却仍触发阈值(usage 与体量解耦)→ 保留段为空,null 折叠全部。
    const keptEmpty = cut === floor;
    const firstKeptEntryId = keptEmpty ? null : path[cut]!.id;
    const old = path
      .slice(floor, keptEmpty ? path.length : cut)
      .filter((e) => e.type === "message")
      .map((e) => e.payload as AgentMessage);

    const summary = await opts.summarizeFn(old, previousSummary);
    return this.append({
      type: "compaction",
      payload: { summary, firstKeptEntryId } satisfies CompactionPayload,
    });
  }
}

// compaction entry payload:纪要文本 + 刀口(保留段首条 entry id;null = 保留段为空)。
export interface CompactionPayload {
  summary: string;
  firstKeptEntryId: string | null;
}

// 默认 token 估算 = pi estimateTokens 式启发(字符数/4 向上取整);精确计数不可得(无本地 tokenizer)。
function defaultTokenOf(m: AgentMessage): number {
  return Math.ceil(JSON.stringify(m).length / 4);
}

// DECISIONS ③ M3:触发 reserve 与切点 keepRecent 默认(128k 窗口约 112k 动刀)。
export const DEFAULT_RESERVE = 16384;
export const DEFAULT_KEEP_RECENT = 20000;

export interface CompactOptions {
  contextWindow: number;
  // 生产 = 同模型按 SUMMARY_SECTIONS 七段生成(M4);测试注入假函数 = 零网络。
  // previousSummary = 路径末条 compaction 的旧纪要(二次压缩 UPDATE 增量合并;首轮 = undefined)。
  summarizeFn: (toSummarize: AgentMessage[], previousSummary?: string) => string | Promise<string>;
  reserve?: number;
  keepRecent?: number;
  // H3 S-d:手动 /compact = true,跳阈值检查(切点/配对/拒压照旧)。缺省 false = 阈值门。
  force?: boolean;
  // 每 message token 估算(切点用);默认 pi 式启发 = chars/4 向上取整。
  tokenOf?: (message: AgentMessage) => number;
}
