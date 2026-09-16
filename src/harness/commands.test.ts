// C9 纯缝:斜杠命令注册表。分发语义 = 首 token 命中,余下作 args(用户裁决 2026-09-15,
// 见 docs/ISSUES.md C9:「/compact x」这类多余参数交 handler 自取或忽略)。
// handler 本体是 cli 闭包(组装层),本文件只测查表纯函数;键盘接线 tui.ts 归人工验(W2)。
import { describe, expect, it } from "vitest";

import { filterCommands, matchCommand, splitModelArg, type SlashCommand } from "./commands.ts";

const noop = (): void => {};
const CMDS: SlashCommand[] = [
  { name: "compact", description: "手动压缩上下文", run: noop },
  { name: "model", description: "切换厂商", run: noop },
];

describe("matchCommand", () => {
  it("首 token 命中,余下trim作 args", () => {
    const hit = matchCommand(CMDS, "/model   deepseek ");
    expect(hit?.command.name).toBe("model");
    expect(hit?.args).toBe("deepseek");
  });
  it("非命中一律 null(交回用户消息流):非斜杠 / 裸 / / 未知命令 / 前缀撞车", () => {
    expect(matchCommand(CMDS, "hello")).toBeNull();
    expect(matchCommand(CMDS, "/")).toBeNull();
    expect(matchCommand(CMDS, "/foo")).toBeNull();
    expect(matchCommand(CMDS, "/compactions")).toBeNull(); // /compact 不吃尾巴
    expect(matchCommand(CMDS, "/compact")).not.toBeNull(); // 整行精确仍命中
  });
});

describe("filterCommands", () => {
  const names = (typed: string): string[] => filterCommands(CMDS, typed).map((c) => c.name);
  it('裸 "/" 出全部(登记序),前缀收窄,无匹配与前缀非 "/" 出空', () => {
    expect(names("/")).toEqual(["compact", "model"]);
    expect(names("/co")).toEqual(["compact"]);
    expect(names("/m")).toEqual(["model"]);
    expect(names("/x")).toEqual([]);
    expect(names("hi")).toEqual([]);
  });
});

// C18:key 入口唯一 = /connect。/model 只收单 token alias,第二 token 一律判多余
// (inline-key 旧形态随卡收掉)。返回值只含 alias,绝不回传第二 token = 明文 key 不进任何文案。
describe("splitModelArg", () => {
  it("单 token = alias,无多余", () => {
    expect(splitModelArg("qwen")).toEqual({ alias: "qwen", extra: false });
  });
  it("第二 token 出现 = 多余(旧 inline-key 形态拒)", () => {
    expect(splitModelArg("qwen sk-xxx")).toEqual({ alias: "qwen", extra: true });
    expect(splitModelArg("qwen sk-xxx y")).toEqual({ alias: "qwen", extra: true });
  });
  it("空 / 纯空白 = alias 空串(交回用法行)", () => {
    expect(splitModelArg("")).toEqual({ alias: "", extra: false });
    expect(splitModelArg("   ")).toEqual({ alias: "", extra: false });
  });
  it("前后与 token 间多余空白不影响判定", () => {
    expect(splitModelArg("  qwen  ")).toEqual({ alias: "qwen", extra: false });
    expect(splitModelArg("qwen   sk-xxx")).toEqual({ alias: "qwen", extra: true });
  });
});
