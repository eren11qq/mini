// salvage 叶子(双方言共用):把分多 delta 累积的 toolcall arguments 前缀尽力解析成对象。
// 残缺 → 返回已完成顶层 key/value;完整 → JSON.parse 精确;非对象 → 原串。
// 目标:UI 不空白(AC-S1-6);定稿截断 → 整批拒执(AC-S1-7,判定住各方言 done 路径)。
// 纯函数零依赖。卡 1(ADR-003)自 openai-completions.ts 逐字搬入,行为不变;
// 住叶子 = 方言可 import 它而 core.ts(dispatch)不致成环。
// 只导出 salvage:stringEnd/braceEnd/valueEnd/skipWs 是实现细节,测试不窥私。

function stringEnd(s: string, i: number): number {
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === "\\") {
      j += 2;
      continue;
    }
    if (s[j] === '"') return j + 1;
    j += 1;
  }
  return -1;
}

function braceEnd(s: string, i: number, open: string): number {
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let j = i;
  let inStr = false;
  while (j < s.length) {
    const c = s[j];
    if (inStr) {
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === '"') inStr = false;
      j += 1;
      continue;
    }
    if (c === '"') {
      inStr = true;
      j += 1;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
    j += 1;
  }
  return -1;
}

function valueEnd(s: string, i: number): number {
  const c = s[i];
  if (c === '"') return stringEnd(s, i);
  if (c === "{" || c === "[") return braceEnd(s, i, c);
  let j = i;
  while (j < s.length && !",}\t\r\n ".includes(s.charAt(j))) j += 1;
  return j;
}

function skipWs(s: string, i: number): number {
  let j = i;
  while (j < s.length && " \t\r\n".includes(s.charAt(j))) j += 1;
  return j;
}

export function salvage(s: string): unknown {
  const t = s.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    // 继续尽力
  }
  if (!t.startsWith("{")) return undefined;
  const out: Record<string, unknown> = {};
  let i = skipWs(t, 0);
  i = skipWs(t, i + 1); // 过 {
  while (i < t.length) {
    i = skipWs(t, i);
    if (t[i] === "}") break;
    if (t[i] !== '"') break;
    const keyEnd = stringEnd(t, i);
    if (keyEnd === -1) break;
    const key = JSON.parse(t.slice(i, keyEnd)) as string;
    i = skipWs(t, keyEnd);
    if (t[i] !== ":") break;
    i = skipWs(t, i + 1);
    const vEnd = valueEnd(t, i);
    if (vEnd === -1 || vEnd > t.length) break;
    const valStr = t.slice(i, vEnd);
    try {
      out[key] = JSON.parse(valStr);
    } catch {
      break;
    }
    i = skipWs(t, vEnd);
    if (t[i] === ",") {
      i = skipWs(t, i + 1);
      continue;
    }
    if (t[i] === "}") break;
    break;
  }
  return out;
}
