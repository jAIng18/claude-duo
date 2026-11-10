# claude-duo

Let two Claude Code accounts on the same Mac hand work to each other. Account **A** can give a task to account **B** (or the other way round), and the result comes back to the conversation that asked for it.

## Requirements

- macOS, using Terminal.app or iTerm2
- Claude Code installed
- Two Claude accounts

Node and tmux are installed automatically if they are missing.

## Setup

```bash
git clone <repo-url> ~/claude-duo
cd ~/claude-duo
./install.sh
```

Then:

1. **Log in to the second account** (one time only). Open a new terminal and run `claude-b`. Type `/login`, sign in with your second account, then type `/exit`.
2. **Configure.** Run `claude-a`, then type `/duo:setup` and answer a few questions (names, roles, how each side receives work).
3. **Test.** Type `/duo:test`. If you see `pong`, it works.

> Keep the repo folder where it is: the plugin runs from it. If you move it, run `./install.sh` again.

## Usage

Start the two accounts with `claude-a` and `claude-b` instead of `claude`.

| To | Do |
|---|---|
| Give work to the other account | Just ask, e.g. *"Send B a task: write tests for login.ts"*, or `/duo:send <task>` |
| See waiting messages | `/duo:inbox` |
| See the overall status | `/duo:status` |
| Change settings | `/duo:config <what to change>` |

By default, Claude shows you the draft and asks before sending anything.

### How the receiving side runs (set per direction)

| Mode | What happens |
|---|---|
| `new-tab` (default) | Opens a new Terminal window so you can watch the other account work |
| `background` | Runs silently and remembers earlier tasks. Watch it with `duo attach B` |
| `live-session` | Types the task into the other account's window that is already open (started with `claude-a` / `claude-b`) |

## Troubleshooting

- Run `duo doctor` in a terminal. It checks everything and tells you how to fix each problem.
- **"Stop hook error: [claude-duo] …"** is normal. It is how Claude Code shows claude-duo asking it to continue.
- **`workspace_not_trusted`** (background mode): in that folder, run `claude-b` once, choose **Yes** when asked to trust the folder, then `/exit`.

## Uninstall

```bash
duo uninstall           # remove plugin, permissions and aliases
duo uninstall --purge   # also delete ~/.claude-duo
```

Developer details: [`docs/SPEC.md`](docs/SPEC.md). Run the tests with `npm test`.
