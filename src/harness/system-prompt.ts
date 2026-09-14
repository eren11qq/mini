// H3 S-a 纯缝:system prompt 三段 = 中文固定骨架 + 工具清单 + `<project_instructions>`。
// 纯函数零状态 → AC-H3-5"工具集变即重建"免费成立(每轮拿当前 tools 重算即可)。
// 裁决零在此:压缩/阈值/配对不在 harness(AC-H1-3 口径延续)。
export interface SystemPromptTool {
  name: string;
  description?: string;
}
export interface ProjectContext {
  path: string; // 命中文件绝对路径(写进标签属性,模型可引用来源)
  content: string;
}

// 骨架首句必须 "你是 mini"(测试钉死开头,防段序漂移)。
const SKELETON =
  "你是 mini,一个命令行编码助手。用下面的工具完成任务:先读后写,改动尽量小;" +
  "写/改/执行类操作会经过用户确认门。回复与思考用中文。";

export function buildSystemPrompt(opts: {
  tools: SystemPromptTool[];
  projectContext?: ProjectContext;
}): string {
  const lines = [SKELETON, "", "## 可用工具"];
  for (const t of opts.tools) {
    lines.push(t.description ? `- ${t.name}: ${t.description}` : `- ${t.name}`);
  }
  if (opts.projectContext) {
    lines.push(
      "",
      "## 项目上下文",
      `<project_instructions path="${opts.projectContext.path}">`,
      opts.projectContext.content,
      "</project_instructions>",
    );
  }
  return lines.join("\n");
}
