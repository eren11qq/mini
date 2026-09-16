// C22 段1 scanSkills(docs/ISSUES.md):扫 dirs 子目录里的 SKILL.md,产元数据表。
// 裁决:重名靠前 dir 赢;坏条目静默跳;缺目录 = 空。先例 = project-context.test.ts(tmp 真盘)。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSkillCommands, scanSkills, type SkillMeta } from "./skills.ts";

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

// C22 追加裁决(用户:装了 skill 但 / 菜单只有 3 条命令):scanSkills 没问题(37 全中),
// 缺的是「skill → 斜杠菜单项」这一环。本缝 = 纯映射:每项给 name/description,run(args)
// 把「正文 + 用户请求」交 send 回调(cli 层注入 REPL 发送路)。断言只钉行为要件
// (名字进表/冲突剔除/载荷含正文与参数),不钉模板措辞 —— 防同义反复测。
const mkMeta = (name: string, description: string, body: string): SkillMeta => ({
  name,
  description,
  path: `/fake/${name}/SKILL.md`,
  body,
});

describe("C22 buildSkillCommands", () => {
  it("每 skill 一条:名字=菜单项,描述进弹层,登记序保留", () => {
    const cmds = buildSkillCommands(
      [mkMeta("tdd", "红绿循环", "B1"), mkMeta("grilling", "拷问模式", "B2")],
      new Set(),
      () => {},
    );
    expect(cmds.map((c) => [c.name, c.description])).toEqual([
      ["tdd", "红绿循环"],
      ["grilling", "拷问模式"],
    ]);
  });

  it("与保留命令重名(如 model)→ 该 skill 不注册,其余照常", () => {
    const cmds = buildSkillCommands(
      [mkMeta("model", "撞车款", "X"), mkMeta("tdd", "合法款", "Y")],
      new Set(["compact", "model", "connect"]),
      () => {},
    );
    expect(cmds.map((c) => c.name)).toEqual(["tdd"]);
  });

  it("run(args) → send 收到含正文+参数+技能名的文本;无参也含正文", () => {
    const sent: string[] = [];
    const cmds = buildSkillCommands(
      [mkMeta("tdd", "d", "RED-GREEN-REFACTOR 正文")],
      new Set(),
      (t) => {
        sent.push(t);
      },
    );
    void cmds[0]!.run("给 config.ts 补测试");
    void cmds[0]!.run("");
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("RED-GREEN-REFACTOR 正文");
    expect(sent[0]).toContain("给 config.ts 补测试");
    expect(sent[0]).toContain("tdd");
    expect(sent[1]).toContain("RED-GREEN-REFACTOR 正文");
  });
});
