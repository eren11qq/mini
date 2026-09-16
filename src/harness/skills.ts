// C22 段1(docs/ISSUES.md):skill 三段式之扫目录。约定 Agent Skills 标准 =
// <dirs>/<name>/SKILL.md,frontmatter 只取 name/description,缺任一则跳过。
// 同名先入表者赢(dirs 顺序 = 项目 > 全局,近者赢同 project-context 裁决)。
// 启动扫一次,运行期编辑磁盘不影响本会话(卡口径;段3 use_skill 纯查此表零 fs)。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SkillMeta {
  name: string;
  description: string;
  path: string; // SKILL.md 绝对路径(可追溯来源)
  body: string; // 剥 frontmatter 后的正文(回喂给模型的载荷)
}

// 行级 frontmatter 解析:`---` 首行 → `---` 闭行,段内 `key: value`。
// 返回 null = 非法(无开界/无闭界/缺 name|description)→ 调用方跳过该条。
function parseFrontmatter(text: string): {
  name: string;
  description: string;
  body: string;
} | null {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end === -1) return null;
  const meta: Record<string, string> = {};
  for (const l of lines.slice(1, end)) {
    const k = l.indexOf(":");
    if (k > 0) meta[l.slice(0, k).trim()] = l.slice(k + 1).trim();
  }
  if (!meta["name"] || !meta["description"]) return null;
  return {
    name: meta["name"],
    description: meta["description"],
    body: lines.slice(end + 1).join("\n"),
  };
}

export function scanSkills(opts: { dirs: string[] }): SkillMeta[] {
  const out: SkillMeta[] = [];
  const seen = new Set<string>(); // 同名裁决:先入者赢,靠后整条跳过(卡 S2)
  for (const d of opts.dirs) {
    if (!existsSync(d)) continue; // 缺目录 = 空(生产 ~/.mini/skills 常态不存在)
    for (const sub of readdirSync(d)) {
      const file = join(d, sub, "SKILL.md");
      if (!existsSync(file)) continue; // 子目录无 SKILL.md = 非 skill,静默跳
      const m = parseFrontmatter(readFileSync(file, "utf8"));
      if (!m || seen.has(m.name)) continue; // 坏条目静默跳,不崩启动
      seen.add(m.name);
      out.push({ ...m, path: file });
    }
  }
  return out;
}
