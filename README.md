# claude-duo

Let two Claude Code accounts on the same Mac hand work to each other. Account **A** can give a task to account **B** (or the other way round), and the result comes back to the conversation that asked for it.

## Requirements

- macOS, using Terminal.app or iTerm2 (zsh, the default macOS shell)
- [Claude Code](https://docs.claude.com/claude-code) installed, with the `claude` command working in a terminal
- Two Claude accounts (for example a personal one and a work one)

Node (18 or newer) and tmux are installed automatically through [Homebrew](https://brew.sh) if they are missing. If Homebrew itself is missing, the installer installs it too, and it may ask for your Mac login password.

## Installation

### 1. Install Claude Code and log in to the first account

Skip this if `claude` already works for you.

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Open a new terminal, run `claude`, type `/login` and sign in with your **first** account (account A). Then type `/exit`.

### 2. Download claude-duo and run the installer

```bash
git clone https://github.com/jAIng18/claude-duo.git ~/claude-duo
cd ~/claude-duo
./install.sh
```

The installer is safe to run again at any time. It:

- checks for macOS, Homebrew, Node, tmux and Claude Code, and installs what is missing (except Claude Code);
- creates the claude-duo settings and mailbox in `~/.claude-duo/`;
- installs the `duo` plugin for **both** accounts: account A uses `~/.claude`, account B uses `~/.claude-b`;
- allows the `duo_*` tools in advance, so Claude does not ask for permission every time;
- adds three commands to `~/.zshrc`: `duo`, `claude-b` (opens account B) and `claude-a` (optional, see [Opening the two accounts](#opening-the-two-accounts));
- runs `duo doctor` at the end and prints the next steps.

Options:

| Option | Effect |
|---|---|
| `--b-dir <folder>` | Use another config folder for account B (default `~/.claude-b`). It must not be `~/.claude`. |
| `--no-alias` | Do not change `~/.zshrc`. You then call `node ~/claude-duo/plugin/bin/duo.mjs …` yourself. |

When it finishes, **open a new terminal** (or run `source ~/.zshrc`) so the new commands work.

> Keep the repo folder where it is: the plugin runs from it. If you move it, run `./install.sh` again.

### 3. Log in to the second account (one time only)

```bash
claude-b
```

Type `/login`, sign in with your **second** account, then type `/exit`.

### 4. Configure

```bash
claude
```

Type `/duo:setup` and answer a few questions: names, roles (or a ready-made pack such as Dev, Design, PM or Research), how each side receives work, and whether you approve each message before it is sent.

### 5. Trust your project folders for both accounts

Claude Code only works in a folder after the account has trusted it, and each account remembers this separately. For every folder you want the two accounts to work in, do this once:

```bash
cd ~/path/to/your-project
claude-b    # choose "Yes" when asked to trust the folder, then /exit
claude      # the same for account A, if you have not opened this folder with it before
```

If you skip this, messages wait in the queue with `workspace_not_trusted` and are delivered as soon as the folder is trusted.

### 6. Test

In `claude`, type `/duo:test`. If B answers `pong`, everything works. You can also run `duo doctor` in a terminal at any time.

## Updating

```bash
cd ~/claude-duo
git pull
./install.sh
```

Then restart any open `claude` / `claude-b` sessions.

## Usage

### Opening the two accounts

| Account | Open it with |
|---|---|
| A (your usual account, `~/.claude`) | `claude`, as always (or whichever account you switched to, see [Switching accounts](#switching-accounts)) |
| B (the second account, `~/.claude-b`) | `claude-b` |

Plain `claude` already loads claude-duo for account A, so nothing changes in how you start Claude.

`claude-a` does the same, but runs the session inside tmux. You only need it if you want messages **typed straight into that open window**: the `live-session` mode, or a result showing up while the window is idle. In a plain `claude` window, a result arrives while Claude is waiting for it, or at your next message.

| To | Do |
|---|---|
| Give work to the other account | Just ask, e.g. *"Send B a task: write tests for login.ts"*, or `/duo:send <task>` |
| See waiting messages | `/duo:inbox` |
| See the overall status | `/duo:status` |
| Change settings | `/duo:config <what to change>` |
| See past work: how long each task waited and ran, tokens and estimated cost | `/duo:log` (e.g. `/duo:log B this week`), or `duo log` in a terminal (`duo log B` = only work done by B, `--days 7`, `--limit 50`, `--json`) |

By default, Claude shows you the draft and asks before sending. The other account then works **in the background** (no extra windows) and the result comes back in the same conversation. The two Claudes talk to each other in English; they still talk to you in your language.

### How the receiving side runs (set per direction)

| Mode | What happens |
|---|---|
| `background` (default) | Runs silently, remembers earlier tasks, sends the result back. Peek at it with `duo attach B` |
| `new-tab` | Opens a new Terminal window so you can watch the other account work |
| `live-session` | Types the task into the other account's window that is already open (started with `claude-a` / `claude-b`, which run inside tmux) |

Change it with `/duo:config`, e.g. *"show B's work in a new window"*.

### Watching the quota of both accounts

```bash
duo monitor          # small window; run it again to bring it to the front, `duo monitor stop` closes it
duo quota            # the same numbers once, in the terminal (--json for scripts)
```

The window shows, for each account: the plan, the 5-hour and weekly limits (the same numbers as `/usage`) with time until reset, whether the account is working, idle or waiting for you, open claude-duo tasks, and the tokens used in the last 5 hours. The account that a plain `claude` opens is marked **IN USE**; click the other one to switch (see below). The arrows button shrinks it to just the two account icons (a dot shows each one's state, a ring marks the one in use; hover for the numbers, click an icon to switch to it). Next to them, ↗ opens the full view again and × quits.

It behaves like any other app: it has a Dock icon, shows up in Cmd+Tab and goes behind other apps when you switch away. The pin button keeps it on top of every window (and on every Space) until you unpin it. Drag it anywhere; it remembers where you left it. Cmd+Q or × quits.

- It updates on its own: activity shows within a second or two; the quota percentages are asked again at most every 20 s while an account works, every 2 min when idle.
- The first `duo monitor` builds the window with Xcode Command Line Tools (`xcode-select --install` if missing), about 30 s.
- Each account's login token is read from the macOS Keychain and sent only to Anthropic's usage endpoint. That endpoint is not a public API, so it may change; if it fails, the window says so and keeps the last known numbers.
- **"Login expired"**: the account has not been used for a while, so its login token expired. Open it once (`claude` or `claude-b`) and the numbers come back by themselves.

### Switching accounts

When one account runs low, make a plain `claude` open the other one, by hand or automatically.

| To | In the `duo monitor` window | In a terminal |
|---|---|---|
| Use account B for `claude` | click B's card | `duo switch B` |
| Back to A | click A's card | `duo switch A` |
| Switch on its own when the account in use is nearly used up | **Auto** at the bottom; pick the level with **at 90%** | `duo switch auto --at 90` |
| Only switch when I say so | **Manual** | `duo switch manual` |
| See which account `claude` opens | `claude → A` at the bottom | `duo switch` |

- It applies to the **next** `claude` you start, in every terminal: no need to open a new one. Sessions already open keep their account (Claude Code cannot move a running session to another login).
- Nothing about the logins changes: each account keeps its own folder and Keychain entry, and no token is copied or refreshed. The installer adds a small `claude` function to `~/.zshrc` that asks claude-duo which folder to use each time.
- **Auto** looks at the higher of the 5-hour and weekly percentages. When the account in use reaches the level you chose (default 90%) and the other account is logged in and below it, `claude` moves to the other one and you get a notification. It does not switch back by itself until that account fills up in turn. It checks while `duo monitor` is open, and again every time you type `claude`.
- Clicking an account while **Auto** is on switches to it and turns Auto off, so it does not jump straight back.
- The session started by `claude` takes the role of the account it opens: after switching to B, it is peer B for claude-duo.
- Your history stays per account: `claude --resume` shows only the sessions of the account in use.
- If you set `CLAUDE_CONFIG_DIR` yourself, `claude` follows it and ignores the switch. `claude-b` always opens B.
- Installed before this feature? Run `./install.sh` again and open a new terminal.

## Troubleshooting

- Run `duo doctor` in a terminal. It checks everything and tells you how to fix each problem.
- **"Stop hook error: [claude-duo] …"** is normal. It is how Claude Code shows claude-duo asking it to continue.
- **`auth_required`**: the second account is not logged in yet. Run `claude-b`, type `/login`, sign in, then `/exit`. Anything sent before that waits in the queue and is delivered automatically once the account is logged in — no need to resend.
- **`workspace_not_trusted`**: the receiving account has not trusted that folder yet. In that folder, run `claude-b` (or `claude` for account A) once, choose **Yes** when asked to trust the folder, then `/exit`. Do this once per project folder.

## Uninstall

```bash
duo uninstall           # remove plugin, permissions and aliases
duo uninstall --purge   # also delete ~/.claude-duo
```

Developer details: [`docs/SPEC.md`](docs/SPEC.md). Run the tests with `npm test`.
