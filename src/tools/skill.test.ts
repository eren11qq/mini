// C22 段3(docs/ISSUES.md):use_skill = 表查找工具。公共面 = Tool(run + skipConfirm);
// 载荷不进 content 之外(无 details)、未知名 = isError 回喂(validate.ts 同式,断环不成)。
// 表经 scanSkills 真 tmp fixture 产出(顺带钉段1→段3 接线形状)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSkills } from "../harness/skills.ts";
import { makeSkillTool } from "./skill.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mini-skill-tool-"));
  await mkdir(join(dir, "hello"), { recursive: true });
  await writeFile(
    join(dir, "hello", "SKILL.md"),
    "---\nname: hello\ndescription: 打招呼\n---\n先说 hi。\n第二段。\n",
    "utf8",
  );
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("C22 use_skill", () => {
  it("S6 命中 → 正文原样回喂(剥 frontmatter)、isError:false;只读免弹", async () => {
    const t = makeSkillTool({ skills: scanSkills({ dirs: [dir] }) });
    expect(t.name).toBe("use_skill");
    expect(t.skipConfirm).toBe(true);
    const r = await t.run({ name: "hello" });
    expect(r).toEqual({
      content: [{ type: "text", text: "先说 hi。\n第二段。\n" }],
      isError: false,
    });
  });

  it("S7 未知名 → isError 且文本含所请求名(回喂不断环,不 throw)", async () => {
    const t = makeSkillTool({ skills: scanSkills({ dirs: [dir] }) });
    const r = await t.run({ name: "ghost" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("ghost");
  });
});
