---
description: Kiểm tra claude-duo hoạt động (gửi thử "ping" sang tài khoản kia)
---
Kiểm tra kết nối claude-duo:
1. Gọi `duo_status` để biết bạn là peer nào và cấu hình hiện tại.
2. Giải thích cho người dùng: bạn sẽ gửi một task thử rất nhỏ sang peer kia (nó chỉ cần trả lời "pong"), theo cách giao nhận đang cấu hình. Hỏi họ có đồng ý không.
3. Khi đồng ý: gọi `duo_send` với `type: "task"`, `title: "claude-duo test: pong"`, `body: "Đây là bài kiểm tra kết nối của claude-duo. KHÔNG dùng tool nào khác, KHÔNG sửa file. Chỉ gọi duo_reply với status \"done\" và summary đúng một chữ: pong"`, `user_confirmed: true`.
4. Gọi `duo_wait` với id vừa nhận, `timeout_s: 300`.
5. Báo kết quả: thành công nếu nhận "pong" (kèm thời gian và cách đã giao). Nếu không, đọc lý do từ kết quả của duo_send / duo_wait và hướng dẫn người dùng chạy `duo doctor` trong terminal.
