// H3 S-a 纯缝:buildSystemPrompt —— 三段拼装(中文骨架 + 工具清单 + 项目上下文)。
// 断言 = 独立字面量;顺序断言用 indexOf 防"段落漂移"。
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./system-prompt.ts";

const TOOLS = [
  { name: "read", description: "读取文件" },
  { name: "bash", description: "执行命令" },
];

describe("S-a buildSystemPrompt", () => {
  it("AC-H3-3 三段齐:骨架开头、工具清单含每工具 name: description、project_instructions 包住内容", () => {
    const p = buildSystemPrompt({
      tools: TOOLS,
      projectContext: { path: "/a/AGENTS.md", content: "用 pnpm 构建" },
    });
    expect(p.indexOf("你是 mini")).toBe(0);
    expect(p).toContain("- read: 读取文件");
    expect(p).toContain("- bash: 执行命令");
    const iTools = p.indexOf("- read:");
    const iCtx = p.indexOf("<project_instructions");
    expect(iTools).toBeGreaterThan(-1);
    expect(iCtx).toBeGreaterThan(iTools); // 骨架 → 工具 → 上下文 顺序
    expect(p).toContain("用 pnpm 构建");
    expect(p).toContain("</project_instructions>");
    expect(p).toContain('path="/a/AGENTS.md"');
  });

  it("AC-H3-3 无项目上下文 → project_instructions 段整体省略(不留空壳)", () => {
    const p = buildSystemPrompt({ tools: TOOLS });
    expect(p).not.toContain("<project_instructions");
    expect(p).toContain("- read: 读取文件");
  });

  it("AC-H3-5 工具集 [read] → [read,bash]:重建后清单含 bash(纯函数,无缓存)", () => {
    const p1 = buildSystemPrompt({ tools: [{ name: "read", description: "读" }] });
    expect(p1).not.toContain("- bash:");
    const p2 = buildSystemPrompt({
      tools: [
        { name: "read", description: "读" },
        { name: "bash", description: "跑命令" },
      ],
    });
    expect(p2).toContain("- bash: 跑命令");
  });

  it("无 description 的工具 → 只列 name 行,不冒空尾随", () => {
    const p = buildSystemPrompt({ tools: [{ name: "mystery" }] });
    expect(p).toContain("- mystery");
    expect(p).not.toContain("- mystery:");
  });

  it("C22-S4 可用技能表 = 工具清单后、项目上下文前,行形状 `- name: description`", () => {
    const p = buildSystemPrompt({
      tools: TOOLS,
      skills: [
        { name: "pdf", description: "读 PDF" },
        { name: "tdd", description: "测试先行" },
      ],
      projectContext: { path: "/a/AGENTS.md", content: "CTX" },
    });
    expect(p).toContain(
      "## 可用技能\n- pdf: 读 PDF\n- tdd: 测试先行\n需要某技能时用 use_skill 工具加载全文再动手。",
    );
    expect(p.indexOf("## 可用技能")).toBeGreaterThan(p.indexOf("## 可用工具"));
    expect(p.indexOf("## 可用技能")).toBeLessThan(p.indexOf("<project_instructions"));
  });

  it("C22-S5 diff-0 锚:不传/空数组 skills → 输出与无此参数时逐字节相同", () => {
    const base = buildSystemPrompt({
      tools: TOOLS,
      env: { platform: "linux", date: "2026-09-16", cwd: "/x" },
      projectContext: { path: "/a/AGENTS.md", content: "CTX" },
    });
    expect(buildSystemPrompt({ tools: TOOLS, skills: [] })).not.toContain("## 可用技能");
    const withRest = buildSystemPrompt({
      tools: TOOLS,
      env: { platform: "linux", date: "2026-09-16", cwd: "/x" },
      projectContext: { path: "/a/AGENTS.md", content: "CTX" },
      skills: [],
    });
    expect(withRest).toBe(base);
  });

  it("env:传入 → <env> 三行落在工具清单前;不传 → 整块省略(不留空壳)", () => {
    const p = buildSystemPrompt({
      tools: TOOLS,
      env: { platform: "linux", date: "2026-09-14", cwd: "/home/dqq/project/mini" },
    });
    expect(p.indexOf("<env>")).toBeGreaterThan(0);
    expect(p).toContain("1. 平台：linux");
    expect(p).toContain("3. 工作目录：/home/dqq/project/mini");
    expect(p.indexOf("</env>")).toBeLessThan(p.indexOf("- read:"));
    const bare = buildSystemPrompt({ tools: TOOLS });
    expect(bare).not.toContain("<env>");
  });
});
