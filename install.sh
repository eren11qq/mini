#!/bin/sh
# mini 一行安装
#   curl -fsSL https://cdn.jsdelivr.net/gh/eren11qq/mini@main/install.sh | sh
#
# 装法:下载仓库源码 tarball -> 解到 ~/.local/share/mini -> npm ci(仅生产依赖 ajv)
#      -> 生成启动器 ~/.local/bin/mini(node>=24 原生跑 .ts,零构建)。
# jsDelivr 只发单文件(本 install.sh 走它),源码整包取自 GitHub archive。
# 重复执行 = 覆盖重装(下载新 tarball 原子替换,不再依赖 git)。
# 依赖:curl 或 wget / tar / node>=24 / npm。缺 = 明确报错退出,不半装。
#
# 可覆盖环境变量:
#   MINI_VERSION      要装的 ref:tag/分支/commit(默认 main;发版后建议 v0.1.0)
#   MINI_REPO         user/repo(默认 eren11qq/mini)
#   MINI_ARCHIVE_BASE tarball 域名基址(默认 https://github.com;换镜像只改这里)
#   MINI_ARCHIVE_URL  完整 tarball URL;设了就直接用(可指向 GitHub Release 资产或国内代理),覆盖上面拼接
#   MINI_DEST         源码目录(默认 $HOME/.local/share/mini)
#   MINI_BIN_DIR      启动器目录(默认 $HOME/.local/bin)
set -eu

REPO="${MINI_REPO:-eren11qq/mini}"
VERSION="${MINI_VERSION:-main}"
ARCHIVE_BASE="${MINI_ARCHIVE_BASE:-https://github.com}"
ARCHIVE_URL="${MINI_ARCHIVE_URL:-$ARCHIVE_BASE/$REPO/archive/$VERSION.tar.gz}"
DEST="${MINI_DEST:-$HOME/.local/share/mini}"
BIN_DIR="${MINI_BIN_DIR:-$HOME/.local/bin}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "mini 安装失败:缺 $1,请先装好再跑。" >&2
    exit 1
  }
}

# 下载器:curl 优先,退而求其次 wget
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL -o "$1" "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$1" "$2"; }
else
  echo "mini 安装失败:需要 curl 或 wget。" >&2
  exit 1
fi

need tar
need npm
need node
node -e 'const maj = Number(process.versions.node.split(".")[0]);
if (maj < 24) { console.error("mini 需要 node >= 24(原生跑 .ts),当前 " + process.versions.node); process.exit(1); }'

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

echo "下载源码 tarball:$ARCHIVE_URL"
fetch "$TMP/src.tar.gz" "$ARCHIVE_URL"

echo "解压 -> $DEST(原子替换,先解到暂存目录)"
STAGE="$DEST.new.$$"
mkdir -p "$STAGE"
tar -xzf "$TMP/src.tar.gz" -C "$STAGE" --strip-components=1
[ -f "$STAGE/src/harness/cli.ts" ] || {
  echo "mini 安装失败:tarball 里找不到 src/harness/cli.ts —— MINI_VERSION/MINI_REPO/镜像 是否对?" >&2
  exit 1
}
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
mv "$STAGE" "$DEST"

echo "装依赖(仅生产:ajv;--ignore-scripts = 跳过 prepare:husky 开发钩子,生产装不跑任意脚本)"
cd "$DEST"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent

mkdir -p "$BIN_DIR"
cat >"$BIN_DIR/mini" <<EOF
#!/bin/sh
exec node "$DEST/src/harness/cli.ts" "\$@"
EOF
chmod +x "$BIN_DIR/mini"

echo "已安装:$BIN_DIR/mini"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "PATH 未含 $BIN_DIR —— 加一句:export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
echo "开跑:export DEEPSEEK_API_KEY=sk-... && mini   (--model <alias> 选厂商,密钥只从 env 读)"
