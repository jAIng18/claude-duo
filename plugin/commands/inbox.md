---
description: Show messages waiting from the other Claude account
---
Call `duo_inbox` (box "open"). Present the list briefly in the user's language: id, type, sender, title, status. If there are unhandled messages, ask which one to open; when they choose, call `duo_get` and follow the duo-protocol skill (replies to the other peer are written in English). To also show what this account sent, call `duo_inbox` with `sent: true`.
