---
description: Soạn và gửi việc / câu hỏi cho tài khoản Claude còn lại
argument-hint: <việc cần giao hoặc câu hỏi>
---
Người dùng muốn gửi cho peer Claude còn lại (tài khoản kia) nội dung sau:

$ARGUMENTS

Làm theo skill duo-protocol:
1. Viết lại thành một message **tự chứa ngữ cảnh** (bên kia không thấy cuộc trò chuyện này): tiêu đề ngắn, mục tiêu, bối cảnh, file liên quan (đường dẫn tuyệt đối), ràng buộc, tiêu chí hoàn thành. Chọn `type` phù hợp (task / question / info).
2. Cho người dùng xem bản nháp và hỏi có gửi không. Chỉ khi họ đồng ý mới gọi `duo_send` (kèm `user_confirmed: true`).
3. Báo lại id message và tình trạng giao nhận. Nếu chưa giao được, giải thích lý do bằng lời dễ hiểu và cách khắc phục.
