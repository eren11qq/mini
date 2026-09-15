// C3(docs/ISSUES.md):bash 复合命令拆段,纯函数叶子(照 salvage/transport 先例,零 import)。
// 决策:逐段过 C2 匹配器,任一段不命中即弹;未闭合引号/解析失败 = ok:false,整条必弹(安全侧兜底)。
export interface Seg {
  text: string;
  tokens: string[];
  redirect: boolean;
  substitution: boolean;
}
export type Parsed = { ok: true; segments: Seg[] } | { ok: false };

// 段文本 → tokens:空白切,引号分组并剥离。
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let word = "";
  let inQuote: '"' | "'" | null = null;
  let started = false;
  for (const c of text) {
    if (inQuote) {
      if (c === inQuote) inQuote = null;
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") {
      inQuote = c;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) tokens.push(word);
      word = "";
      started = false;
      continue;
    }
    word += c;
    started = true;
  }
  if (started) tokens.push(word);
  return tokens;
}

// always 落盘种子建议:前 2 token(二进制 + 子命令)成家族,不足 2 用 1。
export function seedOf(seg: Seg): string {
  return `${seg.tokens.slice(0, 2).join(" ")}:*`;
}

export function bashParse(cmd: string): Parsed {
  const segments: Seg[] = [];
  let cur = "";
  let inQuote: '"' | "'" | null = null;
  let inBt = false; // 反引号内
  let depth = 0; // $( ) 圆括号嵌套层
  let redirect = false;
  let substitution = false;
  const flush = () => {
    const text = cur.trim();
    if (text !== "") segments.push({ text, tokens: tokenize(text), redirect, substitution });
    cur = "";
    redirect = false;
    substitution = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (inBt) {
      cur += c;
      if (c === "`") inBt = false;
      continue;
    }
    if (inQuote) {
      // 双引号内 `$( )` 仍执行(单引号内惰性)→ 标 substitution。
      if (inQuote === '"' && c === "$" && cmd[i + 1] === "(") substitution = true;
      cur += c;
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (depth > 0) {
      cur += c;
      if (c === "(") depth++;
      else if (c === ")") depth--;
      continue;
    }
    if (c === '"' || c === "'") {
      inQuote = c;
      cur += c;
      continue;
    }
    if (c === "`") {
      substitution = true;
      inBt = true;
      cur += c;
      continue;
    }
    if (c === "$" && cmd[i + 1] === "(") {
      substitution = true;
      depth = 1;
      cur += "$(";
      i++; // `(` 一并吃掉,避免 depth 分支重复计数
      continue;
    }
    if (c === ">" || c === "<") {
      redirect = true;
      cur += c;
      continue;
    }
    if (c === "&" && cmd[i + 1] === "&") {
      flush();
      i++;
      continue;
    }
    if (c === "|" && cmd[i + 1] === "|") {
      flush();
      i++;
      continue;
    }
    if (c === "|" || c === ";" || c === "\n") {
      flush();
      continue;
    }
    cur += c;
  }
  if (inQuote || inBt || depth > 0) return { ok: false };
  flush();
  return { ok: true, segments };
}
