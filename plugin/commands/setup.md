---
description: Set up claude-duo (names, roles, how the two accounts hand work to each other)
---
You are helping the user set up **claude-duo**, which lets the two Claude Code accounts on this Mac hand work to each other. Talk to the user in **their** language, briefly, at most 2–3 questions at a time. The user may not be a developer: avoid jargon and use examples. Everything you write into the configuration (names, roles) must be in **English**, because the two peers talk to each other in English.

Steps:

1. Call `duo_config` with `action: "get"`. If a configuration exists, summarise it and ask what to change (then use `action: "set"`). Otherwise continue.
2. Ask which config folder the second account uses (default `~/.claude-b`; the current account is `~/.claude`). Usually keep the default.
3. Ask what they want to use it for and the roles of A and B. Offer the example packs from `duo_examples` (`action: "list"`) — e.g. Dev (planner ↔ coder), Design (ideator ↔ critic), PM (PRD writer ↔ reviewer), Research — or let them describe the roles themselves (you write the role text in English).
4. Explain how the receiving side runs, per direction (A→B and B→A):
   - **background** (default, recommended): runs silently, no extra windows; the result comes back to the conversation that asked. It remembers earlier tasks. The receiving account must have trusted the working folder once.
   - **new-tab**: opens a new Terminal window so the user can watch it work.
   - **live-session**: types the task into the other account's window that is already open (only windows started with `claude-a` / `claude-b`, which run inside tmux; a plain `claude` window cannot receive typed messages).
5. Ask whether they want to **approve each message before it is sent** (default: yes).
6. Show a summary table of the configuration. When the user agrees, call `duo_config` with `action: "init"`, `user_confirmed: true`, `values` = the chosen values (e.g. `{"peers":{"A":{"name":"Planner","role":"..."},"B":{"name":"Maker","role":"...","config_dir":"~/.claude-b"}},"delivery":{"A_to_B":"background","B_to_A":"background","fallback":"none"},"approval":{"before_send":"ask","before_accept":"auto"}}`).
7. If they chose an example pack: call `duo_examples` with `action: "install"`, `name`, `user_confirmed: true`.
8. Finish by suggesting `/duo:test`. Account A is opened with plain `claude`; account B with `claude-b`. If the second account is not logged in yet: open a new terminal, run `claude-b`, then `/login`. For background mode, the second account must trust each working folder once: `cd <folder> && claude-b`, answer "Yes", then `/exit`.

Never set `spawn.permission_mode` to `bypassPermissions`.
