#!/bin/sh
# mini 一行安装:curl -fsSL https://raw.githubusercontent.com/eren11qq/mini/main/install.sh | sh
# 装法 = 浅克隆仓库到 ~/.local/share/mini + 生成启动器 ~/.local/bin/mini(node 24 直跑 .ts,零构建)。
# 重复执行 = 增量更新(fetch+reset),可改通道 MINI_BRANCH=feat/xxx。
# 依赖:git / npm / node>=24(TS type stripping)。缺 = 明确报错退出,不静默半装。
set -eu

REPO_URL="${MINI_REPO_URL:-https://github.com/eren11qq/mini.git}"
BRANCH="${MINI_BRANCH:-main}"
DEST="${MINI_DEST:-$HOME/.local/share/mini}"
BIN_DIR="${MINI_BIN_DIR:-$HOME/.local/bin}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "mini 安装失败:缺 $1,请先装好再跑。" >&2
    exit 1
  }
}
need git
need npm
need node
node -e 'const maj = Number(process.versions.node.split(".")[0]);
if (maj < 24) { console.error("mini 需要 node >= 24(原生跑 .ts),当前 " + process.versions.node); process.exit(1); }'

if [ -d "$DEST/.git" ]; then
  echo "更新 $DEST@$BRANCH"
  git -C "$DEST" fetch --depth 1 origin "$BRANCH"
  git -C "$DEST" reset --hard FETCH_HEAD
else
  echo "克隆 $REPO_URL ($BRANCH) -> $DEST"
  mkdir -p "$(dirname "$DEST")"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$DEST"
fi

echo "装依赖(仅生产:ajv;--ignore-scripts = 跳过仓库 prepare:husky 开发钩子,生产装不跑任意脚本)"
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
