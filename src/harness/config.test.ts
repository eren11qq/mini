import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveModel } from "./config.ts";

// 全局模型配置缝(修「重启掉回出厂默认」根案):盘 = ~/.mini/config.json,今天只有一个键
// { "model": "<alias>" }。读侧降级口径与 keys.ts 一致:缺文件/坏 JSON/非对象 → 空表,读方零崩。
describe("config loadConfig", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mini-cfg-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("合法 JSON → model 键;缺文件/坏 JSON/非对象 → 空", async () => {
    const good = join(dir, "c1.json");
    await writeFile(good, '{"model":"qwen"}');
    expect(await loadConfig(good)).toEqual({ model: "qwen" });
    expect(await loadConfig(join(dir, "nope.json"))).toEqual({});
    const bad = join(dir, "c2.json");
    await writeFile(bad, "{not json");
    expect(await loadConfig(bad)).toEqual({});
    const arr = join(dir, "c3.json");
    await writeFile(arr, "[1,2]");
    expect(await loadConfig(arr)).toEqual({});
  });

  it("model 非字符串(手改坏盘)→ 该键丢弃", async () => {
    const p = join(dir, "c4.json");
    await writeFile(p, '{"model":42}');
    expect(await loadConfig(p)).toEqual({});
  });
});

describe("config saveModel", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "mini-cfg-w-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("落盘 → 读回同值;再存不同 alias → 后写覆盖;目录缺时自建", async () => {
    const p = join(dir, "sub", "config.json");
    await saveModel(p, "glm");
    expect(await loadConfig(p)).toEqual({ model: "glm" });
    await saveModel(p, "qwen");
    expect(await loadConfig(p)).toEqual({ model: "qwen" });
    expect(JSON.parse(await readFile(p, "utf8"))).toEqual({ model: "qwen" });
  });
});
