// C9 纯缝:斜杠命令注册表。分发语义 = 首 token 命中,余下作 args(用户裁决 2026-09-15,
// 见 docs/ISSUES.md C9:「/compact x」这类多余参数交 handler 自取或忽略)。
// handler 本体是 cli 闭包(组装层),本文件只测查表纯函数;键盘接线 tui.ts 归人工验(W2)。
import { describe, expect, it } from "vitest";

import { filterCommands, matchCommand, type SlashCommand } from "./commands.ts";

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
