import { describe, it, expect } from "vitest";
import { salvage } from "./salvage.ts";

// 锚点直测(ADR-003 Q6=A 的"下一独立 slice"):salvage 自 openai-completions.ts 提炼成解析叶子后,
// 公开面 `salvage(s: string): unknown` 此前只有经缝的间接覆盖(AC-S1-6/S1-7 只断言 toolcall_delta
// payload 非空)。此处钉死契约本体:JSON.parse 能过 → 精确;过不了 → 尽力保留已完成的顶层 key/value。
// 内部 helper(stringEnd/braceEnd/valueEnd/skipWs)不导出 = 实现细节,不窥私。

describe("salvage:完整 JSON 走精确路径", () => {
  it("顶层对象 → 等价 JSON.parse(嵌套不损)", () => {
    const s = '{"path":"/a/b","limit":5,"opts":{"recursive":true,"globs":["x.ts","y.ts"]}}';
    expect(salvage(s)).toEqual(JSON.parse(s));
  });

  it("前后空白不影响判定", () => {
    expect(salvage('  \n {"a":1} \t ')).toEqual({ a: 1 });
  });

  it("顶层非对象但完整(数组/数字/字符串)→ 原值,不强塞对象", () => {
    expect(salvage("[1,2]")).toEqual([1, 2]);
    expect(salvage("123")).toBe(123);
    expect(salvage('"hi"')).toBe("hi");
  });
});

describe("salvage:残缺前缀尽力解析(UI 不空白,AC-S1-6 的叶子上判据)", () => {
  it("值残缺 → 保留已完成顶层对", () => {
    expect(salvage('{"path":"/a/b","limit"')).toEqual({ path: "/a/b" });
    expect(salvage('{"path":"/a/b","limit":')).toEqual({ path: "/a/b" });
    expect(salvage('{"path":"/a/b","limit":5')).toEqual({ path: "/a/b", limit: 5 });
  });

  it("尾逗号 / 裸尾字符 → 停在断点,已完成部分照留", () => {
    expect(salvage('{"a":1,')).toEqual({ a: 1 });
    expect(salvage('{"a":1,}')).toEqual({ a: 1 });
    expect(salvage('{"a":1}trailing')).toEqual({ a: 1 });
  });

  it("嵌套容器完整才算完整:未闭合的 { 不产 key", () => {
    expect(salvage('{"a":{"b":[1,{"c":2}]},"d"')).toEqual({ a: { b: [1, { c: 2 }] } });
    expect(salvage('{"a":{"b":1')).toEqual({});
    expect(salvage('{"a"')).toEqual({});
  });

  it("字符串内的引号转义与花括号不骗过扫描(值里的 } 不算闭合)", () => {
    const s = '{"cmd":"echo \\"} not a close\\"","x":1';
    expect(salvage(s)).toEqual({ cmd: 'echo "} not a close"', x: 1 });
  });

  it("CJK 值(内含逗号)整块保留", () => {
    expect(salvage('{"text":"你好,世界,带逗号","n"')).toEqual({ text: "你好,世界,带逗号" });
  });
});

describe("salvage:不可判定的输入 → 空/undefined(不猜)", () => {
  it("空串与纯空白 → undefined", () => {
    expect(salvage("")).toBeUndefined();
    expect(salvage("   \t\n ")).toBeUndefined();
  });

  it("非 { 开头的残缺文本 → undefined", () => {
    expect(salvage("abc")).toBeUndefined();
    expect(salvage("[1,")).toBeUndefined();
  });

  it("结构坏了(值不可解析)→ 断点之后不入库,返回空对象", () => {
    expect(salvage('{"a":tru')).toEqual({});
    expect(salvage('{"a" 1}')).toEqual({});
  });
});
