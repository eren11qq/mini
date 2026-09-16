// C22 段1 scanSkills(docs/ISSUES.md):扫 dirs 子目录里的 SKILL.md,产元数据表。
// 裁决:重名靠前 dir 赢;坏条目静默跳;缺目录 = 空。先例 = project-context.test.ts(tmp 真盘)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanSkills } from "./skills.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mini-skills-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const putSkill = async (abs: string, text: string) => {
  await mkdir(abs, { recursive: true });
  await writeFile(join(abs, "SKILL.md"), text, "utf8");
};

describe("C22 scanSkills", () => {
  it("S1 一个合法 skill → 一条记录,name/description/path/body 全对", async () => {
    const root = join(dir, "s1");
    await putSkill(
      join(root, "hello"),
      "---\nname: hello\ndescription: greet the user\n---\n先说 hi 再说 world。\n",
    );
    expect(scanSkills({ dirs: [root] })).toEqual([
      {
        name: "hello",
        description: "greet the user",
        path: join(root, "hello", "SKILL.md"),
        body: "先说 hi 再说 world。\n",
      },
    ]);
  });

  it("S2 两目录重名 → 靠前 dir 赢(项目>用户);非重叠并存", async () => {
    const proj = join(dir, "s2proj");
    const user = join(dir, "s2user");
    await putSkill(join(proj, "dup"), "---\nname: dup\ndescription: 项目版\n---\nP\n");
    await putSkill(join(user, "dup"), "---\nname: dup\ndescription: 用户版\n---\nU\n");
    await putSkill(join(user, "only"), "---\nname: only\ndescription: 用户独有\n---\nO\n");
    const got = scanSkills({ dirs: [proj, user] });
    expect(got.map((s) => [s.name, s.description])).toEqual([
      ["dup", "项目版"],
      ["only", "用户独有"],
    ]);
  });

  it("S3 坏 frontmatter/缺字段/无 SKILL.md → 跳该条其余照常;缺目录 → 空表", async () => {
    const root = join(dir, "s3");
    await putSkill(join(root, "no-fm"), "没有 frontmatter 的纯正文。\n");
    await putSkill(join(root, "missing-desc"), "---\nname: missing-desc\n---\n只有 name。\n");
    await putSkill(join(root, "good"), "---\nname: good\ndescription: 合法条目\n---\nG\n");
    await mkdir(join(root, "loose-dir"), { recursive: true }); // 无 SKILL.md 的子目录
    expect(scanSkills({ dirs: [root] }).map((s) => s.name)).toEqual(["good"]);
    expect(scanSkills({ dirs: [join(dir, "s3-nonexistent")] })).toEqual([]);
  });
});
