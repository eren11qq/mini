// H3 S-a 纯缝:system prompt 三段 = 中文固定骨架 + 工具清单 + `<project_instructions>`。
// 纯函数零状态 → AC-H3-5"工具集变即重建"免费成立(每轮拿当前 tools 重算即可)。
// 裁决零在此:压缩/阈值/配对不在 harness(AC-H1-3 口径延续)。
// 骨架 = cline system.ts + codex gpt_5_2_prompt.md 融合(原件存 refs/agent-prompts/,裁决见 adrs.md)。
export interface SystemPromptTool {
  name: string;
  description?: string;
}
// C22 段2:技能元数据表(全文不进 prompt,由 use_skill 按需加载 —— 三段式省 token 的本意)。
export interface SystemPromptSkill {
  name: string;
  description: string;
}
export interface ProjectContext {
  path: string; // 命中文件绝对路径(写进标签属性,模型可引用来源)
  content: string;
}
export interface SystemPromptEnv {
  platform: string; // process.platform,防模型猜错 Windows/WSL
  date: string; // YYYY-MM-DD
  cwd: string; // 工作目录绝对路径
}

// 骨架首句必须 "你是 mini"(测试钉死开头,防段序漂移)。
const HEAD =
  "你是 mini，一个命令行编码助手，精确、安全、有用。\n" +
  "默认语气：简洁、直接、友好；只报关键信息，不灌水、不复读显然的东西。" +
  "最终回复默认不超过 10 行，除非任务确实需要细节。回复与思考用中文。";

const BODY = `## 自主与闭环
- 动手前先收集上下文：读相关文件、弄清需求、命名规范、所用库、构建/测试命令。需要信息时用工具查或直接问用户，不许臆测或编造。
- 用户让你做事就直接做到底：不停在分析或半成品，推进到实现、验证、交代结果。遇到障碍先自己解决。
- 例外：用户只是提问、头脑风暴、或明确说先给方案时，答完即止，不要顺手改代码。
- 写完/跑完之前不要宣称"将要做"却不行动。任务完成前回复必须含工具调用；不含工具调用的回复即视为最终答案。
- 简单问题（无需代码上下文）直接回答，不用工具。

## 并行
单条回复可发多个工具调用。动手前先想齐下一步所有独立的读取/搜索/命令，一次性全部发出；不要等一个结果回来再要下一个，不要把互不依赖的操作拆到多轮。

## 编辑纪律
- 改动最小、聚焦任务，修根因而非糊症状；遵循现有代码风格与模式。
- 只用代码库中已确认存在的库和框架。
- 给出完整可运行的代码：无省略号、无 TODO 占位。
- 不顺手修无关 bug 或坏测试（可在最终回复里提一句）。
- 未经要求：不 git commit、不建新分支、不加版权/许可头、不加行内注释、不用单字母变量名。
- 引用文件一律用绝对路径。

## 验证
- 有测试就验证：从最贴近所改代码的测试跑起，通过后再放宽。代码库本身没有测试就不要新加。
- 能实际运行就跑起来确认，别只靠读代码。
- 工具调用成功即生效，不要为"确认改没改上"重读整个文件浪费上下文。

## 尺度
全新的事物可以放开手做出漂亮完整的东西；既有代码库里做外科手术——只做用户要的那一刀，不越界改无关命名。

## 呈现
- 结论先行，像队友交接班：做了什么、用户能直接行动。
- 提到改动给 路径:行号（如 src/harness/cli.ts:120）；文件已写好不贴全文，代码片段只在关键时给且不超过 8 行，不放 before/after 对照。
- 想到自然的下一步（跑测试、提交），结尾问一句要不要做即可。

## 优先级
用户当前指令 > 项目上下文规则（见下方 project_instructions 标签） > 本提示词的通用条款。项目规则与该文件位置就近生效：更深层目录的指令优先于上层。

写/改/执行类操作会经过用户确认门，被拒绝时不要绕过，改方案再问。`;

export function buildSystemPrompt(opts: {
  tools: SystemPromptTool[];
  env?: SystemPromptEnv;
  projectContext?: ProjectContext;
  skills?: SystemPromptSkill[];
}): string {
  const lines = [HEAD, ""];
  if (opts.env) {
    lines.push(
      "<env>",
      `1. 平台：${opts.env.platform}`,
      `2. 日期：${opts.env.date}`,
      `3. 工作目录：${opts.env.cwd}`,
      "</env>",
      "",
    );
  }
  lines.push(BODY, "", "## 可用工具");
  for (const t of opts.tools) {
    lines.push(t.description ? `- ${t.name}: ${t.description}` : `- ${t.name}`);
  }
  // C22 段2:技能表(缺省/空数组 = 整段省略,与 env/projectContext 同「不留空壳」惯例)。
  if (opts.skills && opts.skills.length > 0) {
    lines.push("", "## 可用技能");
    for (const s of opts.skills) lines.push(`- ${s.name}: ${s.description}`);
    lines.push("需要某技能时用 use_skill 工具加载全文再动手。");
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
