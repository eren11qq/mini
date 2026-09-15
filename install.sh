#!/bin/sh
# mini 一行安装(pi 式入口,全程零 npm):
#   curl -fsSL https://eren11qq.github.io/mini/install.sh | sh
#
# 干的事:拉本仓库源码 tarball(codeload = GitHub 归档真实资产域,本环境实测可达而 github.com 拒连)
#      → 解到 ~/.local/share/mini → 从 registry.npmjs.org 用 curl+tar 拼出 node_modules(prod 依赖仅 5 包)
#      → 写启动器 ~/.local/bin/mini(node>=24 原生跑 .ts,零构建)。
# 重复执行 = 原子重装(拉最新 main)。
#
# 可覆盖环境变量:
#   MINI_VERSION     要装的 ref:tag/分支/commit(默认 main)
#   MINI_REPO        user/repo(默认 eren11qq/mini)
#   MINI_ARCHIVE_URL 完整源码 tarball URL 或本地 .tgz(默认 codeload 拼法;测试/镜像代理用)
#   MINI_REGISTRY    依赖源(默认 https://registry.npmjs.org;国内可换 npmmirror)
#   MINI_DEST        源码目录(默认 $HOME/.local/share/mini)
#   MINI_BIN_DIR     启动器目录(默认 $HOME/.local/bin)
set -eu

REPO="${MINI_REPO:-eren11qq/mini}"
VERSION="${MINI_VERSION:-main}"
ARCHIVE_URL="${MINI_ARCHIVE_URL:-https://codeload.github.com/$REPO/tar.gz/$VERSION}"
REGISTRY="${MINI_REGISTRY:-https://registry.npmjs.org}"
DEST="${MINI_DEST:-$HOME/.local/share/mini}"
BIN_DIR="${MINI_BIN_DIR:-$HOME/.local/bin}"

# prod 依赖锁版清单 —— 升 package.json 依赖时同步这里(与 package-lock.json 一致的 5 包闭包)。
DEPS="ajv@8.20.0 fast-deep-equal@3.1.3 fast-uri@3.1.7 json-schema-traverse@1.0.0 require-from-string@2.0.2"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "mini 安装失败:缺 $1。" >&2; exit 1; }
}
{ command -v curl >/dev/null 2>&1 || need wget; }
need tar
need node
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) { console.error("mini 需要 node>=24(原生跑 .ts),当前 " + process.version); process.exit(1) }'

grab() { # grab <url> <outfile>:curl 优先,wget 兜底
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"; else wget -qO "$2" "$1"; fi
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "==> 获取源码:$ARCHIVE_URL"
case "$ARCHIVE_URL" in
  *://*) grab "$ARCHIVE_URL" "$TMP/src.tar.gz" ;;
  *) cp "$ARCHIVE_URL" "$TMP/src.tar.gz" ;; # 本地 .tgz(测试/离线)
esac

echo "==> 安装到 $DEST"
rm -rf "$DEST.new"
mkdir -p "$DEST.new"
tar -xzf "$TMP/src.tar.gz" -C "$DEST.new" --strip-components=1
rm -rf "$DEST"
mv "$DEST.new" "$DEST"

echo "==> 拉取 prod 依赖($REGISTRY)"
mkdir -p "$DEST/node_modules"
for spec in $DEPS; do
  name=${spec%@*}
  ver=${spec#*@}
  grab "$REGISTRY/$name/-/$name-$ver.tgz" "$TMP/$name.tgz"
  rm -rf "$TMP/$name"
  mkdir -p "$TMP/$name"
  tar -xzf "$TMP/$name.tgz" -C "$TMP/$name" --strip-components=1 # npm tarball 根 = package/
  rm -rf "$DEST/node_modules/$name"
  mv "$TMP/$name" "$DEST/node_modules/$name"
  echo "    ✓ $name@$ver"
done

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/mini" <<EOF
#!/bin/sh
exec node "$DEST/src/harness/cli.ts" "\$@"
EOF
chmod +x "$BIN_DIR/mini"

echo "✓ mini 已安装:$BIN_DIR/mini ($REPO@$VERSION)"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "提示:$BIN_DIR 不在 PATH,加一行:export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
