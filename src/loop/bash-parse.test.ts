import { describe, it, expect } from "vitest";
import { bashParse, seedOf } from "./bash-parse.ts";

// C3(docs/ISSUES.md):复合命令拆段。引号内的分隔符不是分隔符。
describe("bashParse — 拆段", () => {
  it("`git status && rm -rf ~/x` 拆 2 段", () => {
    const p = bashParse("git status && rm -rf ~/x");
    expect(p.ok && p.segments.map((s) => s.text)).toEqual(["git status", "rm -rf ~/x"]);
  });

  it('引号内 `&&` 不误拆:`echo "a && b"` 单段', () => {
    const p = bashParse('echo "a && b"');
    expect(p.ok && p.segments.map((s) => s.text)).toEqual(['echo "a && b"']);
  });

  it('未闭合引号 `git status && echo "oops` → ok:false,不崩', () => {
    expect(bashParse('git status && echo "oops').ok).toBe(false);
  });

  it("未闭合 `$( )` / 反引号同样 ok:false", () => {
    expect(bashParse("echo $(whoami").ok).toBe(false);
    expect(bashParse("echo `id").ok).toBe(false);
  });

  it("`;` `|` `||` 换行都拆段", () => {
    const p = bashParse("git add -A; git commit -m x | wc -l\ngit push || true");
    expect(p.ok && p.segments.map((s) => s.text)).toEqual([
      "git add -A",
      "git commit -m x",
      "wc -l",
      "git push",
      "true",
    ]);
  });
});

describe("bashParse — tokens 与 always 种子", () => {
  it('`git commit -m "x y"` tokens = [git, commit, -m, x y](引号剥离,引号内空格不切)', () => {
    const p = bashParse('git commit -m "x y"');
    expect(p.ok && p.segments[0]!.tokens).toEqual(["git", "commit", "-m", "x y"]);
  });

  it("seedOf = 前 2 token 家族;单 token 段退化为 1 个", () => {
    const p = bashParse("git commit -m x && ls");
    if (!p.ok) throw new Error("parse failed");
    expect(seedOf(p.segments[0]!)).toBe("git commit:*");
    expect(seedOf(p.segments[1]!)).toBe("ls:*");
  });
});

describe("bashParse — 重定向与命令替换标记", () => {
  it("`cat x > y` 段 redirect=true;`echo $(whoami)` / 反引号段 substitution=true", () => {
    const p = bashParse("cat x > y && echo $(whoami) && `id` -u && ls");
    if (!p.ok) throw new Error("parse failed");
    expect(p.segments.map((s) => s.redirect)).toEqual([true, false, false, false]);
    expect(p.segments.map((s) => s.substitution)).toEqual([false, true, true, false]);
  });

  it("单引号内 `>` `$(` 不算数;双引号内 `$(` 仍执行必标", () => {
    const s = bashParse("echo 'a > b $(x)'");
    if (!s.ok) throw new Error("parse failed");
    expect([s.segments[0]!.redirect, s.segments[0]!.substitution]).toEqual([false, false]);
    const d = bashParse('echo "a > b $(x)"');
    if (!d.ok) throw new Error("parse failed");
    expect([d.segments[0]!.redirect, d.segments[0]!.substitution]).toEqual([false, true]);
  });

  it("`$( )` 内的 `&&` 不再拆段:`echo $(a && b)` 单段", () => {
    const p = bashParse("echo $(a && b)");
    expect(p.ok && p.segments.map((s) => s.text)).toEqual(["echo $(a && b)"]);
  });
});
