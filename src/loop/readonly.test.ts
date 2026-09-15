import { describe, it, expect } from "vitest";
import { bashParse } from "./bash-parse.ts";
import { readOnlyParsed } from "./readonly.ts";

// C4(docs/ISSUES.md):只读白名单 = 纯函数叶子(照 danger 先例,只依赖 bash-parse 的 Seg 形状)。
// 单元测判据输入用 bashParse 造段(真叶子组合),期望值取字面量 true/false(独立真值源)。
const ro = (cmd: string): boolean => readOnlyParsed(bashParse(cmd));

describe("readOnlyParsed — 只读命令免弹", () => {
  it("`ls -la` → true", () => {
    expect(ro("ls -la") && ro("cat x") && ro("whoami") && ro("tree")).toBe(true);
  });
});

describe("readOnlyParsed — 家族只读(argv[0]+argv[1])", () => {
  it("`git status -sb` / `git diff HEAD` / `node --version` / `npm ls` → true", () => {
    expect(ro("git status -sb")).toBe(true);
    expect(ro("git diff HEAD")).toBe(true);
    expect(ro("node --version")).toBe(true);
    expect(ro("npm ls")).toBe(true);
  });

  it("对照组:`git push`(家族未列)→ false", () => {
    expect(ro("git push")).toBe(false);
  });
});

describe("readOnlyParsed — 写副作用 flag 出口", () => {
  it("`find . -delete` → false(find 虽只读,带写 flag 出局)", () => {
    expect(ro("find . -delete")).toBe(false);
  });

  it("对照:`find . -name x`(无写 flag)→ true", () => {
    expect(ro("find . -name x")).toBe(true);
  });
});

describe("readOnlyParsed — 其余出口条件", () => {
  it("重定向:`cat x > y` / `ls > /tmp/a` → false", () => {
    expect(ro("cat x > y")).toBe(false);
    expect(ro("ls > /tmp/a")).toBe(false);
  });

  it("命令替换:`ls $(pwd)` / 反引号 → false", () => {
    expect(ro("ls $(pwd)")).toBe(false);
    expect(ro("ls `pwd`")).toBe(false);
  });

  it("解析失败(未闭合引号)→ false", () => {
    expect(ro('ls && echo "oops')).toBe(false);
  });

  it("逐段 every:`ls -la && git status` → true;混入非只读段(`&& rm x`)/写 flag 段 → false", () => {
    expect(ro("ls -la && git status")).toBe(true);
    expect(ro("ls -la && rm x")).toBe(false);
    expect(ro("git status && find . -delete")).toBe(false);
  });
});
