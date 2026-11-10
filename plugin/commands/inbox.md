---
description: Xem các message đang chờ từ tài khoản Claude còn lại
---
Gọi `duo_inbox` (box "open"). Trình bày danh sách ngắn gọn bằng tiếng Việt: id, loại, người gửi, tiêu đề, trạng thái. Nếu có message chưa xử lý, hỏi người dùng muốn mở message nào; khi họ chọn, gọi `duo_get` và làm theo skill duo-protocol. Nếu muốn xem cả những gì mình đã gửi, gọi thêm `duo_inbox` với `sent: true`.
