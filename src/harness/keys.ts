// C15 密钥缝(纯叶):env 优先、落盘 store 兜底的合流点。PRD 改动 = 「只从 env 读」→「env > 0600 文件」。
// 命名空间:env 按 key_env 变量名(厂商表指向),store 按 alias;本函数是唯一合流处,调用方(cli)只做搬运。
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type KeyStore = Record<string, string>;

// 磁盘 = 扁平 JSON {alias: key}。缺文件/坏 JSON/非对象 → 降级空表:读方零崩,坏盘交给下次 saveKey 覆盖。
export async function loadKeys(path: string): Promise<KeyStore> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: KeyStore = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>))
      if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

// 合并写 + 原子换:load→改→写 tmp(0600,创建期定权限)→rename 覆盖。中途崩 = 旧文件原样,不留半截 JSON。
export async function saveKey(path: string, alias: string, key: string): Promise<void> {
  const store = await loadKeys(path);
  store[alias] = key;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600); // mode 只在创建生效,重入同 pid 时兜底钉死
  await rename(tmp, path);
}

export function resolveKey(o: {
  alias: string;
  keyEnv: string;
  env: Record<string, string | undefined>;
  store: KeyStore;
}): string | undefined {
  return o.env[o.keyEnv] || o.store[o.alias] || undefined;
}
