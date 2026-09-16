// C22 段3(docs/ISSUES.md):use_skill = 纯查表工具(表由 harness.scanSkills 产,cli 注入)。
// 方向锁 harness→tools 单向(先例 task.ts:29)→ 本文件不 import harness,SkillEntry 自立
// 最小形(SkillMeta 结构兼容直接喂)。run 零 fs:正文随表进内存,启动后编辑文件需重启生效。
import type { Tool, ToolResult } from "./tool.ts";

export interface SkillEntry {
  name: string;
  body: string;
}
export interface SkillToolDeps {
  skills: SkillEntry[];
}

export function makeSkillTool(deps: SkillToolDeps): Tool {
  const table = new Map(deps.skills.map((s) => [s.name, s]));
  return {
    name: "use_skill",
    description:
      "Load the full instructions of an available skill by name (listed in the system prompt). Input: name.",
    schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    // 只读级 = 路径恒来自启动预扫表,模型仅给 name,无文件输入面(卡裁决,read 同款豁免)。
    skipConfirm: true,
    // 非 async 直返 Promise(eslint require-await;工具契约只要求 Promise 形态,无 fs 可 await)。
    run(args: unknown): Promise<ToolResult> {
      const name = String((args as { name?: unknown }).name);
      const s = table.get(name);
      if (!s) {
        // 回喂式错误(不 throw):带所请求名 + 可用清单,模型据此自我纠正。
        return Promise.resolve({
          content: [
            {
              type: "text",
              text: `skill "${name}" not found; available: ${[...table.keys()].join(", ")}`,
            },
          ],
          isError: true,
        });
      }
      return Promise.resolve({ content: [{ type: "text", text: s.body }], isError: false });
    },
  };
}
