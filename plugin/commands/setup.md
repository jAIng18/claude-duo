---
description: Thiết lập claude-duo (tên, vai trò, cách giao nhận giữa 2 tài khoản)
---
Bạn đang giúp người dùng thiết lập **claude-duo** — cho 2 tài khoản Claude Code trên máy này giao việc cho nhau. Nói chuyện bằng tiếng Việt, ngắn gọn, mỗi lần hỏi tối đa 2–3 câu. Người dùng có thể không phải dev: tránh thuật ngữ, giải thích bằng ví dụ.

Các bước:

1. Gọi `duo_config` với `action: "get"`. Nếu đã có cấu hình, tóm tắt hiện trạng và hỏi người dùng muốn đổi gì (rồi dùng `action: "set"`). Nếu chưa có, làm tiếp các bước dưới.
2. Hỏi: tài khoản thứ hai dùng thư mục config nào (mặc định `~/.claude-b`; tài khoản hiện tại là `~/.claude`). Thường giữ mặc định.
3. Hỏi mục đích dùng và vai trò của A và B. Gợi ý các bộ mẫu bằng `duo_examples` (`action: "list"`) — ví dụ Dev (planner ↔ coder), Design (ideator ↔ critic), PM (prd-writer ↔ reviewer), Research. Hoặc để họ tự mô tả vai trò.
4. Hỏi cách bên nhận làm việc, cho TỪNG chiều (A→B và B→A), giải thích:
   - **new-tab** (khuyên dùng lúc đầu): mở cửa sổ Terminal mới để bạn xem nó làm.
   - **background**: chạy ngầm, chỉ báo kết quả; bên nhận nhớ được các việc trước. Cần bên nhận đã từng mở thư mục làm việc một lần để "tin cậy" thư mục.
   - **live-session**: gõ thẳng vào cửa sổ của bên kia đang mở (mở bằng `claude-a` / `claude-b`).
5. Hỏi có muốn **duyệt trước khi gửi** không (mặc định: có).
6. Trình bày bảng tóm tắt cấu hình sẽ tạo. Khi người dùng đồng ý, gọi `duo_config` với `action: "init"`, `user_confirmed: true`, `values` = các giá trị đã chọn (ví dụ `{"peers":{"A":{"name":"Planner","role":"..."},"B":{"name":"Maker","role":"...","config_dir":"~/.claude-b"}},"delivery":{"A_to_B":"new-tab","B_to_A":"background","fallback":"new-tab"},"approval":{"before_send":"ask","before_accept":"auto"}}`).
7. Nếu họ chọn một bộ mẫu: gọi `duo_examples` với `action: "install"`, `name`, `user_confirmed: true`.
8. Kết thúc: nhắc họ chạy `/duo:test` để kiểm tra, và nếu tài khoản thứ hai chưa đăng nhập thì mở terminal mới gõ `claude-b` rồi `/login`.

Không bao giờ đặt `spawn.permission_mode` thành `bypassPermissions`.
