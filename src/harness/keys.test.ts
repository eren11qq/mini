import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKeys, resolveKey, saveKey } from "./keys.ts";

// C15 缝:keys.ts 公共边界。密钥来源 = env 优先、0600 落盘 store 兜底(PRD 同步改)。
// env 变量名(key_env,如 QWEN_API_KEY)与 store 键(alias,如 qwen)是两个命名空间,本函数 = 唯一合流点。
describe("C15 resolveKey —— env 优先、落盘兜底", () => {
  it("env 缺 → store 按 alias 兜底", () => {
    expect(
      resolveKey({ alias: "qwen", keyEnv: "QWEN_API_KEY", env: {}, store: { qwen: "sk-store" } }),
    ).toBe("sk-store");
  });

  it("两源都在场 → env 赢(落盘永不覆盖显式 env)", () => {
    expect(
      resolveKey({
        alias: "qwen",
        keyEnv: "QWEN_API_KEY",
        env: { QWEN_API_KEY: "sk-env" },
        store: { qwen: "sk-store" },
      }),
    ).toBe("sk-env");
  });
});

// 磁盘格式 = alias→key 的扁平 JSON,如 {"qwen":"sk-xxx"};缺/坏一律降级空表(读方零崩,写方下次覆盖)。
describe("C15 loadKeys", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mini-keys-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("合法 JSON → 表;文件缺 → {};坏 JSON → {}", async () => {
    const good = join(dir, "k1.json");
    await writeFile(good, '{"qwen":"sk-store","deepseek":"sk-ds"}');
    expect(await loadKeys(good)).toEqual({ qwen: "sk-store", deepseek: "sk-ds" });
    expect(await loadKeys(join(dir, "nope.json"))).toEqual({});
    const bad = join(dir, "k2.json");
    await writeFile(bad, "{not json");
    expect(await loadKeys(bad)).toEqual({});
  });
});

// 安全不变式(security skill:密钥落盘必须 0600):权限从 tmp 文件创建期带到 rename,不靠事后 chmod。
describe("C15 saveKey", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mini-keys-w-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("两次写不同 alias → 合并保留;mode 0600;目录缺时自建", async () => {
    const p = join(dir, "sub", "keys.json");
    await saveKey(p, "qwen", "sk-a");
    await saveKey(p, "deepseek", "sk-b");
    expect(await loadKeys(p)).toEqual({ qwen: "sk-a", deepseek: "sk-b" });
    expect((await stat(p)).mode & 0o777).toBe(0o600);
  });
});
