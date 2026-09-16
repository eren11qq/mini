// H2 S-d 缝:启动时用哪个厂商 alias 的优先级(纯,可测;裁决在 HITL cli.ts 之外)。
// 显式 --model(当前意图)> resume 会话末条 model_change(AC-H2-3 恢复)> 全局 config(用户
// 上次 /connect 或 /model 落盘的选择)。三者皆无 = undefined,零默认厂商 —— 无模型可跑,
// 由 cli warn 引导 /connect。多模型/厂商:一行一 alias(见 providers.ts,DEFERRED 细分)。
export interface ModelSources {
  cliModel: string | undefined; // --model <alias>
  rebuiltModel: string | undefined; // 续会话路径末条 model_change(SessionManager.rebuild().model)
  configModel: string | undefined; // 全局 ~/.mini/config.json 的 model 键
}

export function resolveModel({
  cliModel,
  rebuiltModel,
  configModel,
}: ModelSources): string | undefined {
  return cliModel ?? rebuiltModel ?? configModel;
}
