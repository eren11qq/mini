// 全局模型配置缝(纯叶,模式照 keys.ts):用户选过的厂商持久到 ~/.mini/config.json,
// 重启不再掉回出厂默认(defaultAlias 已废,见 resolve-model.ts)。今天只有一个键 model =
// 厂商 alias;坏盘降级空表(读方零崩),写 = 合并→tmp→rename 原子换,中途崩不留半截 JSON。
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface MiniConfig {
  model?: string;
}

export async function loadConfig(path: string): Promise<MiniConfig> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
    const model = (raw as Record<string, unknown>)["model"];
    return typeof model === "string" ? { model } : {};
  } catch {
    return {};
  }
}

// 合并写(未来加键不丢旧键)+ 原子换。配置无密钥 → 不加 keys.ts 的 0600 约束,走默认权限。
export async function saveModel(path: string, alias: string): Promise<void> {
  const cfg = await loadConfig(path);
  cfg.model = alias;
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
  await rename(tmp, path);
}
