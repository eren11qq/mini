#!/bin/sh
# mini 一行安装(结构对齐 openai/codex scripts/install/install.sh)
#   curl -fsSL https://cdn.jsdelivr.net/gh/eren11qq/mini@main/install.sh | sh
#
# 装法:下载仓库源码 tarball -> 解到版本目录 ~/.local/share/mini/releases/<ver>
#      -> npm ci(仅生产依赖 ajv)-> current 符号链接原子切换 -> 生成启动器。
# 布局:
#   ~/.local/share/mini/releases/<ver>/   不可变版本目录(旧版本保留,可回滚)
#   ~/.local/share/mini/current           符号链接 -> releases/<ver>(换版本 = 换链接)
#   ~/.local/bin/mini                     启动器:node current/src/harness/cli.ts
# 重复执行:MINI_VERSION 钉到 tag/sha = 已装且完整则整步跳过(no-op);
#          默认 main(移动 ref)= 总是覆盖重装。--force / MINI_FORCE=1 强制重装。
# 并发:flock/lockf/mkdir 三级安装锁;所有落盘先暂存再原子 mv;trap 清 tmp/锁。
# 依赖:curl 或 wget / tar / node>=24 / npm。缺 = 明确报错退出,不半装。
#
# 参数(压过环境变量):
#   --version V   要装的 ref:tag/分支/40 位 commit(默认 main)
#   --force       等价 MINI_FORCE=1
#   --help        用法
# 可覆盖环境变量:
#   MINI_VERSION          要装的 ref(默认 main)
#   MINI_FORCE            1/true/yes = 即使已装也重装
#   MINI_REPO             user/repo(默认 eren11qq/mini)
#   MINI_ARCHIVE_BASE     tarball 域名基址(默认 https://github.com;换镜像只改这里)
#   MINI_ARCHIVE_URL      完整 tarball URL;设了就直接用,覆盖上面拼接
#   MINI_SHA256           tarball 的 sha256;设了必校验(发 Release 资产固定摘要后启用)
#   MINI_HOME             安装根目录(默认 $HOME/.local/share/mini;兼容旧 MINI_DEST)
#   MINI_INSTALL_DIR      启动器目录(默认 $HOME/.local/bin;兼容旧 MINI_BIN_DIR)
#   MINI_MODIFY_PATH      0/off = 不改 shell profile 只提示(默认改,marker 块幂等)
#   MINI_NON_INTERACTIVE  1/true/yes = 跳过结尾「现在启动?」询问(CI 用)
set -eu

REF="${MINI_VERSION:-main}"
FORCE="${MINI_FORCE:-false}"
REPO="${MINI_REPO:-eren11qq/mini}"
ARCHIVE_BASE="${MINI_ARCHIVE_BASE:-https://github.com}"
ARCHIVE_URL="${MINI_ARCHIVE_URL:-}"   # 留空 = parse_args 之后按最终 REF 拼(让 --version 生效)
EXPECTED_SHA256="${MINI_SHA256:-}"
MINI_HOME="${MINI_HOME:-${MINI_DEST:-$HOME/.local/share/mini}}"
BIN_DIR="${MINI_INSTALL_DIR:-${MINI_BIN_DIR:-$HOME/.local/bin}}"
MODIFY_PATH="${MINI_MODIFY_PATH:-on}"
NON_INTERACTIVE="${MINI_NON_INTERACTIVE:-false}"
CONNECT_TIMEOUT=10
ASSET_TIMEOUT=300
LOCK_STALE_AFTER_SECS=600

RELEASES_DIR="$MINI_HOME/releases"
CURRENT_LINK="$MINI_HOME/current"
LOCK_FILE="$MINI_HOME/install.lock"
LOCK_DIR="$MINI_HOME/install.lock.d"

path_action="already"
path_profile=""
lock_kind=""
tmp_dir=""

# ---------- 输出 ----------
step() { printf '==> %s\n' "$1"; }
warn() { printf 'WARNING: %s\n' "$1" >&2; }
die() { printf 'mini 安装失败:%s\n' "$1" >&2; exit 1; }

# ---------- 参数 ----------
parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --version)
        [ "$#" -ge 2 ] || die "--version 需要值"
        REF="$2"; shift ;;
      --force)
        FORCE="true" ;;
      --help | -h)
        cat <<EOF
Usage: install.sh [--version REF] [--force]

Environment:
  MINI_VERSION / MINI_FORCE / MINI_REPO / MINI_ARCHIVE_BASE / MINI_ARCHIVE_URL
  MINI_SHA256 / MINI_HOME / MINI_INSTALL_DIR / MINI_MODIFY_PATH / MINI_NON_INTERACTIVE
EOF
        exit 0 ;;
      *) die "未知参数: $1(--help 看用法)" ;;
    esac
    shift
  done
}

truthy() {
  case "$1" in
    1 | [Tt][Rr][Uu][Ee] | [Yy][Ee][Ss]) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------- 版本 ----------
# 目录名 = ref 去 v 前缀、/ 换 -;下载 URL 用原样 ref(GitHub tag 常带 v)。
normalize_version() {
  v="$1"
  case "$v" in v*) v="${v#v}" ;; esac
  printf '%s\n' "$v" | tr '/' '-'
}

validate_version() {
  case "$1" in
    "" | *[!A-Za-z0-9._-]*)
      die "非法 ref: '$1'(允许 tag/分支/commit,字符集 [A-Za-z0-9._-])" ;;
  esac
}

# 只有默认 main 视为移动 ref(总是重装);tag/sha 不可变,允许跳过重装。
ref_is_mutable() { [ "$REF" = "main" ]; }

# ---------- 依赖 / 下载 ----------
need() {
  command -v "$1" >/dev/null 2>&1 || die "缺 $1,请先装好再跑。"
}

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --connect-timeout "$CONNECT_TIMEOUT" --max-time "$ASSET_TIMEOUT" -o "$1" "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q --timeout="$ASSET_TIMEOUT" --tries=1 -O "$1" "$2"; }
else
  die "需要 curl 或 wget。"
fi

file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; return; fi
  if command -v shasum   >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; return; fi
  if command -v openssl  >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/^.*= //'; return; fi
  die "校验 sha256 需要 sha256sum/shasum/openssl 之一。"
}

verify_archive_digest() {
  [ -n "$EXPECTED_SHA256" ] || return 0
  actual="$(file_sha256 "$1")"
  if [ "$actual" != "$EXPECTED_SHA256" ]; then
    printf 'mini 安装失败:tarball sha256 不符。\nexpected: %s\nactual:   %s\n' "$EXPECTED_SHA256" "$actual" >&2
    exit 1
  fi
  step "sha256 校验通过"
}

# ---------- 完整性(幂等跳过的依据;对齐 codex release_dir_is_complete) ----------
release_is_complete() {
  dir="$1"
  [ -f "$dir/INSTALL_REF" ] || return 1
  [ "$(cat "$dir/INSTALL_REF" 2>/dev/null)" = "$REF" ] || return 1
  [ -f "$dir/src/harness/cli.ts" ] || return 1
  [ -f "$dir/package-lock.json" ] || return 1
  [ -d "$dir/node_modules/ajv" ] || return 1
}

current_matches() {
  [ -L "$CURRENT_LINK" ] || return 1
  cur="$(cd -P "$CURRENT_LINK" 2>/dev/null && pwd)" || return 1
  [ "$cur" = "$1" ]
}

# ---------- 安装锁(对齐 codex:lockf -> flock -> mkdir+stale 判定) ----------
mkdir_lock_is_stale() {
  [ -d "$LOCK_DIR" ] || return 1
  pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  started_at="$(cat "$LOCK_DIR/started_at" 2>/dev/null || true)"
  case "$started_at" in ''|*[!0-9]*) started_at=0 ;; esac
  now="$(date +%s 2>/dev/null || printf '0')"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then return 1; fi
  if [ "$started_at" -eq 0 ] || [ "$now" -eq 0 ]; then return 0; fi
  [ $((now - started_at)) -ge "$LOCK_STALE_AFTER_SECS" ]
}

acquire_install_lock() {
  mkdir -p "$MINI_HOME"
  if command -v lockf >/dev/null 2>&1; then
    : >>"$LOCK_FILE"; exec 9<>"$LOCK_FILE"; lockf 9; lock_kind="lockf"; return
  fi
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_FILE"; flock 9; lock_kind="flock"; return
  fi
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    if mkdir_lock_is_stale; then
      warn "清理过期安装锁 $LOCK_DIR"
      rm -rf "$LOCK_DIR"; continue
    fi
    sleep 1
  done
  printf '%s\n' "$$" >"$LOCK_DIR/pid"
  date +%s >"$LOCK_DIR/started_at" 2>/dev/null || true
  lock_kind="mkdir"
}

release_install_lock() {
  if [ "$lock_kind" = "mkdir" ]; then
    rm -rf "$LOCK_DIR" 2>/dev/null || true
  elif [ "$lock_kind" = "flock" ] || [ "$lock_kind" = "lockf" ]; then
    exec 9>&- 2>/dev/null || true
  fi
  lock_kind=""
}

cleanup() {
  release_install_lock
  [ -n "$tmp_dir" ] && rm -rf "$tmp_dir"
}

# ---------- 符号链接原子替换(对齐 codex:mv -Tf -> -hf -> rm+mv 回落链) ----------
replace_path_with_symlink() {
  link_path="$1"; link_target="$2"; tmp_link="$3"
  rm -f "$tmp_link"
  ln -s "$link_target" "$tmp_link"
  if mv -Tf "$tmp_link" "$link_path" 2>/dev/null; then return; fi
  if mv -hf "$tmp_link" "$link_path" 2>/dev/null; then return; fi
  rm -f "$link_path"; mv -f "$tmp_link" "$link_path"
}

# ---------- PATH profile(marker 块幂等;对齐 codex pick_profile/add_to_path) ----------
pick_profile() {
  case "$(uname -s 2>/dev/null):${SHELL:-}" in
    Darwin:*/zsh)  printf '%s\n' "$HOME/.zprofile" ;;
    Darwin:*/bash) printf '%s\n' "$HOME/.bash_profile" ;;
    Linux:*/zsh)   printf '%s\n' "$HOME/.zshrc" ;;
    Linux:*/bash)  printf '%s\n' "$HOME/.bashrc" ;;
    *)             printf '%s\n' "$HOME/.profile" ;;
  esac
}

append_path_block() {
  {
    printf '\n%s\n' "$1"
    printf '%s\n' "$3"
    printf '%s\n' "$2"
  } >>"$path_profile"
}

rewrite_path_block() {
  tmp_profile="$tmp_dir/profile.tmp.$$"
  awk -v begin="$1" -v end="$2" -v line="$3" '
    BEGIN { in_block = 0; replaced = 0 }
    $0 == begin { if (!replaced) { print begin; print line; print end; replaced = 1 }; in_block = 1; next }
    in_block { if ($0 == end) { in_block = 0 }; next }
    { print }
    END { if (in_block != 0) exit 1 }
  ' "$path_profile" >"$tmp_profile" || die "重写 profile 的 mini 块失败:$path_profile"
  mv "$tmp_profile" "$path_profile"
}

add_to_path() {
  path_action="already"; path_profile=""
  case ":$PATH:" in *":$BIN_DIR:"*) return ;; esac
  case "$MODIFY_PATH" in
    0 | [Ff][Aa][Ll][Ss][Ee] | off | [Nn][Oo]) path_action="hint"; return ;;
  esac
  path_profile="$(pick_profile)"
  begin_marker="# >>> mini installer >>>"
  end_marker="# <<< mini installer <<<"
  path_line="export PATH=\"$BIN_DIR:\$PATH\""
  if [ -f "$path_profile" ] && grep -F "$begin_marker" "$path_profile" >/dev/null 2>&1; then
    if grep -F "$path_line" "$path_profile" >/dev/null 2>&1; then
      path_action="configured"; return
    fi
    if grep -F "$end_marker" "$path_profile" >/dev/null 2>&1; then
      rewrite_path_block "$begin_marker" "$end_marker" "$path_line"
      path_action="updated"; return
    fi
  fi
  append_path_block "$begin_marker" "$end_marker" "$path_line"
  path_action="added"
}

# ---------- 询问(对齐 codex:curl|sh 时 stdin 非 tty,优先 /dev/tty) ----------
prompt_yes_no() {
  case "$NON_INTERACTIVE" in 1 | [Tt][Rr][Uu][Ee] | [Yy][Ee][Ss]) return 1 ;; esac
  if ( : </dev/tty ) 2>/dev/null; then
    printf '%s [y/N] ' "$1" >/dev/tty
    IFS= read -r answer </dev/tty || return 1
  elif [ -t 0 ]; then
    printf '%s [y/N] ' "$1"
    IFS= read -r answer || return 1
  else
    return 1
  fi
  case "$answer" in y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

# ---------- 冲突检测(对齐 codex;mini 无包管理器渠道,只报警不代卸) ----------
detect_conflicting_install() {
  existing="$(command -v mini 2>/dev/null || true)"
  [ -n "$existing" ] || return 0
  case "$existing" in
    "$BIN_DIR"/mini) return 0 ;;   # 本安装器自己的,马上覆盖/已是目标
  esac
  step "检测到 PATH 上已有 mini: $existing"
  warn "两处 mini 并存时以 PATH 顺序生效,建议删掉旧的那个。"
}

# ================= 主流程 =================
parse_args "$@"
validate_version "$REF"
VER="$(normalize_version "$REF")"
[ -n "$ARCHIVE_URL" ] || ARCHIVE_URL="$ARCHIVE_BASE/$REPO/archive/$REF.tar.gz"

need mktemp
need tar
need npm
need node
node -e 'const maj = Number(process.versions.node.split(".")[0]);
if (maj < 24) { console.error("mini 需要 node >= 24(原生跑 .ts),当前 " + process.versions.node); process.exit(1); }'

step "mini 安装  ref=$REF  ->  $MINI_HOME/releases/$VER"

RELEASE_DIR="$RELEASES_DIR/$VER"
if ! truthy "$FORCE" && ! ref_is_mutable && current_matches "$RELEASE_DIR" && release_is_complete "$RELEASE_DIR"; then
  step "已装且完整 —— 跳过重装(强制重装:--force)"
  exit 0
fi

tmp_dir="$(mktemp -d)"
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

acquire_install_lock

# 旧平铺布局(~/.local/share/mini 直接含 src/)且尚无 releases/ -> 移开保留再上新架构
# (必须在 mkdir releases/ 之前判,否则条件永远不成立)
if [ -d "$MINI_HOME/src/harness" ] && [ ! -d "$RELEASES_DIR" ]; then
  step "发现旧平铺安装,移到 $MINI_HOME.old.$$"
  release_install_lock
  mv "$MINI_HOME" "$MINI_HOME.old.$$" || die "旧目录移开失败,手动处理后再跑"
  acquire_install_lock
fi

# 清上次被中断留下的暂存物
mkdir -p "$RELEASES_DIR"
find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -name '.staging.*' -exec rm -rf {} + 2>/dev/null || true
find "$MINI_HOME" -mindepth 1 -maxdepth 1 -name '.current.*' -exec rm -f {} + 2>/dev/null || true

# 装前先看清路上的对手
detect_conflicting_install

step "下载源码 tarball:$ARCHIVE_URL"
fetch "$tmp_dir/src.tar.gz" "$ARCHIVE_URL"
verify_archive_digest "$tmp_dir/src.tar.gz"

step "解压到暂存目录"
STAGE="$RELEASES_DIR/.staging.$VER.$$"
rm -rf "$STAGE"
mkdir -p "$STAGE"
tar -xzf "$tmp_dir/src.tar.gz" -C "$STAGE" --strip-components=1
[ -f "$STAGE/src/harness/cli.ts" ] || die "tarball 里找不到 src/harness/cli.ts —— MINI_VERSION/MINI_REPO/镜像 是否对?"
printf '%s\n' "$REF" >"$STAGE/INSTALL_REF"

step "装依赖(仅生产:ajv;--ignore-scripts = 不跑任意脚本)"
cd "$STAGE"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent
cd "$MINI_HOME"

if [ -e "$RELEASE_DIR" ] || [ -L "$RELEASE_DIR" ]; then
  warn "目标版本目录已存在(不完整或强制重装),覆盖:$RELEASE_DIR"
  rm -rf "$RELEASE_DIR"
fi
mv "$STAGE" "$RELEASE_DIR"

step "切换 current -> releases/$VER(原子符号链接替换)"
replace_path_with_symlink "$CURRENT_LINK" "releases/$VER" "$MINI_HOME/.current.$$"

step "生成启动器 $BIN_DIR/mini"
mkdir -p "$BIN_DIR"
cat >"$BIN_DIR/mini.tmp.$$" <<EOF
#!/bin/sh
exec node "$MINI_HOME/current/src/harness/cli.ts" "\$@"
EOF
chmod 0755 "$BIN_DIR/mini.tmp.$$"
mv -f "$BIN_DIR/mini.tmp.$$" "$BIN_DIR/mini"

# 收尾自检(文件级;cli 是 TUI,不在安装期拉起)
release_is_complete "$CURRENT_LINK" || die "安装后自检失败:current 不完整"

add_to_path
release_install_lock

step "已安装:mini ref=$REF($RELEASE_DIR)"
case "$path_action" in
  added)      step "PATH 已写入 $path_profile —— 当前终端先执行:export PATH=\"$BIN_DIR:\$PATH\"" ;;
  updated)    step "PATH 已更新 $path_profile —— 当前终端先执行:export PATH=\"$BIN_DIR:\$PATH\"" ;;
  configured) step "PATH 已在 $path_profile 配置过" ;;
  hint)       step "PATH 未含 $BIN_DIR —— 自己加一句:export PATH=\"$BIN_DIR:\$PATH\"" ;;
  *)          step "$BIN_DIR 已在 PATH" ;;
esac
step "回滚旧版本:ln -sfn releases/<ver> $CURRENT_LINK"
step "开跑:export DEEPSEEK_API_KEY=sk-... && mini   (--model <alias> 选厂商,密钥只从 env 读)"

if prompt_yes_no "现在启动 mini?"; then
  step "启动 mini"
  exec "$BIN_DIR/mini"
fi
printf 'mini %s 安装成功。\n' "$REF"
