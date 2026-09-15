import { describe, it, expect } from "vitest";
import { isValidSeed, ruleMatches } from "./rules.ts";

// C2(spec 重写挂 C8,此片以 docs/ISSUES.md C2 验收句为准)
// 规则域 = 纯字符串语义,零工具名知识:
//   `xxx:*` 后缀 → token 前缀家族;`path:` 前缀 → glob;其余 → 整串相等。

describe("ruleMatches — bash token 前缀家族", () => {
  it("规则 `git status:*` 命中命令 `git status -sb`(规则 token 是命令 token 前缀)", () => {
    expect(ruleMatches({ tool: "bash", prefix: "git status:*" }, "git status -sb")).toBe(true);
  });

  it("规则 `git status:*` 不命中 `git commit -m x`(家族止于子命令)", () => {
    expect(ruleMatches({ tool: "bash", prefix: "git status:*" }, "git commit -m x")).toBe(false);
  });

  it("旧格式 `git:*`(首 token 家族)迁移语义等价:命中 `git push`,不命中 `rm -rf x`", () => {
    expect(ruleMatches({ tool: "bash", prefix: "git:*" }, "git push")).toBe(true);
    expect(ruleMatches({ tool: "bash", prefix: "git:*" }, "rm -rf x")).toBe(false);
  });

  it("多余空白不破家族匹配(前后空格 + 连续空格折叠)", () => {
    expect(ruleMatches({ tool: "bash", prefix: "git status:*" }, "  git   status  -sb ")).toBe(
      true,
    );
  });
});

describe("ruleMatches — 旧死规则兼容", () => {
  it("旧 write 全 JSON 串条目 = 相等域:同串命中(实际永不发生),不同串不命中 = 行为不回退", () => {
    const legacy = JSON.stringify({ path: "a.txt", content: "V1" });
    expect(ruleMatches({ tool: "write", prefix: legacy }, legacy)).toBe(true);
    expect(
      ruleMatches(
        { tool: "write", prefix: legacy },
        JSON.stringify({ path: "a.txt", content: "V2" }),
      ),
    ).toBe(false);
  });
});

describe("ruleMatches — path glob(C1)", () => {
  it("`path:src/**` 命中 `src/a.ts` 与深层 `src/loop/x.ts`,不命中 `docs/x.md`", () => {
    expect(ruleMatches({ tool: "write", prefix: "path:src/**" }, "path:src/a.ts")).toBe(true);
    expect(ruleMatches({ tool: "write", prefix: "path:src/**" }, "path:src/loop/x.ts")).toBe(true);
    expect(ruleMatches({ tool: "write", prefix: "path:src/**" }, "path:docs/x.md")).toBe(false);
  });

  it("`path:src/*` 单星不跨 `/`", () => {
    expect(ruleMatches({ tool: "write", prefix: "path:src/*" }, "path:src/a.ts")).toBe(true);
    expect(ruleMatches({ tool: "write", prefix: "path:src/*" }, "path:src/sub/a.ts")).toBe(false);
  });
});

describe("isValidSeed — 空家族防线(C2 补 AC-T2-8)", () => {
  it("空命令产出的 `:*` 与 `*`/空串一律拒写", () => {
    expect(isValidSeed(":*")).toBe(false);
    expect(isValidSeed("*")).toBe(false);
    expect(isValidSeed("")).toBe(false);
    expect(isValidSeed("git status:*")).toBe(true);
  });
});
