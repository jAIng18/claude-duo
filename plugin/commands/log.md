---
description: History of work handed between the two accounts (time, tokens, estimated cost)
argument-hint: "[A|B] [last N days] [N rows]"
---
Call `duo_log` once. Map the user's words to its arguments: a peer name or letter → `peer` (only work done by that peer), "today" / "this week" / "last N days" → `days` (1 / 7 / N), a row count → `limit`. Arguments given: $ARGUMENTS

Every value in the result is already formatted (times are in the local timezone given in `timezone`). Copy them as they are; do not convert or recompute anything. Show, in the user's language:
1. A compact markdown table, oldest first: `sent`, `direction`, `status`, `wait`, `work`, `tokens_in` / `tokens_out`, `cost`, `title` (shortened).
2. One line per direction from `totals`: count, done / failed / unfinished, total `work`, `tokens_in` / `tokens_out`, `cost` (add "known for `known_cost` tasks" only when it is not all of them).
3. Short notes only where they matter: a `-` cost means the cost is not known for that task alone (Claude Code records it only when a session stops: the session may still be open, or it did other work before stopping; the tokens are still exact); the cost is an API-price estimate for the receiving side, and Pro/Max plans are not billed per token; if `hidden_older` > 0, say how many older items exist.

If there is no history yet, say so and suggest `/duo:test`. Do not call any other tool.
