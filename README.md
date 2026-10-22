# Eishin Flash

Bot quản lý Job, Deadline và KPI cho Discord server.

[![Node.js 24.22.1](https://img.shields.io/badge/Node.js-24.22.1-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![discord.js 14.27.0](https://img.shields.io/badge/discord.js-14.27.0-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.js.org/) [![MySQL 8.4](https://img.shields.io/badge/MySQL-8.4-4479A1?style=flat-square&logo=mysql&logoColor=white)](https://www.mysql.com/)

## Features

- **Job:** tạo việc, giao người nhận, nhận/từ chối, cập nhật tiến độ và nộp kết quả. <!-- - **Lead:** duyệt hoàn thành, yêu cầu sửa, đổi deadline, chuyển người hoặc hủy job. -->
- **Absence:** gửi đơn báo bận/xin nghỉ và duyệt hoặc từ chối bằng nút bấm.
- **KPI:** đặt chỉ tiêu điểm theo tháng, xem điểm thực hiện và tỷ lệ đạt.
- **Report:** tổng hợp job đang làm, quá hạn, chờ duyệt và kết quả của thành viên.
- **Notifications:** gửi DM, thông báo vào channel đã cấu hình và tự nhắc các mốc công việc.
- **Database:** lưu lịch sử thay đổi, kiểm tra quyền và giữ hàng đợi thông báo để gửi lại khi lỗi.

## Setup

- Node.js **24.22.1 trở lên**; project và CI chọn chính xác **24.22.1** qua `.node-version`.
- MySQL **8.0.16 trở lên**, dùng InnoDB và `utf8mb4`; Docker mẫu sử dụng MySQL **8.4**.
<!-- - Một Discord application có bot token và quyền quản lý server để cấu hình ban đầu. -->

Các ví dụ dưới dùng `npm`. Trên PowerShell, dùng `npm.cmd` nếu gặp lỗi chính sách thực thi `npm.ps1`.

Để nâng Node trên Windows, cài [Node.js 24.22.1 x64](https://nodejs.org/dist/v24.22.1/node-v24.22.1-x64.msi), mở lại terminal và kiểm tra `node --version`. Đổi `engines.node` hoặc `.node-version` chỉ cập nhật yêu cầu của project, không tự cài Node vào máy.

### 1. Install dependencies

Fork/clone repository hoặc tải source code về máy, sau đó mở terminal tại thư mục project:

```shell
npm ci
```

### 2. Prepare MySQL

Chọn **một** trong hai cách sau.

**Dùng Docker có sẵn trong project:** mở Docker Desktop rồi chạy:

```shell
docker compose up -d mysql
```

Thông tin kết nối từ máy chạy bot:

| Cấu hình | Giá trị |
| --- | --- |
| Host | `127.0.0.1` |
| Port | `3307` |
| Database | `job_bot` |
| User | `job_bot` |
| Password | `change_me` |

Compose tự tạo database và user. Dữ liệu nằm trong volume `mysql_data`; các mật khẩu mẫu chỉ dành cho local.

**Dùng MySQL đã cài:**

```sql
CREATE DATABASE job_bot CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'job_bot'@'localhost' IDENTIFIED BY 'YOUR_DATABASE_PASSWORD';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
ON job_bot.* TO 'job_bot'@'localhost';
```

Điền mật khẩu bạn đã chọn vào `.env`. Dùng port của MySQL hiện tại, thường là `3306`. Nếu bot kết nối từ máy khác, tạo user với host/IP phù hợp thay cho `localhost`.

### 3. Create a Discord bot

1. Vào [Discord Developer Portal](https://discord.com/developers/applications), tạo hoặc chọn application.
2. Sao chép **Application ID** trong **General Information** làm `DISCORD_CLIENT_ID`.
3. Trong **Bot**, lấy token làm `DISCORD_TOKEN`.
4. Bật **Developer Mode** trong Discord, chuột phải vào server → **Copy Server ID** để lấy `DISCORD_GUILD_ID`.
5. Vào **OAuth2 → URL Generator**, chọn scopes `bot` và `applications.commands`, cấp quyền **View Channels**, **Send Messages**, **Embed Links**, rồi mở link để mời bot vào server.

Bot chỉ dùng intent `Guilds`, không cần cấp Administrator hoặc bật Message Content/Server Members privileged intent. Thành viên cần quyền **Use Application Commands** tại channel sử dụng bot.

Tạo role **Lead** và gán cho người quản lý. Để bot ping Lead, role cần cho phép mention hoặc bot có quyền mention phù hợp.

### 4. Configure environment

Sao chép `.env.example` thành `.env`, sau đó điền thông tin kết nối. Nếu đã có `.env`, giữ lại cấu hình đang dùng.

### 5. Initialize database and commands

```shell
npm run db:migrate
npm run deploy
```

- `db:migrate` tạo bảng và ghi nhận migration đã chạy; có thể chạy lại khi có migration mới.
- `deploy` đăng ký command cho server trong `.env`. Chạy lại khi thay đổi tên, mô tả hoặc argument của lệnh.

## Usage

Chạy bot:

```shell
npm run dev
```

Khi bot đã online, quản trị viên chạy trong server:

```text
/setup report-channel:#bot-commands lead-role:@Lead command-channel:#bot-commands
/help
```

Thay `#bot-commands` bằng channel muốn dùng. `report-channel` và `command-channel` có thể là cùng một channel hoặc hai channel sẵn có khác nhau.

`/setup` và `/settings` dành cho quản trị viên, có thể dùng ngoài channel được phép để khôi phục cấu hình. Các lệnh nghiệp vụ cần chạy trong channel đã cho phép hoặc report-channel; `/help` xem được trong server.

### Job workflow

Lead tạo job:

```text
/job create title:Thiết kế banner user:@An deadline:2026-10-25 18:00 points:5 description:Thiết kế banner cho sự kiện
```

Đổi ngày trong ví dụ sang thời điểm tương lai khi sử dụng. Ngày giờ luôn theo **giờ Việt Nam (UTC+7)**, định dạng `YYYY-MM-DD HH:mm`.

1. Bot xác nhận riêng cho Lead và gửi lời mời **Nhận việc / Từ chối** qua DM cho người được giao ở lượt worker tiếp theo.
2. Người nhận chọn một trong hai nút hoặc dùng `/job accept`, `/job decline`. Bot công khai trạng thái sau khi có quyết định.
3. Người nhận cập nhật tiến độ và nộp kết quả; Lead duyệt hoàn thành hoặc yêu cầu sửa.

```text
/job list
/job view id:1
/job accept id:1
/job update id:1
/job submit id:1
```

- `/job update` mở form nhập phần trăm, trạng thái `doing`/`blocked`, mốc cập nhật và ghi chú. Nếu bỏ trống mốc cập nhật, bot chọn tối đa 7 ngày và không sau deadline nếu job còn hạn.
- `/job submit` mở form gửi kết quả hoặc link sản phẩm. Tiến độ 100% chưa đồng nghĩa đã hoàn thành được duyệt.
- Job chờ nhận giữ riêng qua DM hoặc `/job view`; trang `/job list` có job chờ nhận cũng giữ riêng. Lead vẫn kiểm tra được theo quyền hiện tại, nhưng chỉ người được giao được nhận/từ chối.
- `/job cancel` mở xác nhận riêng cho Lead. Chỉ khi bấm xác nhận, job mới bị hủy và kết quả mới công khai. Không xóa phản hồi gốc của lệnh.

Lead xử lý kết quả:

```text
/job approve id:1
/job return id:1 note:Chỉnh kích thước và gửi lại file nguồn
```

Bot luôn kiểm tra trạng thái mới trong MySQL khi bấm nút, kể cả nút trên tin cũ. Job đã được duyệt không được duyệt/cộng điểm lần nữa.

### Absence workflow

```text
/absence request
/absence list filter:pending
```

1. Thành viên mở form, nhập bắt đầu, kết thúc và lý do. Hai thời điểm phải ở tương lai; kết thúc phải sau bắt đầu.
2. Bot xác nhận công khai tại channel gọi lệnh và gửi đơn kèm **Duyệt báo bận / Không duyệt** vào report-channel ở lượt worker tiếp theo.
3. Lead duyệt hoặc từ chối ngay bằng nút. Bot công khai kết quả, lý do và phản hồi, đồng thời gửi DM cho người tạo đơn.

Mọi người có quyền xem channel đều thấy đơn và các nút; **chỉ Lead/quản trị viên được duyệt hoặc từ chối**, và người gửi không được tự duyệt đơn của mình. Thành viên chỉ truy vấn đơn của mình; Lead có thể truy vấn cả server. Danh sách trả về vẫn hiển thị công khai trong channel gọi lệnh.

Đơn báo bận chỉ liệt kê các job đang mở để Lead xem xét. Giao việc cho người có đơn báo bận liên quan sẽ có cảnh báo. Việc nghỉ **không tự gia hạn deadline hoặc giảm KPI**. Bot không có bước Mở đơn, lệnh `/absence review` hoặc yêu cầu thêm channel riêng.

### KPI

```text
/kpi set user:@An month:2026-10 target:20
/kpi view month:2026-10 user:@An
```

- Điểm thực hiện là tổng `points` của các job được duyệt hoàn thành trong tháng, theo UTC+7.
- Tỷ lệ đạt = điểm thực hiện / chỉ tiêu × 100%, có thể vượt 100%.
- Job đúng hạn khi lần nộp được duyệt có `submitted_at <= due_at`; Lead duyệt muộn không làm mất tính đúng hạn của lần nộp đó.
- Khi bị yêu cầu sửa, lần nộp tiếp theo là lần dùng để đánh giá. Chưa có trọng số chất lượng, trừ điểm tự động hoặc KPI theo nhóm.

### Updating the bot

- Sửa nội dung thông báo hoặc xử lý lệnh: khởi động lại `npm start`; nếu dùng `npm run dev` thì có thể tự khởi động lại.
- Sửa định nghĩa slash command trong `src/commands.js`: chạy thêm `npm run deploy`.
- Thêm migration: chạy `npm run db:migrate` trước khi khởi động bản mới.

## Commands

Nhập `/help` trong Discord để xem lệnh và mô tả theo nhóm. Discord sẽ hiển thị các tham số bắt buộc khi bạn chọn lệnh.

| Command | Description | Role |
| --- | --- | --- |
| `/job create` | Tạo job, người nhận, deadline, điểm và mốc cập nhật | Lead |
| `/job list` | Lọc theo người, trạng thái, trang; mặc định job của mình | Thành viên; Lead chọn người khác |
| `/job view` | Chi tiết job và 5 cập nhật gần nhất | Người nhận / Lead |
| `/job accept` | Nhận job đang chờ xác nhận | Người nhận |
| `/job decline` | Từ chối job chưa nhận và nêu lý do | Người nhận |
| `/job update` | Cập nhật tiến độ, tình trạng và ghi chú | Người nhận |
| `/job submit` | Gửi kết quả để Lead duyệt | Người nhận |
| `/job approve` | Duyệt hoàn thành và ghi nhận KPI | Lead |
| `/job return` | Yêu cầu chỉnh sửa kết quả | Lead |
| `/job reschedule` | Đổi deadline và ghi lý do | Lead |
| `/job reassign` | Chuyển người; trở về chờ nhận, tiến độ 0% | Lead |
| `/job cancel` | Mở xác nhận hủy riêng, xác nhận xong mới hủy | Lead |
| `/absence request` | Mở form báo bận / xin nghỉ | Thành viên |
| `/absence list` | Lọc đơn còn hiệu lực, chờ duyệt hoặc tất cả | Thành viên xem mình; Lead xem cả server |
| `/absence approve` | Duyệt đơn | Lead khác người gửi |
| `/absence reject` | Từ chối và phản hồi | Lead khác người gửi |
| `/absence cancel` | Hủy đơn chờ duyệt hoặc đã duyệt | Người gửi / Lead |
| `/kpi set` | Đặt chỉ tiêu điểm từng tháng | Lead |
| `/kpi view` | Xem điểm, chỉ tiêu và tỷ lệ đạt | Thành viên xem mình; Lead chọn người khác |
| `/report` | Tổng hợp job, đơn nghỉ và kết quả; mặc định 30 ngày | Lead |
| `/setup` | Cấu hình role Lead và channel | Quản trị viên |
| `/settings show` | Xem cấu hình, thông báo đang chờ và DM thất bại | Quản trị viên |
| `/settings channel-add` | Cho phép dùng bot tại channel | Quản trị viên |
| `/settings channel-remove` | Bỏ channel dùng bot | Quản trị viên |
| `/help` | Hướng dẫn sử dụng trong Discord | Thành viên |

<!-- Các danh sách job, đơn nghỉ và báo cáo hỗ trợ `page`, mỗi trang tối đa 10 mục. `/setup`, `/settings`, xác nhận hủy job và chi tiết lỗi trả lời riêng; các phản hồi nghiệp vụ còn lại công khai, ngoại trừ job đang chờ nhận. -->

## Notifications

- **Sắp deadline:** nhắc một lần khi còn tối đa 24 giờ, theo từng deadline/người nhận.
- **Quá hạn hoặc đến mốc cập nhật:**
- **Chờ nhận trên 24 giờ:**
- **Kết quả chờ duyệt trên 24 giờ:**
- **Gửi lỗi:**

Bật nhận DM từ server để nhận lời mời và thông báo. `/settings show` giúp kiểm tra hàng đợi và DM thất bại; thành viên vẫn có thể dùng `/job list` khi DM bị chặn.
<!-- 
Queue gửi theo cơ chế **at least once**: tin có thể bị lặp nếu bot tắt sau khi Discord nhận nhưng trước khi database ghi nhận đã gửi. Trạng thái MySQL và khóa giao dịch ngăn duyệt/cộng điểm cùng job hai lần. -->

<!-- Bot chỉ gửi thông báo khi đang chạy. Sau restart, worker kiểm tra trạng thái hiện tại, không gửi bù từng ngày bị tắt. Khi vận hành thường xuyên, dùng máy/VPS luôn bật, cơ chế tự khởi động lại và sao lưu MySQL. Chạy một tiến trình cho mỗi bộ `.env`; worker có khóa MySQL chống gửi hàng đợi đồng thời. -->

<!-- ## GitHub Actions

Workflow trong [.github/workflows/ci.yml](.github/workflows/ci.yml) tự chạy khi push, pull request hoặc chọn **Run workflow** trên GitHub:

- Kiểm tra cú pháp và unit test với Node.js 24.22.1 (đọc từ `.node-version`) trên Ubuntu/Windows.
- Chạy integration test với MySQL 8.4 và database test riêng.
- Khi tất cả test đạt, tạo gói tải về cho push và chạy thủ công; pull request chỉ chạy kiểm tra.

Không cần bot token hoặc GitHub Secrets. Tải gói tại **Actions → CI and package → chọn run thành công → Artifacts**. Gói không chứa `.env`, `node_modules` hoặc dữ liệu MySQL, được lưu 14 ngày. Bản này chỉ kiểm tra và đóng gói, chưa tự triển khai bot. -->

Xem [hướng dẫn GitHub Actions](.github/README.md) để cấu hình và dùng gói tải về.

## Project structure

```text
database/migrations/     SQL tạo bảng và cập nhật schema
src/
  config.js              Cấu hình Discord và MySQL
  database.js            Connection pool, transaction và migration
  domain.js              Ngày giờ, phân quyền và trạng thái
  service.js             Xử lý job, đơn nghỉ và KPI
  commands.js            Khai báo slash command
  interactions.js        Nhận lệnh, nút và form
  views.js               Embed, emoji và nút thao tác
  outbox.js              Lưu hàng đợi thông báo
  worker.js              Nhắc việc và gửi thông báo
  index.js               Khởi động bot
scripts/                 Migration, deploy command và kiểm tra cú pháp
test/                    Unit test và integration test MySQL
docs/                    Thiết kế
```
<!-- 
## Tests

```shell
npm run check
npm test
```

Integration test cần một database riêng có tên kết thúc bằng `_test`. Tạo và cấp quyền bằng tài khoản quản trị:

```sql
CREATE DATABASE job_bot_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
ON job_bot_test.* TO 'job_bot'@'localhost';
```

Điều chỉnh user/host trong `GRANT` cho khớp tài khoản MySQL đang dùng. Chạy trong PowerShell, dùng cùng thông tin kết nối MySQL trong `.env`; biến dưới chỉ thay tên database sang database test:

```powershell
$env:TEST_MYSQL_DATABASE = 'job_bot_test'
npm.cmd run test:integration
Remove-Item Env:TEST_MYSQL_DATABASE
```

Không đặt biến trên thì integration test được skip. Test chỉ dọn fixture của mình theo guild ID; vẫn nên dùng database chỉ dành cho kiểm thử. Unit test không thay thế việc thử bot trên Discord thật. -->
