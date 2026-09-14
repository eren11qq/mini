// H2 S-d 缝:启动时用哪个厂商 alias 的优先级(纯,可测;裁决在 HITL cli.ts 之外)。
// 显式 --model(当前意图)> resume 会话末条 model_change(AC-H2-3 恢复)> 默认厂商。
// 三者皆 alias(喂 resolveProvider)。多模型/厂商:一行一 alias(见 providers.ts,DEFERRED 细分)。
export interface ModelSources {
  cliModel: string | undefined; // --model <alias>
  rebuiltModel: string | undefined; // 续会话路径末条 model_change(SessionManager.rebuild().model)
  defaultAlias: string; // 无历史无 flag 时的出厂厂商
}

export function resolveModel({ cliModel, rebuiltModel, defaultAlias }: ModelSources): string {
  return cliModel ?? rebuiltModel ?? defaultAlias;
}
