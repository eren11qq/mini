// T2 AC-T2-7/8:rules.json 持久化(DECISIONS T4:项目目录、明文、手删即撤销、仅前缀、禁全允许)。
// 明文数组 [{tool,prefix}]。读写走 node:fs 回调形态 —— 错误是回调参数不是异常,
// 守住 loop 源零 try-catch 约束(L1-2 must-not)。文件缺失/读败 = 无规则,手删即撤销的正路。
// JSON 语法错(手改坏文件)不在 AC 场景:parse throw = 显式崩,不静默吞。
import { readFile, writeFile } from "node:fs";

export interface Rule {
  tool: string;
  prefix: string;
}

export function loadRules(path: string): Promise<Rule[]> {
  return new Promise((resolve) => {
    readFile(path, "utf8", (err, data) => {
      if (err) return resolve([]);
      const parsed: unknown = JSON.parse(data);
      resolve(
        Array.isArray(parsed)
          ? (parsed.filter(
              (r) =>
                typeof r === "object" &&
                r !== null &&
                typeof (r as Rule).tool === "string" &&
                typeof (r as Rule).prefix === "string",
            ) as Rule[])
          : [],
      );
    });
  });
}

// always → 追加落盘,返回含新规则的列表(同 run 内缓存同步)。
// 写失败(只读目录等)不崩:规则只是优化,丢了下次重新弹 = 安全默认。
export function appendRule(path: string, rule: Rule): Promise<Rule[]> {
  return loadRules(path).then((rules) => {
    const next = [...rules, rule];
    return new Promise<Rule[]>((resolve) => {
      writeFile(path, JSON.stringify(next, null, 2) + "\n", () => resolve(next));
    });
  });
}

// AC-T2-8:全允许防线 —— `*`/空前缀永不接受为规则种子(写侧拒 + 读侧滤)。
export function isValidSeed(prefix: string): boolean {
  return prefix.length > 0 && prefix !== "*";
}
