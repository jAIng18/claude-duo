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
| A (your usual account, `~/.claude`) | `claude`, as always |
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
