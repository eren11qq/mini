// C19(docs/ISSUES.md)行级 diff 纯叶:零项目 import(类型住这家,向上被 tools/tui 引用)。
// 算法(卡钉,非 Myers):掐公共前后缀 → 中段 LCS DP(Int32Array 全表 + 回溯;>250k 格退化
// 全删全增);hunk = 变更行 ±CTX 上下文,岛间 gap ≤ 2·CTX+1 并带。
// added/removed = LCS 行流 ± 计数(非中段宽度,公共 k 行不算变更)。1-based 行锚(同 git @@ 头)。零 npm 红线内手撕。
export interface DiffRow {
  t: "+" | "-" | " ";
  s: string;
}
export interface DiffHunk {
  oldStart: number;
  newStart: number;
  rows: DiffRow[];
}
export interface DiffDetails {
  kind: "diff";
  path: string;
  added: number;
  removed: number;
  hunks: DiffHunk[];
  truncated?: boolean;
}
export type ToolDetails = DiffDetails | { kind: "out"; text: string }; // C21 消费,本片只定形状

const CTX = 2;
// 存 hunk 行封顶(卡钉):计数在截断前已统计 → 截后仍全量。
const ROW_CAP = 180;

// 中段 LCS → 行流(相等记 " ",平局先删后增 = −/+ 成对读感)。
// 积 >250k 格退化全删全增(卡钉:仍正确,计数恒全量;四倍代码换不来 ctx=2 预览可感知的最小性)。
function lcsRows(a: string[], b: string[]): DiffRow[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 250_000) {
    return [...a.map((s) => ({ t: "-" as const, s })), ...b.map((s) => ({ t: "+" as const, s }))];
  }
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  const g = (i: number, j: number): number => dp[i * w + j]!; // 越界恒有格(表含尾行列)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * w + j] = a[i] === b[j] ? g(i + 1, j + 1) + 1 : Math.max(g(i + 1, j), g(i, j + 1));
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ t: " ", s: a[i]! });
      i++;
      j++;
    } else if (g(i + 1, j) >= g(i, j + 1)) {
      rows.push({ t: "-", s: a[i]! });
      i++;
    } else {
      rows.push({ t: "+", s: b[j]! });
      j++;
    }
  }
  while (i < n) rows.push({ t: "-", s: a[i++]! });
  while (j < m) rows.push({ t: "+", s: b[j++]! });
  return rows;
}

// 带绝对行锚的行流(oi/ni 0-based;hunk 起点 = 首行锚 +1)。
type LRow = DiffRow & { oi: number; ni: number };

export function diffDetails(path: string, oldText: string, newText: string): DiffDetails {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const rows: LRow[] = [];
  for (let k = Math.max(0, p - CTX); k < p; k++) rows.push({ t: " ", s: a[k]!, oi: k, ni: k });
  let i = p;
  let j = p;
  let removed = 0;
  let added = 0;
  // 每行双坐标齐全(− 行 ni=当前 j 不自增,反之亦然)→ hunk 首行即使是 ± 行,两锚也有值。
  for (const r of lcsRows(a.slice(p, a.length - s), b.slice(p, b.length - s))) {
    if (r.t === " ") rows.push({ ...r, oi: i++, ni: j++ });
    else if (r.t === "-") {
      rows.push({ ...r, oi: i++, ni: j });
      removed++;
    } else {
      rows.push({ ...r, oi: i, ni: j++ });
      added++;
    }
  }
  for (let k = 0; k < CTX && a.length - s + k < a.length; k++)
    rows.push({ t: " ", s: a[a.length - s + k]!, oi: a.length - s + k, ni: b.length - s + k });

  const truncated = rows.length > ROW_CAP;
  if (truncated) rows.length = ROW_CAP;

  // 变更岛(gap ≤ 2·CTX+1 并带)→ 每岛窗 ±CTX 切 hunk。
  const islands: [number, number][] = [];
  for (let k = 0; k < rows.length; k++) {
    if (rows[k]!.t === " ") continue;
    const prev = islands[islands.length - 1];
    if (prev && k - prev[1] - 1 <= 2 * CTX + 1) prev[1] = k;
    else islands.push([k, k]);
  }
  const hunks: DiffHunk[] = islands.map(([lo, hi]) => {
    const slice = rows.slice(Math.max(0, lo - CTX), Math.min(rows.length, hi + CTX + 1));
    return {
      oldStart: slice[0]!.oi + 1,
      newStart: slice[0]!.ni + 1,
      rows: slice.map(({ t, s }) => ({ t, s })),
    };
  });
  return { kind: "diff", path, added, removed, hunks, ...(truncated ? { truncated: true } : {}) };
}
