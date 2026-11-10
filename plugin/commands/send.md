---
description: Write and send a task or question to the other Claude account
argument-hint: <work to hand over, or a question>
---
The user wants to send this to the other Claude peer (the other account):

$ARGUMENTS

Follow the duo-protocol skill:
1. Rewrite it as a **self-contained message in English** (the other peer cannot see this conversation): short title, goal, context, relevant files (absolute paths), constraints, acceptance criteria. Pick the right `type` (task / question / info).
2. Show the user the draft (explain it in their language if they do not write English) and ask whether to send it. Call `duo_send` with `user_confirmed: true` only if they agree.
3. Then call `duo_wait` with the message id and report the result to the user in their language. If it times out, tell them it is still running and the result will appear here when it is done. If the message could not be delivered, explain why in plain words and how to fix it.
