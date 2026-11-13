#!/usr/bin/env bash
# claude-duo installer (macOS). Safe to run again: every step is idempotent.
#
#   ./install.sh                 # account B uses ~/.claude-b
#   ./install.sh --b-dir ~/x     # custom config dir for account B
#   ./install.sh --no-alias      # do not touch ~/.zshrc
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN="$REPO/plugin"
DUO="$PLUGIN/bin/duo.mjs"
MARKETPLACE="claude-duo"
PLUGIN_ID="duo@$MARKETPLACE"
B_DIR="$HOME/.claude-b"
ALIASES=1

while [ $# -gt 0 ]; do
  case "$1" in
    --b-dir) B_DIR="$2"; shift 2 ;;
    --b-dir=*) B_DIR="${1#--b-dir=}"; shift ;;
    --no-alias) ALIASES=0; shift ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "Tham số không rõ: $1" >&2; exit 2 ;;
  esac
done

# Normalise B_DIR exactly like claude-duo does (absolute, no "~", no trailing "/").
case "$B_DIR" in "~") B_DIR="$HOME" ;; "~/"*) B_DIR="$HOME/${B_DIR#\~/}" ;; esac
while [ "${B_DIR%/}" != "$B_DIR" ] && [ "$B_DIR" != "/" ]; do B_DIR="${B_DIR%/}"; done
case "$B_DIR" in /*) ;; *) B_DIR="$PWD/$B_DIR" ;; esac
if [ "$B_DIR" = "$HOME/.claude" ]; then echo "❌ Tài khoản B không được dùng ~/.claude (đó là tài khoản A)." >&2; exit 1; fi

step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  ✅ %s\n' "$*"; }
info() { printf '  • %s\n' "$*"; }
die()  { printf '  ❌ %s\n' "$*" >&2; exit 1; }

# Run claude for peer A (default config dir: CLAUDE_CONFIG_DIR must be UNSET)
# or peer B (explicit, normalised dir). See docs/SPEC.md §4.3.
claude_a() { env -u CLAUDE_CONFIG_DIR claude "$@"; }
claude_b() { env CLAUDE_CONFIG_DIR="$B_DIR" claude "$@"; }

step "Kiểm tra hệ điều hành"
[ "$(uname -s)" = "Darwin" ] || die "claude-duo hiện chỉ hỗ trợ macOS."
ok "macOS $(sw_vers -productVersion) ($(uname -m))"

step "Homebrew"
for p in /opt/homebrew/bin /usr/local/bin; do
  case ":$PATH:" in *":$p:"*) ;; *) [ -d "$p" ] && PATH="$PATH:$p" ;; esac
done
export PATH
if ! command -v brew >/dev/null 2>&1; then
  info "Chưa có Homebrew. Sẽ cài Homebrew (trình quản lý phần mềm cho macOS) để cài node và tmux."
  info "Bước này có thể hỏi mật khẩu đăng nhập máy Mac của bạn."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
  command -v brew >/dev/null 2>&1 || die "Cài Homebrew không thành công. Xem https://brew.sh rồi chạy lại ./install.sh"
fi
ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"

step "Phụ thuộc (tự cài nếu thiếu, có rồi thì bỏ qua)"
for pkg in node tmux; do
  if command -v "$pkg" >/dev/null 2>&1; then
    ok "$pkg đã có ($(command -v "$pkg"))"
  else
    info "Đang cài $pkg…"
    HOMEBREW_NO_AUTO_UPDATE=1 brew install "$pkg" >/dev/null
    command -v "$pkg" >/dev/null 2>&1 || die "Cài $pkg thất bại"
    ok "Đã cài $pkg"
  fi
done
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "Node $(node -v) quá cũ (cần ≥ 18): brew upgrade node"

step "Claude Code"
for p in "$HOME/.local/bin"; do case ":$PATH:" in *":$p:"*) ;; *) [ -d "$p" ] && PATH="$p:$PATH" ;; esac; done
command -v claude >/dev/null 2>&1 || die "Chưa có lệnh claude. Cài Claude Code trước (https://docs.claude.com/claude-code) rồi chạy lại."
ok "Claude Code $(claude --version 2>/dev/null | awk '{print $1}')"

step "Cấu hình claude-duo"
node "$DUO" init --a-dir "$HOME/.claude" --b-dir "$B_DIR" | sed 's/^/  /'

install_for() { # $1 = A|B
  local peer="$1" run
  if [ "$peer" = A ]; then run=claude_a; else run=claude_b; fi
  if $run plugin marketplace list 2>/dev/null | grep -q "$MARKETPLACE"; then
    $run plugin marketplace update "$MARKETPLACE" >/dev/null 2>&1 || true
    info "$peer: marketplace $MARKETPLACE đã có (đã cập nhật)"
  else
    $run plugin marketplace add "$REPO" >/dev/null || die "$peer: không thêm được marketplace từ $REPO"
    info "$peer: đã thêm marketplace $MARKETPLACE"
  fi
  if $run plugin list 2>/dev/null | grep -q "$PLUGIN_ID"; then
    $run plugin update "$PLUGIN_ID" >/dev/null 2>&1 || true
    info "$peer: plugin $PLUGIN_ID đã có"
  else
    $run plugin install "$PLUGIN_ID" >/dev/null || die "$peer: cài plugin thất bại"
    info "$peer: đã cài plugin $PLUGIN_ID"
  fi
  $run plugin enable "$PLUGIN_ID" >/dev/null 2>&1 || true
  ok "$peer: plugin sẵn sàng"
}

step "Cài plugin cho cả 2 tài khoản"
install_for A
install_for B

step "Cho phép sẵn các tool duo (không bị hỏi quyền mỗi lần)"
node "$DUO" install-permissions | sed 's/^/  /'

if [ "$ALIASES" = 1 ]; then
  step "Alias trong ~/.zshrc"
  RC="$HOME/.zshrc"
  touch "$RC"
  BEGIN="# >>> claude-duo >>>"; END="# <<< claude-duo <<<"
  TMP="$(mktemp)"
  awk -v b="$BEGIN" -v e="$END" '$0==b{skip=1;next} $0==e{skip=0;next} !skip' "$RC" > "$TMP"
  {
    cat "$TMP"
    echo "$BEGIN"
    echo "# Quản lý bởi $REPO/install.sh — đừng sửa tay trong khối này."
    printf "alias duo='node \"%s\"'\n" "$DUO"
    printf "alias claude-a='node \"%s\" open A --'\n" "$DUO"
    printf "alias claude-b='node \"%s\" open B --'\n" "$DUO"
    echo "# claude-duo switch: \`claude\` mở account đang chọn (duo monitor / duo switch)"
    printf "source \"%s\"\n" "$REPO/plugin/shell/claude-switch.zsh"
    echo "$END"
  } > "$TMP.new"
  cmp -s "$RC" "$TMP.new" || { cp "$RC" "$RC.bak-claude-duo"; mv "$TMP.new" "$RC"; }
  rm -f "$TMP" "$TMP.new"
  ok "duo, claude (mở account đang chọn), claude-b, claude-a (mở terminal mới hoặc chạy: source ~/.zshrc)"
fi

step "Kiểm tra"
node "$DUO" doctor | sed 's/^/  /' || true

# `claude auth status` exits non-zero when logged out: never let that abort the script.
B_STATUS="$(claude_b auth status --json 2>/dev/null || true)"
B_LOGGED_IN="$(printf '%s' "$B_STATUS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).loggedIn?1:0)}catch{console.log(0)}})' || echo 0)"

cat <<EOF

────────────────────────────────────────────────────────────
✅ Cài xong claude-duo.

Bước tiếp theo:
EOF
if [ "$B_LOGGED_IN" != 1 ]; then
  cat <<EOF
  1. Mở terminal MỚI, gõ:   claude-b
     rồi gõ /login và đăng nhập bằng TÀI KHOẢN THỨ HAI. Gõ /exit khi xong.
EOF
else
  echo "  1. Tài khoản B đã đăng nhập ✅"
fi
cat <<EOF
  2. Mở terminal mới, gõ:   claude       rồi gõ:  /duo:setup
     (tài khoản A mở bằng claude như bình thường; tài khoản B mở bằng claude-b)
     (chọn tên, vai trò, cách giao nhận cho 2 tài khoản)
  3. Gõ /duo:test để thử gửi một việc sang tài khoản kia.

Giữ nguyên thư mục này ($REPO): plugin chạy trực tiếp từ đây.
Gỡ cài đặt: duo uninstall   (thêm --purge để xóa cả dữ liệu)
EOF
