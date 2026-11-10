---
description: Check that claude-duo works (send a tiny "ping" task to the other account)
---
Check the claude-duo connection:
1. Call `duo_status` to see which peer you are and the current settings.
2. Tell the user (in their language) that you will send a tiny test task to the other peer — it only has to answer "pong" — using the configured delivery mode. Ask whether that is OK.
3. If they agree: call `duo_send` with `type: "task"`, `title: "claude-duo test: pong"`, `body: "This is a claude-duo connectivity test. Do NOT use any other tool and do NOT edit files. Just call duo_reply with status \"done\" and summary exactly: pong"`, `user_confirmed: true`.
4. Call `duo_wait` with the returned id and `timeout_s: 300`.
5. Report: success if the answer is "pong" (include the time taken and how it was delivered). Otherwise explain the reason from the duo_send / duo_wait output and suggest running `duo doctor` in a terminal.
