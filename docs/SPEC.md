# claude-duo — Spec v0.1 (draft)

> Tên `claude-duo` là tên tạm.
> Trạng thái: **Draft**, chờ team review. Ngày: 2026-11-10.
> Mọi mục gắn nhãn **[XÁC MINH]** là giả định chưa được kiểm chứng; sẽ kiểm ở giai đoạn v0.0 trước khi code.

---

## 1. Mục tiêu và phạm vi

### 1.1 Mục tiêu
Cung cấp một bộ cài giúp **2 phiên Claude Code chạy bằng 2 tài khoản khác nhau trên cùng một máy macOS** có thể:
- gửi task, câu hỏi, kết quả cho nhau theo **cả hai chiều** (A → B và B → A);
- người dùng chọn được **cách bên nhận làm việc** (chạy ngầm, mở tab mới, hoặc gõ thẳng vào phiên đang mở);
- người dùng **duyệt** được trước khi gửi hoặc nhận task, tùy cấu hình;
- dùng được cho **mọi domain** (dev, design, PO/PM, research…), vì vai trò và agent do người dùng tự cấu hình.

### 1.2 Ngoài phạm vi (v1)
- Windows, Linux.
- Claude Desktop app, IDE extension (chỉ hỗ trợ terminal).
- Hơn 2 peer. Kiến trúc vẫn chừa chỗ để mở rộng thành N peer.
- Đồng bộ qua máy khác hoặc cloud.
- Bộ agent chuyên domain **không** thuộc phần lõi; chỉ có ở dạng mẫu trong `examples/`.

### 1.3 Đối tượng
Team nội bộ, gồm cả người **không phải dev**. Cài đặt và thao tác hằng ngày không được đòi hỏi kiến thức git hay JSON.

---

## 2. Thuật ngữ

| Thuật ngữ | Nghĩa |
|---|---|
| **Peer** | Một "bên" Claude Code, gắn với một tài khoản và một thư mục config (`CLAUDE_CONFIG_DIR`). Có 2 peer: `A` và `B`. |
| **Message** | Một đơn vị giao tiếp giữa 2 peer (task, câu hỏi, kết quả…). |
| **Thread** | Chuỗi các message nối với nhau qua `reply_to`. |
| **Delivery mode** | Cách message được đưa tới bên nhận: `background`, `new-tab`, `live-session` (mục 7). |
| **Hop** | Số lần một yêu cầu bị chuyển tiếp qua lại giữa 2 peer. Dùng để chặn vòng lặp. |
| **Mailbox** | Thư mục trên đĩa chứa message, nằm tại `~/.claude-duo/`. |

---

## 3. Kiến trúc tổng quan

```
┌──────────── Peer A (acc 1) ────────────┐        ┌──────────── Peer B (acc 2) ────────────┐
│ claude (CLAUDE_CONFIG_DIR=~/.claude)   │        │ claude (CLAUDE_CONFIG_DIR=~/.claude-b) │
│  ├─ plugin claude-duo                  │        │  ├─ plugin claude-duo                  │
│  │   ├─ MCP server "duo"  ─────────────┼──┐  ┌──┼───── MCP server "duo"                │
│  │   ├─ hooks (SessionStart/Prompt/Stop)│  │  │  │   ├─ hooks                           │
│  │   ├─ skill duo-protocol             │  │  │  │   ├─ skill duo-protocol              │
│  │   └─ commands /duo:*                │  │  │  │   └─ commands /duo:*                 │
└────────────────────────────────────────┘  │  │  └────────────────────────────────────────┘
                                            ▼  ▼
                                  ~/.claude-duo/  (mailbox + config + registry)
                                            │
                                  duo dispatcher (bin/duo)
                                  ├─ background : claude -p / --bg
                                  ├─ new-tab    : osascript → Terminal/iTerm
                                  └─ live-session: tmux send-keys (hoặc native, nếu có)
```

### Thành phần

| Thành phần | Công nghệ | Vai trò |
|---|---|---|
| **Plugin `claude-duo`** | Claude Code plugin | Đóng gói MCP server, hooks, skill, commands. **Cài vào cả 2 config dir.** |
| **MCP server `duo`** | Node.js, stdio | Cung cấp các tool `duo_*` cho Claude (mục 9). Chỉ đọc và ghi mailbox, rồi gọi dispatcher. |
| **Dispatcher `bin/duo`** | Node.js CLI | Giao message theo delivery mode. Được gọi từ MCP server, hooks và người dùng (`duo status`, `duo doctor`). |
| **Hooks** | Script gọi `bin/duo hook <event>` | Đăng ký peer, báo có tin mới, tự xử lý hàng đợi (mục 8). |
| **Skill `duo-protocol`** | SKILL.md | Dạy Claude cách viết task cho bên kia, cách báo cáo kết quả, khi nào nên hoặc không nên giao việc. |
| **Mailbox** | File JSON | Nơi duy nhất lưu trạng thái. Không có database, không có daemon. |

**Nguyên tắc:** không có tiến trình chạy thường trực (daemon). Mọi việc được kích hoạt bởi tool call, hook hoặc lệnh của người dùng, nhờ vậy dễ cài, dễ gỡ và ít lỗi.

---

## 4. Peer và danh tính

### 4.1 Định nghĩa peer
Mỗi peer có `id` (`A` | `B`), `name` hiển thị (ví dụ "Planner"), `config_dir` và `role` (mô tả vai trò, dạng text tự do).

### 4.2 Phát hiện "mình là ai"
Trong một phiên Claude, MCP server và hooks xác định peer hiện tại bằng cách so `CLAUDE_CONFIG_DIR` (mặc định là `~/.claude`) với `config.peers[*].config_dir`. Nếu không khớp peer nào thì báo lỗi và gợi ý chạy `/duo:setup`.

### 4.3 Kiểm tra tài khoản
`duo doctor` và `/duo:setup` chạy `CLAUDE_CONFIG_DIR=<dir> claude auth status --json` cho từng peer:
- chưa đăng nhập → hướng dẫn chạy `claude-b` rồi gõ `/login`;
- **2 peer cùng một tài khoản** → cảnh báo; vẫn cho chạy nhưng hiển thị rõ.

**✅ ĐÃ XÁC MINH (2026-11-10, Claude Code 2.1.322, macOS 15):** 2 `CLAUDE_CONFIG_DIR` khác nhau dùng 2 mục Keychain riêng: `Claude Code-credentials` cho config mặc định, `Claude Code-credentials-<hash>` cho config tùy biến. Đăng nhập B không ghi đè A, và `claude -p` chạy được bằng cả 2 tài khoản.

> **⚠️ QUY TẮC BẮT BUỘC VỀ ĐƯỜNG DẪN CONFIG DIR (đã xác minh):**
> | Biến môi trường khi gọi `claude` | Kết quả |
> |---|---|
> | Không đặt `CLAUDE_CONFIG_DIR` | ✅ Dùng config mặc định (`~/.claude.json` + `~/.claude/`) |
> | `CLAUDE_CONFIG_DIR=$HOME/.claude` (đặt tường minh bằng đúng thư mục mặc định) | ❌ **Coi như một config hoàn toàn mới**: đọc `~/.claude/.claude.json` thay vì `~/.claude.json`, không đăng nhập, và **tự tạo file `~/.claude/.claude.json` mới** |
> | `CLAUDE_CONFIG_DIR=$HOME/.claude-b/` (thừa `/` ở cuối) | ❌ **Not logged in**, vì hash Keychain tính theo chuỗi đường dẫn nguyên văn |
>
> Vì vậy:
> 1. Peer dùng config mặc định thì **phải xóa** `CLAUDE_CONFIG_DIR` khỏi env (`env -u CLAUDE_CONFIG_DIR …`), không bao giờ đặt nó bằng `~/.claude`.
> 2. Peer dùng config tùy biến thì đặt `CLAUDE_CONFIG_DIR` bằng đường dẫn **tuyệt đối, đã chuẩn hóa** (`path.resolve`: không có `~`, không có `/` ở cuối), đúng dạng lúc người dùng `/login`.
> 3. Khi spawn phiên mới, dispatcher **xóa các biến bị rò rỉ** từ phiên đang chạy: `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID`, `CLAUDE_PLUGIN_*`, `CLAUDE_PROJECT_DIR`, `CLAUDE_EFFORT`, `TMUX`, `TMUX_PANE`. Lý do: MCP server và hook kế thừa toàn bộ env của phiên cha, kể cả id phiên và socket nhắn tin.

### 4.4 Registry phiên đang mở
Khi một phiên Claude khởi động, hook `SessionStart` ghi `~/.claude-duo/registry/<peer>.json`:

```json
{
  "peer": "B",
  "session_id": "…",
  "pid": 12345,
  "cwd": "/Users/x/project",
  "tmux_pane": "%3",
  "state": "idle",
  "updated_at": "2026-11-10T09:00:00Z"
}
```

- `state` có giá trị `idle` | `busy`: `UserPromptSubmit` đặt `busy`, `Stop` đặt `idle`.
- `tmux_pane` lấy từ biến `$TMUX_PANE`; là `null` nếu phiên không chạy trong tmux.
- Một registry entry bị coi là **stale** nếu `pid` không còn sống.

---

## 5. Mailbox

### 5.1 Cấu trúc thư mục

```
~/.claude-duo/                 (chmod 700)
├── config.json
├── registry/
│   ├── A.json
│   └── B.json
├── mail/
│   ├── A/                     # message gửi cho A
│   │   ├── new/               # chưa ai đọc
│   │   ├── cur/               # đã nhận, đang xử lý
│   │   └── done/              # đã xong (done/failed/rejected/cancelled/expired)
│   └── B/ …
├── attachments/<message_id>/  # file đính kèm lớn hoặc nội dung dài
└── logs/duo.log
```

### 5.2 Quy tắc ghi
- Mỗi message là **một file** `<message_id>.json`.
- Ghi theo kiểu atomic: ghi vào `*.tmp` rồi `rename()`. Đổi trạng thái thì `rename()` file giữa `new/`, `cur/` và `done/`.
- `message_id`: `YYYYMMDD-HHMMSS-<4 ký tự ngẫu nhiên>`, sắp xếp được theo thời gian.
- Nội dung `body` dài hơn **16 KB** thì chuyển vào `attachments/<id>/body.md`, trong message chỉ giữ đường dẫn.
- File đính kèm: **chỉ lưu đường dẫn tuyệt đối**, mặc định không copy file. Tùy chọn `copy: true` cho file nhỏ.

### 5.3 Dọn dẹp
`done/` cũ hơn `retention_days` (mặc định 30) sẽ bị xóa khi chạy `duo gc`. Lệnh này tự chạy trong `SessionStart`, tối đa 1 lần mỗi ngày.

---

## 6. Định dạng message

### 6.1 Schema

```json
{
  "id": "20261110-090000-k3f9",
  "thread_id": "20261110-085500-a1b2",
  "reply_to": null,
  "from": "A",
  "to": "B",
  "type": "task",
  "title": "Viết PRD cho tính năng đăng nhập bằng OTP",
  "body": "…mô tả đầy đủ, tự chứa ngữ cảnh…",
  "acceptance": ["Có mục mục tiêu, user story, edge case", "Dưới 2 trang"],
  "attachments": [{ "path": "/Users/x/Docs/brief.pdf", "note": "brief của khách" }],
  "cwd": "/Users/x/project",
  "expects_reply": true,
  "delivery": "new-tab",
  "hop": 1,
  "status": "queued",
  "created_at": "2026-11-10T09:00:00Z",
  "updated_at": "2026-11-10T09:00:00Z",
  "deadline_s": 3600,
  "result": null,
  "meta": { "session_id": null, "bg_id": null, "error": null }
}
```

### 6.2 Các `type`

| type | Ý nghĩa | Cần trả lời? |
|---|---|---|
| `task` | Giao một việc cần làm | Có, bằng `result` |
| `question` | Hỏi thông tin hoặc ý kiến, không yêu cầu làm việc | Có, bằng `result` |
| `result` | Kết quả của `task` hoặc `question` (`reply_to` bắt buộc) | Không |
| `info` | Thông báo một chiều | Không |
| `cancel` | Hủy một task đã gửi (`reply_to` bắt buộc) | Không |
| ~~`ping` / `pong`~~ | **Bỏ khi triển khai.** `/duo:test` và `duo test --live` gửi một `task` thật ("trả lời pong"), vì một ping không qua Claude thì không kiểm tra được đường giao nhận | — |

### 6.3 Vòng đời `status`

```
queued ──► delivered ──► accepted ──► in_progress ──► done
   │           │             │              ├──────► failed
   │           │             └─► rejected   └──────► needs_info ──► (bên gửi trả lời) ──► in_progress
   │           └─► expired (quá deadline_s)
   └─► cancelled
```

- `queued`: đã nằm trong `new/`, chưa giao được (ví dụ bên nhận đang `busy`).
- `delivered`: dispatcher đã đưa message tới bên nhận.
- `accepted` / `rejected`: bên nhận đồng ý hoặc từ chối, do người dùng hoặc Claude quyết tùy cấu hình.
- `needs_info`: bên nhận cần hỏi lại; thực chất là một `question` ngược chiều, **không tăng hop**.

### 6.4 Định dạng `result`

```json
{
  "status": "done",
  "summary": "Đã viết PRD 1.5 trang.",
  "details": "…",
  "outputs": [{ "path": "/Users/x/project/docs/prd-otp.md" }],
  "open_issues": ["Chưa rõ OTP qua SMS hay email"]
}
```

---

## 7. Delivery modes

Cấu hình **riêng cho từng chiều** (`A_to_B`, `B_to_A`). Người gửi có thể ghi đè mode cho từng message (`delivery` trong `duo_send`).

**Nguyên tắc chung cho mọi mode:** bên nhận không nhận nguyên văn task qua shell. Nó chỉ nhận một **bootstrap prompt ngắn**:

```
[claude-duo] Bạn có message mới <id> từ <A:Planner>. Gọi tool duo_get("<id>") để đọc rồi làm theo skill duo-protocol.
```

Cách này tránh lỗi escape ký tự hoặc tràn độ dài lệnh, và đảm bảo bên nhận luôn đọc bản gốc trong mailbox.

**Kết quả luôn được trả về bằng một cách duy nhất:** bên nhận gọi `duo_reply(id, …)`.

### 7.1 `background`
Bên nhận chạy ngầm, người dùng chỉ thấy kết quả.

```bash
CLAUDE_CONFIG_DIR=<to.config_dir> claude \
  --bg -n "duo-<id>" \
  --permission-mode <config.spawn.permission_mode> \
  --allowedTools <config.spawn.allowed_tools> \
  --append-system-prompt "<duo protocol rút gọn>" \
  "<bootstrap prompt>"
```

- Ưu tiên dùng `--bg` (Claude Code ≥ 2.1.x có `--bg`, `claude attach`, `claude logs`, `claude agents --json`). Người dùng có thể "ghé xem" bằng `claude attach duo-<id>` mà không làm gián đoạn.
- **✅ ĐÃ XÁC MINH (2026-11-10):** `--bg` chạy đúng với `CLAUDE_CONFIG_DIR` của B và dùng đúng tài khoản B. Những gì rút ra:
  - Mọi lệnh quản lý phiên (`claude agents`, `logs`, `attach`, `stop`) **chỉ thấy phiên của config dir hiện tại**. Dispatcher phải luôn gọi kèm `CLAUDE_CONFIG_DIR` của peer nhận.
  - **Workspace trust lưu riêng theo từng tài khoản.** Nếu `cwd` chưa được tài khoản nhận tin cậy, `--bg` thoát ngay với lỗi `Workspace not trusted`. Dispatcher phải bắt lỗi này, chuyển message sang `failed` với `error: workspace_not_trusted` và hướng dẫn người dùng mở `claude-b` trong thư mục đó một lần để bấm tin cậy. `duo doctor` cũng phải kiểm tra điểm này. Không tự sửa file config để bỏ qua trust.
  - Phiên ngầm dùng permission mode mặc định của tài khoản đó (lúc thử là `auto`). Dispatcher phải **luôn truyền `--permission-mode` tường minh** theo `config.spawn`.
- **✅ ĐÃ XÁC MINH: giữ ngữ cảnh giữa các task (tùy chọn `background.keep_context`).**
  - `claude stop <id>`, rồi `claude --bg --resume <session_id> "<bootstrap>"` **không kèm cờ nào**: tiếp tục **đúng phiên cũ** (giữ id) và nhớ đầy đủ ngữ cảnh. Phiên dùng lại các option đã lưu từ lần đầu (ví dụ `--permission-mode`).
  - Nếu **kèm cờ** khi resume: Claude tạo **bản sao** với id mới. Bản sao vẫn có ngữ cảnh cũ, nhưng **không giữ tên đặt bằng `-n`** (Claude tự đặt tên khác).
  - Resume một phiên **đang chạy** cũng tạo bản sao, nên phải `stop` trước.
  - Hệ quả cho thiết kế: lưu `session_id` của "phiên làm việc chính" của mỗi peer trong `registry/<peer>.json`; luôn tham chiếu phiên bằng **id, không bằng tên**; muốn đổi option thì chấp nhận tạo phiên mới.
- Mode `-p`: khi hook `Stop` chặn để Claude làm tiếp, trường `result` trong output JSON **chỉ chứa message cuối cùng**. Vì vậy `auto_result` phải đọc transcript (`transcript_path`), không chỉ dựa vào `result`.
- Lưu `bg_id` vào `meta`.
- **Fallback** nếu không dùng được `--bg`: `claude -p … --output-format json`. Nếu bên nhận kết thúc mà chưa gọi `duo_reply`, dispatcher tự tạo `result` từ output cuối cùng, kèm `status: done` và cờ `auto_result: true`.
- **[XÁC MINH]** `--bg` có hoạt động đúng với `CLAUDE_CONFIG_DIR` tùy biến không, và `claude attach` có cần cùng `CLAUDE_CONFIG_DIR` không.

### 7.2 `new-tab`
Mở **tab Terminal mới** chạy phiên Claude tương tác của bên nhận, để người dùng xem nó làm từng bước.

```applescript
tell application "Terminal"   -- hoặc "iTerm2" theo config.terminal_app
  do script "cd <cwd> && CLAUDE_CONFIG_DIR=<dir> claude -n 'duo-<id>' '<bootstrap prompt>'"
  activate
end tell
```

- Tab được đặt tên `duo-<id>` để dễ nhận ra.
- Nếu `cwd` không tồn tại thì dùng `$HOME` và ghi cảnh báo vào message.
- Phương án thay thế cần xác minh: khởi động bằng `--bg` rồi mở tab chạy `claude attach duo-<id>`. Ưu điểm là đóng tab không giết phiên.
- **✅ ĐÃ XÁC MINH (2026-11-10, macOS 15.7, Terminal.app):** `osascript … do script` mở được cửa sổ mới, **không hiện hộp thoại Automation**, kể cả khi chạy từ trong một phiên `--bg`. Lý do: tiến trình gốc vẫn là Terminal, mà Terminal tự điều khiển chính nó thì không cần quyền.
  - Terminal.app: `do script` mở **cửa sổ mới**, không phải tab. Mở tab thật cần giả lập phím ⌘T qua System Events, và việc đó đòi quyền Accessibility, nên **không làm**. Với iTerm2 thì tạo tab bằng AppleScript gốc của iTerm.
  - Nếu người dùng chạy Claude từ một app khác (ví dụ iTerm điều khiển Terminal, hoặc ngược lại), macOS **có thể** hỏi quyền Automation. `osascript` khi đó trả lỗi `-1743` (not authorized). Dispatcher bắt mã lỗi này, ghi `error: automation_denied`, chuyển sang `fallback`, và `duo doctor` hướng dẫn vào System Settings → Privacy & Security → Automation.

### 7.3 `live-session`
Đưa message vào **chính phiên đang mở** của bên nhận.

Thứ tự thử:
1. ~~**Native messaging** của Claude Code~~ **❌ Không dùng được (đã xác minh 2026-11-10):** danh sách phiên và việc gửi tin nhắn có sẵn chỉ hoạt động trong **cùng một config dir**. Phiên A không thấy phiên B, và gửi theo tên thì báo `No agent named '…' is reachable`.
2. **tmux**: chỉ dùng được khi `registry/<to>.json` có `tmux_pane`. **Bắt buộc theo quy trình an toàn bên dưới.**

   > **⚠️ Đã xác minh (2026-11-10): gõ phím vào lúc Claude đang hiện hộp thoại xin quyền là NGUY HIỂM.** Text gõ vào bị mất (không tới được Claude), còn phím `Enter` **chọn luôn "1. Yes" và duyệt quyền thay người dùng**. Khi thử, một file đã được tạo mà không ai đồng ý. Bấm `Escape` thì hủy hộp thoại an toàn.

   **Quy trình giao tin an toàn qua tmux (cả 5 bước đều bắt buộc):**
   1. **Kiểm tra trạng thái theo hook:** `registry.state` phải là `idle`. Sự kiện cuối cùng phải là `Stop` hoặc `SessionStart`, không phải `UserPromptSubmit` hay `Notification(permission_prompt)`.
   2. **Kiểm tra màn hình:** đọc màn hình bằng `tmux capture-pane -t <pane> -p`. Từ chối giao nếu màn hình có `Do you want`, `Esc to cancel`, hoặc dòng nhập liệu `❯` không ở trạng thái trống.
   3. **Gõ text, chưa bấm Enter:** `tmux send-keys -t <pane> -l "<bootstrap>"`. Đọc lại màn hình để xác nhận text đã nằm trong ô nhập. Không thấy thì gửi `Escape`, xóa ô nhập và hủy giao.
   4. **Bấm Enter:** `tmux send-keys -t <pane> Enter`. Không bao giờ gửi `Enter` khi ô nhập trống, vì Claude có thể đang hiện **gợi ý prompt** và Enter sẽ gửi luôn gợi ý đó.
   5. **Xác nhận đã nhận:** trong vòng 5 giây phải có hook `UserPromptSubmit` mà `prompt` chứa `message_id`. Không có thì đánh dấu `delivery_failed` và áp dụng `fallback`.

   Bất kỳ bước nào không chắc chắn: **không giao**, giữ message ở `queued`. Giao chậm còn hơn duyệt quyền sai.

   **Trạng thái phiên dựa vào hook (đã xác minh thứ tự):**
   | Hook | `registry.state` |
   |---|---|
   | `SessionStart` | `idle` |
   | `UserPromptSubmit` | `busy` |
   | `Notification` với `notification_type: "permission_prompt"` | `awaiting_user` |
   | `Stop` | `idle` |

   Lưu ý: nếu người dùng bấm **Esc** để từ chối quyền thì **không có hook nào chạy** (không có `Stop`), nên state bị kẹt ở `awaiting_user`. Đó là lý do bước 2 (đọc màn hình) là bắt buộc: dispatcher dùng nó để tự sửa state về `idle` khi thấy ô nhập trống và không còn hộp thoại.
3. Nếu bên nhận đang `busy`: giữ ở `queued`. Hook `Stop` của bên nhận sẽ tự lấy message khi xong lượt hiện tại (mục 8).
4. Nếu bên nhận không mở phiên nào hoặc không chạy trong tmux: áp dụng `config.delivery.fallback` (mặc định là `new-tab`).

Yêu cầu: người dùng mở phiên bằng `claude-a` / `claude-b` (alias do installer tạo). Khi `live-session` được bật, alias tự bọc trong tmux. Installer **tự cài tmux** (mục 13.1), người dùng không phải làm gì.

**✅ Đã xác minh (tmux 3.8, phiên B tương tác):** hook nhận được `TMUX_PANE` (ví dụ `%0`). Text tiếng Việt có dấu gửi qua `send-keys -l` tới Claude **nguyên vẹn**.

### 7.4 So sánh nhanh

| | background | new-tab | live-session |
|---|---|---|---|
| Thấy bên nhận làm việc | Chỉ khi `attach` | Có | Có |
| Giữ ngữ cảnh phiên đang mở | Không | Không | **Có** |
| Cần cài thêm | Không | Quyền Automation | tmux (hoặc native) |
| Phù hợp | Việc nhỏ, rõ ràng | Việc cần theo dõi | Làm việc liên tục, qua lại nhiều |

---

## 8. Hooks

Tất cả hook gọi `bin/duo hook <event>`. Yêu cầu: chạy **dưới 300 ms**, không gọi mạng, lỗi thì im lặng (chỉ ghi log), **không bao giờ chặn phiên Claude vì lỗi của duo**.

| Event | Hành vi |
|---|---|
| `SessionStart` | Ghi registry (`state: idle`), chạy `gc` nếu đến hạn. Nếu có tin trong `new/` thì chèn context: "Bạn có N message chưa đọc, gõ /duo:inbox để xem." |
| `UserPromptSubmit` | Đặt `state: busy`. Nếu có message mới đến **trong lúc người dùng đang gõ**, chèn tóm tắt 1 dòng cho mỗi message vào context. **Không** tự xử lý. |
| `Stop` | Đặt `state: idle`. Nếu `config.auto_continue == true` và có message `queued` gửi cho peer này: trả `decision: block` với lý do "Có message <id>, gọi duo_get để xử lý". Có chặn vòng lặp: không block quá `max_auto_continue` lần liên tiếp (mặc định 5) và tôn trọng cờ `stop_hook_active`. |
| `Notification` | Nếu `notification_type == "permission_prompt"` thì đặt `state: awaiting_user`. Trong state này **tuyệt đối không giao tin qua tmux** (mục 7.3). Đã xác minh payload: `{"message":"Claude needs your permission","notification_type":"permission_prompt", …}`. |
| `SessionEnd` | Xóa `tmux_pane`, đặt registry `state: offline`. |

**✅ ĐÃ XÁC MINH (2026-11-10, 2.1.322, plugin nạp qua `--plugin-dir`, tài khoản B, mode `-p`):**
- `SessionStart` và `UserPromptSubmit` trả `{"hookSpecificOutput":{"hookEventName":"<event>","additionalContext":"…"}}`: Claude **nhận được** nội dung này.
- `Stop` trả `{"decision":"block","reason":"…"}`: Claude **làm tiếp** theo `reason`. Lần gọi `Stop` kế tiếp có `stop_hook_active: true`, cho phép hook nhả ra, nên không bị lặp vô hạn.
- Dữ liệu hook nhận qua stdin (dùng được cho registry):
  - mọi event: `session_id`, `transcript_path`, `cwd`, `hook_event_name`;
  - `SessionStart`: `source` (`startup`, …);
  - `UserPromptSubmit`: `prompt`, `prompt_id`, `permission_mode`;
  - `Stop`: `stop_hook_active`, `last_assistant_message`, `background_tasks`;
  - `SessionEnd`: `reason`.
- Biến môi trường trong hook: có `CLAUDE_CONFIG_DIR` (nên xác định peer ngay trong hook được), `CLAUDE_PLUGIN_ROOT`. `TMUX_PANE` có mặt khi chạy trong tmux (chưa thử).
- `claude plugin validate` khuyến nghị **bọc `"${CLAUDE_PLUGIN_ROOT}"` trong dấu nháy kép** trong `hooks.json`.
- Chưa thử: hook trong **phiên tương tác** (không `-p`) và trong phiên `--bg`. Dự kiến giống nhau, sẽ kiểm lại ở v0.1.

---

## 9. MCP tools (server `duo`)

`to` mặc định là peer còn lại, nên thường không cần truyền.

| Tool | Tham số | Trả về | Ghi chú |
|---|---|---|---|
| `duo_send` | `type`, `title`, `body`, `acceptance?`, `attachments?`, `cwd?`, `expects_reply?`, `delivery?`, `reply_to?`, `deadline_s?` | `{ id, status }` | Kiểm tra hop và approval (mục 11) trước khi gửi. |
| `duo_inbox` | `status?` (`new`\|`cur`\|`done`\|`all`), `limit?` | Danh sách tóm tắt | |
| `duo_get` | `id` | Message đầy đủ + thread | Gọi lần đầu sẽ chuyển `delivered → accepted` (hoặc hỏi người dùng nếu `before_accept: ask`). |
| `duo_reply` | `id`, `status` (`done`\|`failed`\|`needs_info`), `summary`, `details?`, `outputs?`, `open_issues?` | `{ result_id }` | Tạo message `result` gửi ngược lại và chuyển task sang `done/`. |
| `duo_reject` | `id`, `reason` | ok | |
| `duo_wait` | `id`, `timeout_s` (mặc định 600, tối đa 3600) | `result` hoặc `timeout` | Dùng khi bên gửi cần kết quả ngay mới làm tiếp được. Poll mailbox mỗi 2 giây. |
| `duo_cancel` | `id`, `reason?` | ok | Đánh dấu `cancelled`. Nếu bên nhận đã bắt đầu làm, gửi thêm message `cancel` tới **đúng phiên đang xử lý** (`wake_session = handler_session`). Không `claude stop` phiên nền, vì phiên đó có thể đang giữ ngữ cảnh của các việc khác. |
| `duo_status` | — | Peer, online/idle/busy, số message theo trạng thái, mode hiện tại | |
| `duo_accept` | `id` | ok | (thêm khi triển khai) Chấp nhận task khi `before_accept: ask`, sau khi người dùng đồng ý. |
| `duo_config` | `action` (`get`\|`set`\|`init`), `key?`, `value?`, `values?`, `user_confirmed?` | cấu hình | (thêm khi triển khai) `set`/`init` bắt buộc `user_confirmed`. Không cho đặt `dev.*`, không cho `spawn.permission_mode = bypassPermissions`. |
| `duo_examples` | `action` (`list`\|`install`), `name?`, `overwrite?`, `user_confirmed?` | danh sách / kết quả cài | (thêm khi triển khai) Copy agent vào `<config_dir>/agents/` của từng peer và đặt vai trò. |

Tên đầy đủ mà Claude thấy: `mcp__plugin_duo_duo__<tool>`. Quy tắc quyền `mcp__plugin_duo_duo` cho phép toàn bộ (đã xác minh).

---

## 10. Slash commands và skill

### 10.1 Commands

| Command | Chức năng |
|---|---|
| `/duo:setup` | Phỏng vấn người dùng và ghi `config.json`: tên và vai trò của A, B; mode từng chiều; mức duyệt; chọn mẫu agent (không bắt buộc). |
| `/duo:send <nội dung>` | Soạn message cho bên kia. Claude giúp viết lại cho tự chứa ngữ cảnh, **cho người dùng xem trước khi gửi**. |
| `/duo:inbox` | Liệt kê tin đến và hỏi muốn xử lý tin nào. |
| `/duo:status` | Hiển thị `duo_status` dưới dạng dễ đọc. |
| `/duo:test` | Gửi một task thử ("trả lời pong") theo mode đã cấu hình, chờ bằng `duo_wait` và báo kết quả. Trong terminal có thêm `duo test` (kiểm tra cài đặt) và `duo test --live` (gửi thật). |
| `/duo:config` | Xem và sửa nhanh cấu hình bằng lời ("chuyển chiều A→B sang new-tab"). |

### 10.2 Skill `duo-protocol`
Nạp vào cả 2 peer. Nội dung chính:
- **Khi gửi:** task phải tự chứa ngữ cảnh (bên kia không thấy hội thoại của mình), có tiêu chí hoàn thành, có đường dẫn file liên quan. Không giao lại cho bên kia việc vừa được bên kia giao cho mình.
- **Khi nhận:** đọc bằng `duo_get`, làm đúng phạm vi, cần hỏi thì dùng `needs_info`. **Luôn kết thúc bằng `duo_reply`.**
- **Vai trò:** đọc `config.peers.<me>.role` để biết mình là ai. Vai trò này do người dùng đặt, không viết cứng.

### 10.3 Mẫu agent (`examples/`)
Không cài mặc định. `/duo:setup` cho phép chọn một mẫu và copy vào `agents/` của config dir tương ứng.

| Mẫu | A | B |
|---|---|---|
| `dev` | planner (lập plan, review diff) | coder (sửa code, chạy test) |
| `design` | ideator (lên ý tưởng, moodboard) | critic (phản biện theo heuristic UX) |
| `pm` | prd-writer | prd-reviewer (red-team, edge case) |
| `research` | researcher | fact-checker |

---

## 11. Duyệt của người dùng và an toàn

### 11.1 Mức duyệt (`config.approval`)
- `before_send`: `auto` | `ask`. Nếu `ask`, Claude phải trình bản nháp và chờ người dùng đồng ý trước khi gọi `duo_send`. Việc kiểm tra nằm ở **MCP server**: `duo_send` trả lỗi `approval_required` nếu không kèm `user_confirmed: true`. Skill hướng dẫn Claude chỉ đặt cờ này sau khi người dùng xác nhận.
- `before_accept`: `auto` | `ask`. Áp dụng cho bên nhận khi có phiên tương tác (`new-tab`, `live-session`). Mode `background` không có người để hỏi, nên nếu `before_accept: ask` thì dispatcher **tự chuyển sang `new-tab`**.

### 11.2 Chặn vòng lặp
- `hop` tăng 1 mỗi lần một `task` được tạo ra **trong lúc đang xử lý** một task khác (`duo_send` gọi khi phiên đang có task ở `cur/`). Vượt `max_hops` (mặc định 3) thì từ chối.
- Không cho tạo `task` gửi ngược về peer đã giao task đang xử lý; chỉ được dùng `needs_info`.
- Rate limit: tối đa `max_messages_per_10min` (mặc định 20) cho mỗi peer.
- `max_concurrent` (mặc định 2): số task `in_progress` tối đa ở bên nhận; vượt thì giữ ở `queued`.

### 11.3 Quyền của phiên được khởi động
- Mặc định `permission_mode: "acceptEdits"` kèm danh sách `allowed_tools` trong config.
- **Không bao giờ** mặc định `bypassPermissions` / `--dangerously-skip-permissions`. Nếu người dùng tự bật thì `/duo:setup` hiển thị cảnh báo rõ ràng.

### 11.4 Dữ liệu
- `~/.claude-duo/` có quyền `700`. Message có thể chứa thông tin nội bộ, không được nằm trong thư mục sync (iCloud/Dropbox).
- Message từ peer được coi là yêu cầu từ chính người dùng, vì cả 2 tài khoản đều là của họ. Nhưng **nội dung file đính kèm hoặc web được trích lại** trong message vẫn là dữ liệu, không phải lệnh. Skill phải nêu rõ điểm này.

---

## 12. Cấu hình (`~/.claude-duo/config.json`)

Giá trị mặc định **đã triển khai** (`plugin/lib/config.mjs` → `defaultConfig()`):

```json
{
  "version": 1,
  "peers": {
    "A": { "name": "A", "config_dir": "~/.claude",   "role": "Lập kế hoạch, chia việc, review kết quả" },
    "B": { "name": "B", "config_dir": "~/.claude-b", "role": "Thực thi task được giao, báo cáo chi tiết" }
  },
  "delivery": { "A_to_B": "new-tab", "B_to_A": "new-tab", "fallback": "new-tab" },
  "background": { "keep_context": true },
  "new_tab": { "reuse_live": true, "use_tmux": true, "activate": true },
  "approval": { "before_send": "ask", "before_accept": "auto" },
  "spawn": {
    "permission_mode": "acceptEdits",
    "allowed_tools": ["Read", "Edit", "Write", "Grep", "Glob"],
    "model": null
  },
  "limits": {
    "max_hops": 3,
    "max_concurrent": 2,
    "max_messages_per_10min": 20,
    "default_deadline_s": 3600,
    "max_auto_continue": 5,
    "max_reply_reminders": 2
  },
  "auto_continue": true,
  "wake_on_result": true,
  "notify": true,
  "terminal_app": "Terminal",
  "retention_days": 30,
  "dev": { "plugin_dir": null }
}
```

- `B_to_A` mặc định là `new-tab` (bản nháp ghi `background`). Lý do: background cần tài khoản nhận đã tin cậy thư mục, nên `new-tab` an toàn hơn cho lần đầu.
- `background.keep_context`: tiếp tục cùng một phiên nền (`stop` rồi `--resume` không kèm cờ) để bên nhận nhớ việc cũ.
- `new_tab.reuse_live`: nếu bên nhận đã có cửa sổ tmux đang rảnh thì gõ vào đó thay vì mở cửa sổ mới. `new_tab.use_tmux`: cửa sổ mới chạy trong tmux riêng (`tmux -L claude-duo`), để những lần sau giao được kiểu live-session.
- `wake_on_result`: kết quả (và câu hỏi `needs_info`) được gõ vào **đúng phiên đã gửi yêu cầu** nếu phiên đó đang chạy trong tmux và đang rảnh. Nếu không, hook `Stop` / `UserPromptSubmit` của chính phiên đó sẽ báo. Kết quả **không bao giờ** mở phiên mới.
- `dev.plugin_dir`: chỉ dùng khi phát triển. Phiên do claude-duo mở sẽ nạp plugin bằng `--plugin-dir` thay vì bản đã cài. Không sửa được qua tool.

Người không phải dev không cần mở file này: mọi thay đổi đều làm được qua `/duo:setup` hoặc `/duo:config`.

---

## 13. Cài đặt và trải nghiệm lần đầu

### 13.1 `install.sh`
1. Kiểm tra macOS và Claude Code (yêu cầu version ≥ mức tối thiểu chốt ở v0.0).
2. Kiểm tra Node.js (cần cho MCP server). Nếu thiếu thì gợi ý `brew install node`.
3. **Tự động cài các phụ thuộc, không hỏi người dùng và không bắt họ tự cài:**
   - Đã có thì bỏ qua, không cài lại. Kiểm tra bằng `command -v tmux` / `command -v node`.
   - Thiếu thì cài qua Homebrew: `HOMEBREW_NO_AUTO_UPDATE=1 brew install tmux node`. tmux luôn được cài, kể cả khi người dùng chưa bật `live-session`, để sau này đổi mode không phải cài thêm.
   - Máy chưa có Homebrew thì installer chạy script cài Homebrew chính thức. Đây là bước duy nhất có thể hỏi mật khẩu máy; trước khi chạy, in rõ một dòng giải thích lý do.
   - Brew nằm ở `/opt/homebrew/bin` (Apple Silicon) hoặc `/usr/local/bin` (Intel). Installer phải tự thêm vào `PATH` của phiên cài đặt.
   - Đã thử trên máy dev: `brew install tmux` cài tmux 3.8 cùng 3 phụ thuộc (`libevent`, `utf8proc`, `jemalloc`) trong khoảng 1 phút.
4. Tạo `~/.claude-duo/` và config mặc định.
5. Thêm alias vào `~/.zshrc`: `claude-a`, `claude-b` (bọc tmux nếu cần), `duo`.
6. Cài plugin cho **cả 2 config dir**. **✅ Đã xác minh:** cài cho config dir nào thì chỉ config dir đó thấy plugin; config dir còn lại hoàn toàn không bị ảnh hưởng.
   ```bash
   CLAUDE_CONFIG_DIR=<dir> claude plugin marketplace add <github-repo|path>
   CLAUDE_CONFIG_DIR=<dir> claude plugin install claude-duo@<marketplace>
   ```
   Plugin được ghi vào `<dir>/settings.json` và `<dir>/plugins/installed_plugins.json` (scope `user`). Command của plugin gọi theo dạng `/<plugin>:<command>`. Gỡ bằng `plugin uninstall` và `plugin marketplace remove`; gỡ xong sạch hoàn toàn.
7. In hướng dẫn: "Mở terminal mới, gõ `claude-b`, rồi `/login` bằng tài khoản thứ 2."

### 13.2 Lần đầu sử dụng
```
claude-b  → /login (tài khoản 2)       ← bước thủ công duy nhất
claude-a  → /duo:setup                 ← trả lời vài câu hỏi
          → /duo:test                  ← thấy "pong" là xong
```

### 13.3 `duo doctor`
Kiểm tra: version Claude Code, Node, tmux, đăng nhập 2 peer, 2 peer khác tài khoản, plugin đã cài ở 2 bên, quyền Automation, quyền thư mục. Mỗi lỗi kèm cách sửa bằng tiếng Việt.

### 13.4 Gỡ cài đặt
`duo uninstall`: gỡ plugin ở 2 bên, xóa alias, hỏi có xóa `~/.claude-duo/` không.

---

## 14. Xử lý lỗi và edge case

| Tình huống | Xử lý |
|---|---|
| Bên nhận chưa đăng nhập hoặc hết hạn | Message chuyển `failed`, `error: auth_required`, thông báo cho bên gửi. |
| Bên nhận hết usage limit | `failed`, `error: rate_limited`. Bên gửi có thể gửi lại sau. |
| Đóng tab hoặc tắt máy giữa chừng | Quá `deadline_s` thì `expired`. Nếu có `session_id`, `duo resume <id>` mở lại phiên. |
| Tiến trình bên nhận chết (pid không còn) | `in_progress` có `pid` chết quá 5 phút thì `failed`, `error: crashed`. |
| Ghi đồng thời | File-per-message, rename atomic, nên không cần lock toàn cục. Riêng `registry/*.json` dùng lock file có timeout 1 giây. |
| `cwd` không tồn tại | Dùng `$HOME` và cảnh báo trong message. |
| Body quá dài | Chuyển vào `attachments/` (mục 5.2). |
| Cả 2 bên cùng gửi task cho nhau một lúc | Hợp lệ. Mỗi bên xử lý theo hàng đợi, `max_concurrent` giới hạn. |

---

## 15. Cấu trúc repo

Cấu trúc **đã triển khai**. Node.js ESM thuần: không có dependency, không cần build. Người nhận chỉ cần Node, không phải chạy `npm install`.

```
claude-duo/                         ← repo = marketplace "claude-duo"
├── .claude-plugin/marketplace.json  (plugin "duo", source ./plugin)
├── install.sh                       cài đặt idempotent (tự cài node + tmux qua brew)
├── README.md                        hướng dẫn tiếng Việt
├── docs/SPEC.md
├── package.json                     npm test
├── test/                            node:test — 40 test (core + hook/MCP chạy như tiến trình thật)
└── plugin/                          ← Claude Code plugin "duo"
    ├── .claude-plugin/plugin.json
    ├── .mcp.json                    MCP server "duo" → node bin/duo.mjs mcp
    ├── hooks/hooks.json             SessionStart, UserPromptSubmit, Notification, Stop, SessionEnd
    ├── commands/                    /duo:setup /duo:send /duo:inbox /duo:status /duo:test /duo:config
    ├── skills/duo-protocol/SKILL.md
    ├── examples/{dev,design,pm,research}/   example.json + agents/*.md
    ├── tmux/claude-duo.tmux.conf    cấu hình cho tmux server riêng (-L claude-duo)
    ├── bin/duo.mjs                  CLI + entry của hook và MCP
    └── lib/
        ├── paths.mjs     quy tắc config dir (§4.3), env sạch khi spawn, trust
        ├── config.mjs    mặc định, validate, whoAmI
        ├── fsutil.mjs    ghi atomic, lock bằng mkdir, log
        ├── mailbox.mjs   message file-per-id, vòng đời status
        ├── registry.mjs  phiên đang mở, worker nền
        ├── actions.mjs   send / get / accept / reply / reject / wait / cancel / status
        ├── dispatch.mjs  background · new-tab · live-session, fallback, wake kết quả, kick
        ├── tmux.mjs      đọc màn hình + quy trình gõ an toàn 5 bước
        ├── macos.mjs     osascript (Terminal / iTerm2), thông báo
        ├── open.mjs      dựng lệnh claude cho peer (prompt đầu, --allowedTools cuối)
        ├── claude.mjs    wrapper `claude` CLI (--bg, --resume, agents, auth)
        ├── hooks.mjs     xử lý hook
        ├── mcp.mjs       MCP server JSON-RPC tự viết, 11 tool
        ├── examples.mjs  cài bộ agent mẫu
        ├── settings.mjs  thêm/bớt 1 quy tắc quyền trong settings.json (có backup)
        ├── doctor.mjs    duo doctor
        └── gc.mjs        hết hạn, task bỏ dở, xóa theo retention
```

---

## 16. Lộ trình và tiêu chí hoàn thành

| Giai đoạn | Nội dung | Xong khi | Trạng thái (2026-11-10) |
|---|---|---|---|
| **v0.0 — Xác minh** | Kiểm tra tất cả mục **[XÁC MINH]** (danh sách ở mục 17). | Có bảng kết quả; chốt mode nào khả thi; cập nhật spec. | ✅ Xong: 7/7 điểm, cộng các phát hiện thêm ở 17.1-8 |
| **v0.1 — Lõi** | Mailbox, MCP server, mode `background`, `/duo:send`, `/duo:inbox`, `/duo:status`, `/duo:test`, `duo doctor`. | A gửi task cho B chạy ngầm, B trả kết quả, A đọc được. Làm được cả chiều B→A. | ✅ E2E-1 (A→B, ~11s), E2E-2 (giữ ngữ cảnh), E2E-3 (B→A) |
| **v0.2 — Hiển thị** | Mode `new-tab`, `live-session` (tmux), hooks đầy đủ, thông báo macOS, chặn vòng lặp. | Đủ 3 mode; thử cố tình tạo vòng lặp thì bị chặn. | ✅ E2E-5 (new-tab), E2E-6 (live-session), E2E-7 (xếp hàng khi bận, `Stop` tự nhặt), E2E-8 (kết quả về đúng phiên gửi); chặn vòng lặp qua unit test |
| **v0.3 — Setup** | `/duo:setup`, `/duo:config`, bộ mẫu `examples/`. | Người không phải dev tự setup xong trong 10 phút, không cần hỏi. | ✅ Code + test; ⏳ chưa thử với người dùng thật |
| **v0.4 — Phát hành nội bộ** | `install.sh`, README tiếng Việt, `duo uninstall`, thử với 1 dev + 1 designer + 1 PM. | Cả 3 người dùng được một luồng thật trong công việc. | ✅ installer + uninstall đã thử trên HOME giả (chạy lại không đổi gì); ⏳ chưa có ảnh trong README; ⏳ chưa thử với 3 người dùng |

---

## 17. Cần xác minh (v0.0) và câu hỏi mở

### 17.1 Kiểm chứng kỹ thuật
1. ~~2 `CLAUDE_CONFIG_DIR` có tách credential trong macOS Keychain không (**blocker**).~~ ✅ Đạt, xem mục 4.3.
2. ~~Native messaging giữa các phiên local có hoạt động giữa 2 tài khoản không.~~ ❌ Không, chỉ trong cùng config dir. Live-session phải dùng tmux (mục 7.3).
3. ~~`claude --bg`, `claude attach`, `claude agents --json` có chạy đúng với `CLAUDE_CONFIG_DIR` tùy biến không.~~ ✅ Có, nhưng phải gọi kèm đúng config dir, và workspace trust tính riêng cho từng tài khoản (mục 7.1).
3b. ~~Resume phiên ngầm có giữ ngữ cảnh không.~~ ✅ Có. Phải `stop` trước và resume **không kèm cờ** thì mới giữ id (mục 7.1).
4. ~~Định dạng input/output của hooks.~~ ✅ Đạt cả 4 hook (mục 8). Còn cần kiểm lại trong phiên tương tác và phiên `--bg`.
5. ~~Plugin cài cho từng config dir riêng biệt.~~ ✅ Đạt, tách biệt hoàn toàn (mục 13.1).
6. ~~`tmux send-keys` vào phiên Claude Code.~~ ✅ Tiếng Việt OK. ⚠️ Gõ khi đang có hộp thoại xin quyền thì **duyệt quyền thay người dùng**, nên bắt buộc theo quy trình 5 bước ở mục 7.3.
7. ~~Quyền Automation của macOS khi dùng `osascript`.~~ ✅ Không cần quyền khi Terminal tự điều khiển chính nó, kể cả từ phiên `--bg` (mục 7.2).
8. **Phát hiện thêm khi thử điểm 7 (bắt buộc áp dụng):**
   - `--allowedTools` / `--disallowedTools` / `--add-dir` / `--mcp-config` là cờ **nhận nhiều giá trị (variadic)**: nó **nuốt cả prompt** nếu prompt đứng sau. Phiên khởi động không có prompt và đứng chờ mãi. Dispatcher **phải đặt prompt ngay sau `claude`, trước mọi cờ**, và truyền danh sách tool trong **một** đối số, phân cách bằng dấu phẩy.
   - Phiên `--bg` đang chờ duyệt quyền hiện trong `claude agents --json` với `"state":"blocked","status":"waiting"`. Dispatcher dùng thông tin này để báo người dùng: "B đang chờ bạn duyệt quyền, chạy `claude-b attach <id>`."

### 17.2 Câu hỏi cho team
1. Tên chính thức của repo và tiền tố lệnh (`duo-` hay khác)?
2. Có cần mẫu báo cáo `result` cố định cho mọi domain, hay mỗi mẫu agent tự định nghĩa thêm trường riêng?
3. `retention_days` mặc định 30 ngày có ổn không?
4. Có cần ghi log chi phí hoặc usage cho từng task không?
5. Dùng 2 tài khoản cho cùng một người có phù hợp với điều khoản sử dụng của Anthropic và chính sách công ty không? Cần ai đó xác nhận trước khi phát hành.

---

## 18. Ghi chú triển khai (v0.4, 2026-11-10)

### 18.1 Khác biệt so với bản nháp
| Bản nháp | Đã triển khai | Lý do |
|---|---|---|
| TypeScript trong `src/` | Node.js ESM thuần trong `plugin/lib/`, **không dependency, không build** | Người nhận chỉ cần Node; cài từ git là chạy. MCP server tự viết (JSON-RPC qua stdio). |
| Lệnh `/duo-setup`… | `/duo:setup`… | Lệnh của plugin luôn có dạng `/<plugin>:<lệnh>` (đã xác minh) |
| `B_to_A: background` | `B_to_A: new-tab` | Lần đầu an toàn hơn (mục 12) |
| Không có | Tool `duo_accept`, `duo_config`, `duo_examples` | Cần cho `before_accept: ask`, `/duo:setup`, bộ mẫu |
| ping/pong | Task thật "trả lời pong" | Kiểm tra được cả đường giao nhận |
| "new-tab" | Terminal.app mở **cửa sổ** mới, iTerm2 mở **tab** mới | Tab của Terminal.app cần quyền Accessibility (mục 7.2) |
| Kết quả giao theo mode của chiều ngược lại | Kết quả / câu hỏi `needs_info` **chỉ đánh thức phiên đã gửi yêu cầu**, không bao giờ mở phiên mới | Một phiên mới không có ngữ cảnh để dùng kết quả |
| `duo_cancel` stop phiên nền | Gửi message `cancel` tới phiên đang xử lý | Phiên nền giữ ngữ cảnh của nhiều việc |

### 18.2 Cơ chế bổ sung
- **Kick**: mỗi hook `SessionStart` / `Stop` của bất kỳ phiên nào cũng chạy nền `duo kick` (tối đa 1 lần mỗi 20 giây) để giao lại các message còn `queued`. Nhờ vậy không cần daemon.
- **Nhặt việc ở `Stop`**: một phiên chỉ nhặt message `queued` chưa có ai nhận, hoặc kết quả mà nó là người gửi yêu cầu. Message xếp hàng cho phiên nền (`queued_mode: background`) chỉ phiên nền mới được nhặt. Mỗi message chỉ được báo **một lần** cho mỗi phiên.
- **Nhắc `duo_reply`**: chỉ áp dụng cho việc giao qua background (không có người ngồi xem): nhắc tối đa `max_reply_reminders` lần, sau đó tự tạo kết quả từ `last_assistant_message` (`auto_result: true`). Phiên tương tác không bị ép.
- **Hiển thị**: Claude Code gắn nhãn mọi lần `Stop` chặn để làm tiếp là "Stop hook error"/"blocking error" trên giao diện, nhưng gửi cho Claude dưới dạng "Stop hook feedback". Đây là giao diện có sẵn; README đã giải thích.
- **Biến môi trường cho phát triển/kiểm thử**: `DUO_HOME` (thư mục dữ liệu khác, được truyền vào phiên mở ra qua `--settings {"env":…}`), `DUO_DRY_RUN=1` (không mở cửa sổ, không thông báo, không spawn).
- **Đọc màn hình tmux** dựa vào cấu trúc ô nhập (đường kẻ / `❯` / đường kẻ ở đáy màn hình), không dựa vào chữ trong hội thoại. Câu trả lời của Claude có cụm "Do you want to…" vẫn không bị hiểu nhầm là hộp thoại.

### 18.3 Kết quả kiểm thử
- **Unit + process test: 40/40** (`npm test`). Gồm: quy tắc config dir, vòng đời message, approval, chặn vòng lặp, hop, rate limit, needs_info, accept/reject/cancel, gc, đọc màn hình tmux (dữ liệu chụp từ phiên thật), lệnh `claude` (prompt đầu, `--allowedTools` cuối), sửa `settings.json` an toàn, 5 hook chạy như tiến trình thật, MCP handshake + 11 tool, CLI.
- **E2E với 2 tài khoản thật** (model haiku cho phiên mở ra, `DUO_HOME` tạm, `dev.plugin_dir`):

| # | Kịch bản | Kết quả |
|---|---|---|
| 1 | A→B background | ✅ ~11s, B dùng `duo_get` + `duo_reply` |
| 2 | Task thứ 2 cho B background | ✅ `resumed: true`, cùng id, B nhớ kết quả task 1 |
| 3 | B→A background (A = config mặc định) | ✅ không tạo `~/.claude/.claude.json` (env được xóa đúng) |
| 4 | Task bảo B "đừng reply" | ✅ B vẫn reply (system prompt bổ sung có ưu tiên cao hơn) |
| 5 | A→B new-tab | ✅ mở cửa sổ Terminal chạy B trong tmux, hook ghi được `TMUX_PANE` |
| 6 | A→B live-session vào cửa sổ của test 5 | ✅ gõ an toàn, `confirmed: true`, B nhớ tiêu đề task trước |
| 7 | Task 2 gửi lúc B đang bận | ✅ `queued (peer_busy)`, hook `Stop` của B tự nhặt, cả 2 xong |
| 8 | Phiên A (tương tác) giao cho B rồi dừng | ✅ kết quả về đúng phiên A đó, A tự đọc và trả lời "= 42" |
| — | `install.sh` trên HOME giả, chạy 2 lần; `duo uninstall --purge` | ✅ chạy lại không đổi gì; gỡ sạch, giữ nguyên nội dung khác của `.zshrc` |

### 18.4 Việc còn lại
- Thử với người dùng thật (1 dev, 1 designer, 1 PM). Thêm ảnh chụp vào README.
- iTerm2: code đã có nhưng **chưa kiểm thử** (máy dev không cài iTerm2).
- Lưới an toàn nhắc `duo_reply` mới được kiểm qua unit test (E2E-4 không kích hoạt vì Claude đã tự reply).
