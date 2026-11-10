---
description: Xem hoặc đổi cấu hình claude-duo bằng lời
argument-hint: <thay đổi muốn làm, ví dụ "chuyển chiều A sang B thành chạy nền">
---
Yêu cầu của người dùng: $ARGUMENTS

1. Gọi `duo_config` với `action: "get"` để xem cấu hình hiện tại.
2. Nếu không có yêu cầu cụ thể: tóm tắt cấu hình bằng tiếng Việt dễ hiểu và hỏi muốn đổi gì.
3. Nếu có: xác định key cần đổi (ví dụ `delivery.A_to_B`, `approval.before_send`, `peers.B.role`, `spawn.allowed_tools`, `terminal_app`), trình bày "trước → sau", hỏi người dùng. Khi họ đồng ý, gọi `duo_config` với `action: "set"`, `key`, `value`, `user_confirmed: true`.
Không bao giờ đặt `spawn.permission_mode` thành `bypassPermissions`.
