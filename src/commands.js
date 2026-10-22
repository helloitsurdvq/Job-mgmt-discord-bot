import {
  SlashCommandBuilder,
  ChannelType,
} from "discord.js";

const id = (sub) =>
  sub.addIntegerOption((option) =>
    option
      .setName("id")
      .setDescription("Mã job / mã đơn")
      .setMinValue(1)
      .setMaxValue(4294967295)
      .setRequired(true),
  );
const note = (sub, label = "Nội dung / lý do") =>
  sub.addStringOption((option) =>
    option
      .setName("note")
      .setDescription(label)
      .setMaxLength(1500)
      .setRequired(true),
  );
const page = (sub) =>
  sub.addIntegerOption((option) =>
    option
      .setName("page")
      .setDescription("Trang, mỗi trang 10 mục")
      .setMinValue(1)
      .setMaxValue(10000),
  );
const user = (sub, required = false) =>
  sub.addUserOption((option) =>
    option.setName("user").setDescription("Thành viên").setRequired(required),
  );
const channel = (sub) =>
  sub.addChannelOption((option) =>
    option
      .setName("channel")
      .setDescription("Channel được phép dùng bot")
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true),
  );
const month = (sub) =>
  sub.addStringOption((option) =>
    option
      .setName("month")
      .setDescription("Tháng YYYY-MM theo giờ Việt Nam")
      .setMinLength(7)
      .setMaxLength(7)
      .setRequired(true),
  );

export const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Cấu hình bot cho server (quản trị viên / role cấu hình bot)")
    // Role names cannot be expressed in default Discord permission bits.
    // Interaction and service authorization enforce the configuration role.
    .setDefaultMemberPermissions(null)
    .addChannelOption((option) =>
      option
        .setName("report-channel")
        .setDescription("Channel nhận báo cáo và đơn báo bận")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    )
    .addRoleOption((option) =>
      option
        .setName("lead-role")
        .setDescription("Role quản lý công việc")
        .setRequired(true),
    )
    .addChannelOption((option) =>
      option
        .setName("command-channel")
        .setDescription("Channel thành viên được dùng lệnh")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("settings")
    .setDescription("Xem cấu hình và quản lý channel")
    .setDefaultMemberPermissions(null)
    .addSubcommand((sub) =>
      sub
        .setName("show")
        .setDescription("Xem cấu hình và tình trạng gửi thông báo"),
    )
    .addSubcommand((sub) =>
      channel(
        sub
          .setName("channel-add")
          .setDescription("Cho phép dùng bot tại channel"),
      ),
    )
    .addSubcommand((sub) =>
      channel(
        sub
          .setName("channel-remove")
          .setDescription("Bỏ quyền dùng bot tại channel"),
      ),
    ),
  new SlashCommandBuilder()
    .setName("job")
    .setDescription("Quản lý công việc")
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("Lead tạo và giao job")
        .addStringOption((option) =>
          option
            .setName("title")
            .setDescription("Tên công việc")
            .setMaxLength(150)
            .setRequired(true),
        )
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("Người nhận việc")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("deadline")
            .setDescription("YYYY-MM-DD HH:mm, giờ Việt Nam")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("description")
            .setDescription("Yêu cầu / tiêu chí hoàn thành")
            .setMaxLength(1500),
        )
        .addIntegerOption((option) =>
          option
            .setName("points")
            .setDescription("Điểm khi được duyệt, mặc định 1")
            .setMinValue(1)
            .setMaxValue(1000),
        )
        .addStringOption((option) =>
          option
            .setName("checkin")
            .setDescription("Mốc cập nhật tiếp theo: YYYY-MM-DD HH:mm"),
        ),
    )
    .addSubcommand((sub) =>
      page(
        user(
          sub
            .setName("list")
            .setDescription("Xem job của mình; lead có thể chọn người khác"),
        ).addStringOption((option) =>
          option
            .setName("filter")
            .setDescription("Bộ lọc")
            .addChoices(
              { name: "Đang mở", value: "active" },
              { name: "Hoàn thành", value: "completed" },
              { name: "Quá hạn", value: "overdue" },
              { name: "Chờ duyệt", value: "submitted" },
              { name: "Tất cả", value: "all" },
            ),
        ),
      ),
    )
    .addSubcommand((sub) =>
      id(
        sub
          .setName("view")
          .setDescription("Chi tiết job và 5 cập nhật gần nhất"),
      ),
    )
    .addSubcommand((sub) =>
      id(sub.setName("accept").setDescription("Xác nhận nhận việc")),
    )
    .addSubcommand((sub) =>
      note(
        id(
          sub.setName("decline").setDescription("Từ chối nhận việc, kèm lý do"),
        ),
      ),
    )
    .addSubcommand((sub) =>
      id(
        sub
          .setName("update")
          .setDescription("Mở biểu mẫu cập nhật tiến độ / vướng mắc"),
      ),
    )
    .addSubcommand((sub) =>
      id(sub.setName("submit").setDescription("Gửi kết quả để lead duyệt")),
    )
    .addSubcommand((sub) =>
      id(sub.setName("approve").setDescription("Lead xác nhận hoàn thành")),
    )
    .addSubcommand((sub) =>
      note(
        id(sub.setName("return").setDescription("Lead yêu cầu sửa kết quả")),
      ),
    )
    .addSubcommand((sub) =>
      note(id(sub.setName("cancel").setDescription("Lead hủy công việc"))),
    )
    .addSubcommand((sub) =>
      note(
        id(
          sub.setName("reschedule").setDescription("Lead thay đổi deadline"),
        ).addStringOption((option) =>
          option
            .setName("deadline")
            .setDescription("YYYY-MM-DD HH:mm, giờ Việt Nam")
            .setRequired(true),
        ),
      ),
    )
    .addSubcommand((sub) =>
      note(
        user(
          id(
            sub
              .setName("reassign")
              .setDescription("Lead chuyển job cho người khác"),
          ),
          true,
        ),
      ),
    ),
  new SlashCommandBuilder()
    .setName("absence")
    .setDescription("Báo bận / xin nghỉ")
    .addSubcommand((sub) =>
      sub.setName("request").setDescription("Mở biểu mẫu báo bận / xin nghỉ"),
    )
    .addSubcommand((sub) =>
      page(
        user(
          sub
            .setName("list")
            .setDescription("Xem đơn của mình; lead xem được cả server"),
        ).addStringOption((option) =>
          option
            .setName("filter")
            .setDescription("Bộ lọc")
            .addChoices(
              { name: "Còn hiệu lực", value: "active" },
              { name: "Chờ duyệt", value: "pending" },
              { name: "Tất cả", value: "all" },
            ),
        ),
      ),
    )
    .addSubcommand((sub) =>
      id(sub.setName("approve").setDescription("Lead duyệt đơn")),
    )
    .addSubcommand((sub) =>
      note(
        id(sub.setName("reject").setDescription("Lead từ chối đơn, kèm lý do")),
      ),
    )
    .addSubcommand((sub) =>
      note(
        id(sub.setName("cancel").setDescription("Hủy đơn báo bận của mình")),
      ),
    ),
  new SlashCommandBuilder()
    .setName("report")
    .setDescription("Lead xem tổng hợp công việc và báo bận")
    .addIntegerOption((option) =>
      option
        .setName("days")
        .setDescription("Khoảng tính kết quả, mặc định 30 ngày")
        .setMinValue(1)
        .setMaxValue(365),
    )
    .addIntegerOption((option) =>
      option
        .setName("page")
        .setDescription("Trang thành viên")
        .setMinValue(1)
        .setMaxValue(10000),
    ),
  new SlashCommandBuilder()
    .setName("kpi")
    .setDescription("Chỉ tiêu điểm và kết quả theo tháng")
    .addSubcommand((sub) =>
      month(
        user(
          sub.setName("set").setDescription("Lead đặt chỉ tiêu điểm tháng"),
          true,
        ),
      ).addIntegerOption((option) =>
        option
          .setName("target")
          .setDescription("Chỉ tiêu điểm công việc")
          .setMinValue(1)
          .setMaxValue(1000000)
          .setRequired(true),
      ),
    )
    .addSubcommand((sub) =>
      user(
        month(
          sub
            .setName("view")
            .setDescription("Xem KPI của mình; lead có thể chọn người khác"),
        ),
      ),
    ),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Hướng dẫn sử dụng bot"),
];
