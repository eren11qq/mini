// C19(docs/ISSUES.md)行级 diff 纯叶自动测:期望 = 手算字面行(独立事实源,非实现复算)。
// 公共面 = diffDetails 整体返回形状(toEqual 一条钉死 kind/path/计数/hunks/truncated 缺省)。
// 锚点约定:hunk 起止 1-based(同 git @@ 头);窗口 = 变更行 ±2 上下文(CTX=2,卡钉)。
import { describe, expect, it } from "vitest";
import { diffDetails } from "./diff.ts";

const J = (lines: string[]): string => lines.join("\n");
const rng = (n: number, f: (i: number) => string): string[] =>
  Array.from({ length: n }, (_, i) => f(i));

describe("C19 util/diff:行级 diff", () => {
  it("纯增:中段插 1 行 → 单 hunk,变更行 ±2 上下文(尾行 epsilon 窗外),计数精确", () => {
    const old = J(["alpha", "beta", "gamma", "delta", "epsilon"]);
    const next = J(["alpha", "beta", "new", "gamma", "delta", "epsilon"]);

    expect(diffDetails("p", old, next)).toEqual({
      kind: "diff",
      path: "p",
      added: 1,
      removed: 0,
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          rows: [
            { t: " ", s: "alpha" },
            { t: " ", s: "beta" },
            { t: "+", s: "new" },
            { t: " ", s: "gamma" },
            { t: " ", s: "delta" },
          ],
        },
      ],
    });
  });

  it("中段替换:1 行换 1 行 → −/+ 成对、两侧 ctx,计数各 1", () => {
    const old = J(["x1", "x2", "target", "x4", "x5", "x6"]);
    const next = J(["x1", "x2", "REPL", "x4", "x5", "x6"]);

    expect(diffDetails("p", old, next)).toEqual({
      kind: "diff",
      path: "p",
      added: 1,
      removed: 1,
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          rows: [
            { t: " ", s: "x1" },
            { t: " ", s: "x2" },
            { t: "-", s: "target" },
            { t: "+", s: "REPL" },
            { t: " ", s: "x4" },
            { t: " ", s: "x5" },
          ],
        },
      ],
    });
  });

  it("两变更岛 gap=5(=2·ctx+1 边界)→ 并成单 hunk,中间 k 行全为 ctx(需 LCS)", () => {
    const old = J(["L0", "OLD2", "k1", "k2", "k3", "k4", "k5", "OLD8", "L8", "L9"]);
    const next = J(["L0", "NEW2", "k1", "k2", "k3", "k4", "k5", "NEW8", "L8", "L9"]);

    expect(diffDetails("p", old, next)).toEqual({
      kind: "diff",
      path: "p",
      added: 2,
      removed: 2,
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          rows: [
            { t: " ", s: "L0" },
            { t: "-", s: "OLD2" },
            { t: "+", s: "NEW2" },
            { t: " ", s: "k1" },
            { t: " ", s: "k2" },
            { t: " ", s: "k3" },
            { t: " ", s: "k4" },
            { t: " ", s: "k5" },
            { t: "-", s: "OLD8" },
            { t: "+", s: "NEW8" },
            { t: " ", s: "L8" },
            { t: " ", s: "L9" },
          ],
        },
      ],
    });
  });

  it("两岛 gap=6(>2·ctx+1)→ 拆两 hunk,窗各 ±2,中间 k3/k4 不存", () => {
    const old = J(["L0", "OLD2", "k1", "k2", "k3", "k4", "k5", "k6", "OLD9", "L9", "L10"]);
    const next = J(["L0", "NEW2", "k1", "k2", "k3", "k4", "k5", "k6", "NEW9", "L9", "L10"]);

    expect(diffDetails("p", old, next)).toEqual({
      kind: "diff",
      path: "p",
      added: 2,
      removed: 2,
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          rows: [
            { t: " ", s: "L0" },
            { t: "-", s: "OLD2" },
            { t: "+", s: "NEW2" },
            { t: " ", s: "k1" },
            { t: " ", s: "k2" },
          ],
        },
        {
          oldStart: 7,
          newStart: 7,
          rows: [
            { t: " ", s: "k5" },
            { t: " ", s: "k6" },
            { t: "-", s: "OLD9" },
            { t: "+", s: "NEW9" },
            { t: " ", s: "L9" },
            { t: " ", s: "L10" },
          ],
        },
      ],
    });
  });

  it("纯删:中段删 1 行 → 单 hunk,− 行 + 两侧 ±2 上下文,计数精确", () => {
    const old = J(["one", "two", "three", "four", "five"]);
    const next = J(["one", "two", "four", "five"]);

    expect(diffDetails("p", old, next)).toEqual({
      kind: "diff",
      path: "p",
      added: 0,
      removed: 1,
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          rows: [
            { t: " ", s: "one" },
            { t: " ", s: "two" },
            { t: "-", s: "three" },
            { t: " ", s: "four" },
            { t: " ", s: "five" },
          ],
        },
      ],
    });
  });

  it("存 hunk 行封顶 180 → truncated:true,计数仍全量(100 换 100 → 存 180 行,首窗逐行钉)", () => {
    const old = J(["P1", ...rng(100, (i) => `d${i + 1}`), "S1"]);
    const next = J(["P1", ...rng(100, (i) => `n${i + 1}`), "S1"]);

    const d = diffDetails("p", old, next);
    // 期望 = 手算:行流 = " P1" | −d1..−d100 | +n1..+n100 | " S1"(202 行)→ 存前 180。
    expect(d.kind).toBe("diff");
    expect(d.path).toBe("p");
    expect(d.added).toBe(100);
    expect(d.removed).toBe(100);
    expect(d.truncated).toBe(true);
    expect(d.hunks).toHaveLength(1);
    const rows = d.hunks[0]!.rows;
    expect(rows).toHaveLength(180);
    expect(rows[0]).toEqual({ t: " ", s: "P1" });
    expect(rows[1]).toEqual({ t: "-", s: "d1" });
    expect(rows[100]).toEqual({ t: "-", s: "d100" });
    expect(rows[101]).toEqual({ t: "+", s: "n1" });
    expect(rows[179]).toEqual({ t: "+", s: "n79" });
  });

  it("中段积 600×600 > 250k 格 → 退化全删全增:计数恒全量 600/600(非 LCS 的 301/301),存首 180 行无 +", () => {
    // 中段两端必异(否则被前后缀掐吃),内部 299 条奇数行相同 = LCS 路的诱饵:
    // LCS 跑则计数 301/301 且行流含 " o·" 行;退化路 = 600 全 − 后 600 全 +。
    const old = J(["P1", ...rng(600, (i) => `o${i}`), "S1"]);
    const next = J([
      "P1",
      ...rng(600, (i) => (i % 2 === 1 && i !== 599 ? `o${i}` : `x${i}`)),
      "S1",
    ]);

    const d = diffDetails("p", old, next);
    expect(d.added).toBe(600);
    expect(d.removed).toBe(600);
    expect(d.truncated).toBe(true);
    expect(d.hunks).toHaveLength(1);
    const rows = d.hunks[0]!.rows;
    expect(rows[0]).toEqual({ t: " ", s: "P1" });
    expect(rows[1]).toEqual({ t: "-", s: "o0" });
    expect(rows[179]).toEqual({ t: "-", s: "o178" }); // 全删段盖过整个存窗 → LCS 路必红在此
  });

  it("尾换行翻转双向 → 显 ± 空行(split 自然产物,不吞尾)", () => {
    expect(diffDetails("p", "a\nb\n", "a\nb")).toEqual({
      kind: "diff",
      path: "p",
      added: 0,
      removed: 1,
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          rows: [
            { t: " ", s: "a" },
            { t: " ", s: "b" },
            { t: "-", s: "" },
          ],
        },
      ],
    });
    expect(diffDetails("p", "a\nb", "a\nb\n")).toEqual({
      kind: "diff",
      path: "p",
      added: 1,
      removed: 0,
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          rows: [
            { t: " ", s: "a" },
            { t: " ", s: "b" },
            { t: "+", s: "" },
          ],
        },
      ],
    });
  });
});
