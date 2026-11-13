# claude-duo switch: makes a plain `claude` open the account picked in
# `duo monitor` or with `duo switch` (sourced from ~/.zshrc by install.sh).
#
# It asks `duo switch --resolve` on every launch, so a switch applies to the
# next `claude` in every terminal, no need to open a new one. It changes
# nothing when you set CLAUDE_CONFIG_DIR yourself, or inside a Claude session
# (CLAUDECODE is set there), and falls back to plain `claude` on any problem.

typeset -g _CLAUDE_DUO_JS="${${(%):-%x}:A:h:h}/bin/duo.mjs"

# An earlier `alias claude=…` (older Claude Code installs add one) would hide
# the function: keep what it ran, then drop the alias.
typeset -g _CLAUDE_DUO_REAL=""
if (( ${+aliases[claude]} )); then
  _CLAUDE_DUO_REAL="${aliases[claude]}"
  unalias claude
fi

function _claude_duo_run {
  if [[ -n "$_CLAUDE_DUO_REAL" ]]; then ${~=_CLAUDE_DUO_REAL} "$@"; else command claude "$@"; fi
}

function claude {
  if [[ -z "${CLAUDE_CONFIG_DIR-}" && -z "${CLAUDECODE-}" && -r "$_CLAUDE_DUO_JS" ]]; then
    local _duo_dir
    _duo_dir="$(node "$_CLAUDE_DUO_JS" switch --resolve 2>/dev/null)"
    if [[ -n "$_duo_dir" && -d "$_duo_dir" ]]; then
      CLAUDE_CONFIG_DIR="$_duo_dir" _claude_duo_run "$@"
      return
    fi
  fi
  _claude_duo_run "$@"
}
