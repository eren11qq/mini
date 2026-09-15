// C5(docs/ISSUES.md):确认门危险命令黑名单,纯函数叶子(照 bash-parse 先例,只 import ./bash-parse.ts)。
// 设计:黑名单先于一切 allow —— 规则/只读表/模式开关均不可豁免,命中即必弹。
// 实现查「整条 + 每段」两形态:C3 拆段后单独 `sh` 段可借规则放行的洞,靠整条 raw 管道扫描在此堵死。
// 解析失败(未闭合引号等)= 保守回退朴素拆段照查,误弹是安全侧。零 try/catch、零 throw。
import { bashParse } from "./bash-parse.ts";

// 检查 1(整条 raw,只扫一次):`[^|]*` 锁死 curl 与 shell 在同一段管道内。
const PIPELINE_TO_SHELL = /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/;

// 重定向目标是否落在 cwd 外:`..`/`~`/`$HOME` 前缀,或绝对路径不在 cwd/ 之下。相对路径一律内。
function isOutside(target: string, cwd: string): boolean {
  if (target === ".." || target.startsWith("../")) return true;
  if (target.startsWith("~") || target.startsWith("$HOME")) return true;
  return target.startsWith("/") && !target.startsWith(cwd.replace(/\/+$/, "") + "/");
}

const REDIRECT_OPS = [">", ">>", "<", "2>"];

// 段 tokens → 该类命中的理由列表(检查顺序即契约顺序,弹窗理由稳定)。
function segmentReasons(text: string, tokens: string[], redirect: boolean, cwd: string): string[] {
  const reasons: string[] = [];
  let toks = tokens;
  if (toks[0] === "sudo") {
    reasons.push("sudo 提权");
    toks = toks.slice(1); // `sudo rm -rf /` 提权后段仍是 rm 炸机,剥前缀继续查。
  }
  // rm 炸机:标志字符拼起来同时含 r/f,且存在根/家目录目标(`/`、`~`、`$HOME` 及其下)。
  // `rm -rf ./build` 相对目标 = 干净;绝对路径一律算外(误弹是安全侧)。
  if (toks[0] === "rm") {
    const flags = toks.filter((t) => t.startsWith("-")).join("");
    const targetsRfRootHome = toks.some(
      (t) =>
        !t.startsWith("-") &&
        (t === "/" ||
          t.startsWith("/") ||
          t === "~" ||
          t.startsWith("~/") ||
          t === "$HOME" ||
          t.startsWith("$HOME/")),
    );
    if (flags.includes("r") && flags.includes("f") && targetsRfRootHome)
      reasons.push("rm -rf 指向根/家目录");
  }
  // git push 强推:仅 `--force` 整串或短标志组(-f/-uf/-fu);`--force-with-lease` 有半 = 不弹(契约钉死)。
  if (toks[0] === "git" && toks[1] === "push") {
    const force = toks
      .slice(2)
      .some((t) => t === "--force" || (/^-[a-zA-Z]{1,2}$/.test(t) && t.includes("f")));
    if (force) reasons.push("git push --force 强推");
  }
  if (toks[0] === "git" && toks[1] === "reset" && toks.slice(2).some((t) => t === "--hard")) {
    reasons.push("git reset --hard 丢弃未提交改动");
  }
  if (toks[0] === "chmod" && toks.slice(1).some((t) => t === "777" || t === "0777")) {
    reasons.push("chmod 777 全开权限");
  }
  if (toks[0] === "dd" && toks.slice(1).some((t) => t.startsWith("of="))) {
    reasons.push("dd 写设备");
  }
  // 重定向:操作符独立 token 的下一 token,或粘连形态(`>x`/`>>x`/`<x`/`2>x`)从段文本抠。
  if (redirect || /[<>]/.test(text)) {
    const targets = new Set<string>();
    for (let i = 0; i < tokens.length - 1; i++) {
      if (REDIRECT_OPS.includes(tokens[i] ?? "")) targets.add(tokens[i + 1] ?? "");
    }
    for (const m of text.matchAll(/>>?([^\s>]+)/g))
      targets.add((m[1] ?? "").replace(/^["']+|["']+$/g, ""));
    for (const m of text.matchAll(/<([^\s<]+)/g))
      targets.add((m[1] ?? "").replace(/^["']+|["']+$/g, ""));
    if ([...targets].some((t) => isOutside(t, cwd))) reasons.push("重定向写到 cwd 外");
  }
  return reasons;
}

// 段列表 = [text, tokens] 对;解析成功走 bashParse,失败朴素切分(引号不敏感,误弹是安全侧)。
function naiveChunks(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\||\n/)
    .map((c) => c.trim())
    .filter((c) => c !== "");
}

function naiveTokens(chunk: string): string[] {
  return chunk
    .split(/\s+/)
    .filter((t) => t !== "")
    .map((t) =>
      t.length >= 2 &&
      (t.startsWith('"') || t.startsWith("'")) &&
      (t.endsWith('"') || t.endsWith("'"))
        ? t.slice(1, -1)
        : t,
    );
}

export function dangerOfShell(command: string, cwd: string): string | null {
  const reasons: string[] = [];
  if (PIPELINE_TO_SHELL.test(command)) reasons.push("curl/wget 管道进 shell");
  const parsed = bashParse(command);
  const segs: Array<[string, string[], boolean]> = parsed.ok
    ? parsed.segments.map((s) => [s.text, s.tokens, s.redirect] as [string, string[], boolean])
    : naiveChunks(command).map((c) => [c, naiveTokens(c), false] as [string, string[], boolean]);
  for (const [text, tokens, redirect] of segs) {
    reasons.push(...segmentReasons(text, tokens, redirect, cwd));
  }
  return reasons.length > 0 ? reasons.join("、") : null;
}

export function dangerOfPath(pathInput: string): string | null {
  if (pathInput === "*") return null; // 无可见路径的越界文件由别的机制兜底,这里不判。
  const raw = pathInput.startsWith("path:") ? pathInput.slice("path:".length) : pathInput;
  const segs = raw.split("/");
  const reasons: string[] = [];
  // 目录段(不含 basename)整段命中 .ssh/.aws —— 相对/绝对两形态同一扫描,不需 home 知识。
  if (segs.slice(0, -1).some((s) => s === ".ssh" || s === ".aws")) reasons.push("SSH/AWS 凭据目录");
  // basename 以 .env 结尾(.env / prod.env);.env.local 不以 .env 结尾 = 干净,契约钉死。
  const base = segs[segs.length - 1] ?? "";
  if (base.endsWith(".env")) reasons.push("*.env 密钥文件");
  return reasons.length > 0 ? reasons.join("、") : null;
}
