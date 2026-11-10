---
description: View or change the claude-duo settings in plain words
argument-hint: <change to make, e.g. "run B in the background">
---
The user's request: $ARGUMENTS

1. Call `duo_config` with `action: "get"` to see the current configuration.
2. If there is no specific request: summarise the configuration in the user's language and ask what to change.
3. Otherwise: find the key(s) to change (e.g. `delivery.A_to_B`, `delivery.fallback`, `approval.before_send`, `peers.B.role`, `spawn.allowed_tools`, `terminal_app`), show "before → after", and ask the user. When they agree, call `duo_config` with `action: "set"`, `key`, `value`, `user_confirmed: true`. Role texts must be written in English.
Never set `spawn.permission_mode` to `bypassPermissions`.
