import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
  ChannelType,
} from "discord.js";
import {
  UserError,
  ensure,
  parseVietnamTime,
  positiveInteger,
  authorizeBotConfiguration,
  BOT_CONFIGURATION_ROLE,
} from "./domain.js";
import {
  jobDetail,
  jobList,
  jobEmbed,
  absenceList,
  absenceEmbed,
  absenceButtons,
  reportView,
  kpiView,
  safe,
  cancellationConfirmation,
} from "./views.js";

export function actorFrom(interaction, guildId) {
  ensure(
    interaction.inGuild() && interaction.guildId === guildId,
    "Hãy sử dụng bot trong server đã cấu hình.",
  );
  const roles = interaction.member.roles;
  const roleIds = Array.isArray(roles) ? roles : [...roles.cache.keys()];
  const roleCache = Array.isArray(roles)
    ? interaction.guild?.roles?.cache
    : roles.cache;
  return {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    isAdmin:
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
      false,
    roleIds,
    roleNames: roleIds.map((id) => roleCache?.get(id)?.name).filter(Boolean),
  };
}

function assignmentRoute(customId, guildId) {
  const match = /^assignment:(accept|decline):(\d{17,20}):(\d+)$/.exec(
    customId || "",
  );
  ensure(
    match && match[2] === guildId,
    "Lời mời nhận việc không hợp lệ hoặc thuộc server khác.",
  );
  return { action: match[1], id: positiveInteger(Number(match[3]), "Mã job") };
}

async function assignmentActor(interaction, service, guildId) {
  const settings = await service.settings(guildId);
  const guild = await interaction.client.guilds.fetch(guildId);
  const member = await guild.members
    .fetch(interaction.user.id)
    .catch(() => null);
  ensure(
    member && !member.user.bot,
    "Bạn phải còn là thành viên của server để trả lời lời mời.",
  );
  // DM không có channel server. Chỉ hai hành động accept/decline được đi qua nhánh này.
  // Service vẫn kiểm tra đúng người được giao và trạng thái mới nhất trong MySQL.
  return {
    guildId,
    channelId: settings.report_channel_id,
    userId: interaction.user.id,
    isAdmin: member.permissions.has(PermissionFlagsBits.Administrator),
    roleIds: [...member.roles.cache.keys()],
  };
}

function field(
  key,
  label,
  { paragraph = false, required = true, placeholder, max = 1500 } = {},
) {
  const input = new TextInputBuilder()
    .setCustomId(key)
    .setLabel(label)
    .setRequired(required)
    .setStyle(paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setMaxLength(max);
  if (placeholder) input.setPlaceholder(placeholder);
  return new ActionRowBuilder().addComponents(input);
}

export function absenceModal() {
  return new ModalBuilder()
    .setCustomId("absence:request:new")
    .setTitle("🌴 Báo bận / xin nghỉ")
    .addComponents(
      field("start", "🗓️ Bắt đầu (giờ Việt Nam)", {
        max: 16,
        placeholder: "YYYY-MM-DD HH:mm",
      }),
      field("end", "🏁 Kết thúc dự kiến (giờ Việt Nam)", {
        max: 16,
        placeholder: "YYYY-MM-DD HH:mm",
      }),
      field("reason", "📝 Lý do báo bận / xin nghỉ", { paragraph: true }),
    );
}

export function actionModal(entity, action, id) {
  const modal = new ModalBuilder()
    .setCustomId(`${entity}:${action}:${id}`)
    .setTitle(entity === "job" ? `💼 Job #${id}` : `🌴 Đơn #${id}`);
  if (action === "update") {
    modal.addComponents(
      field("progress", "📈 Tiến độ từ 0 đến 100", {
        max: 3,
        placeholder: "50",
      }),
      field("status", "📌 Trạng thái: doing hoặc blocked", {
        max: 10,
        placeholder: "doing",
      }),
      field("checkin", "🗓️ Mốc cập nhật tiếp (giờ Việt Nam)", {
        required: false,
        max: 16,
        placeholder: "2026-10-25 18:00",
      }),
      field("note", "📝 Đã làm gì / đang vướng gì?", { paragraph: true }),
    );
  } else {
    modal.addComponents(
      field(
        "note",
        action === "submit"
          ? "📎 Kết quả / đường dẫn sản phẩm"
          : "📝 Lý do / nội dung yêu cầu",
        { paragraph: true },
      ),
    );
  }
  return modal;
}

async function validateTarget(interaction, userId) {
  const member = await interaction.guild.members
    .fetch(userId)
    .catch(() => null);
  ensure(
    member && !member.user.bot,
    "Người nhận phải là thành viên thật đang ở trong server.",
  );
}

function validateChannel(interaction, channel, privateChannel = false) {
  ensure(
    channel?.type === ChannelType.GuildText &&
      channel.guildId === interaction.guildId,
    "Hãy chọn text channel thuộc server này.",
  );
  const permissions = channel.permissionsFor(interaction.guild.members.me);
  ensure(
    permissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ]),
    "Bot cần quyền View Channel, Send Messages và Embed Links tại channel được chọn.",
  );
  //if (privateChannel) ensure(!channel.permissionsFor(interaction.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel),
  // 'Channel báo cáo chứa lý do nghỉ. Hãy tắt View Channel của @everyone và chỉ cho lead/quản trị viên xem.');
}

const help = () => {
  const commandList = (entries) =>
    entries
      .map(([command, description]) => `• **\`${command}\`**: ${description}`)
      .join("\n");

  return {
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("📖 Eishin Flash — HƯỚNG DẪN")
        .setDescription(
          "Quản lý công việc, deadline, báo bận và KPI trong Discord. Chọn lệnh phù hợp với vai trò của bạn bên dưới.",
        )
        .addFields(
          {
            name: "👥 THÀNH VIÊN · CÔNG VIỆC",
            value: commandList([
              ["/job list", "Xem danh sách công việc của bạn."],
              ["/job view", "Xem chi tiết job và các cập nhật gần nhất."],
              ["/job accept", "Xác nhận nhận công việc được giao."],
              ["/job decline", "Từ chối nhận việc và nêu lý do."],
              ["/job update", "Cập nhật tiến độ, tình trạng và vướng mắc."],
              ["/job submit", "Gửi kết quả hoặc link sản phẩm để Lead duyệt."],
            ]),
          },
          {
            name: "🌴 THÀNH VIÊN · BÁO BẬN & KPI",
            value: commandList([
              [
                "/absence request",
                "Mở form xin nghỉ: nhập thời gian bắt đầu, kết thúc và lý do.",
              ],
              [
                "/absence list",
                "Xem danh sách đơn của mình; Lead có thể xem cả server.",
              ],
              [
                "/absence cancel",
                "Hủy đơn của mình đang chờ duyệt hoặc đã được duyệt.",
              ],
              ["/kpi view", "Xem điểm và tiến độ KPI theo tháng."],
            ]),
          },
          {
            name: "🧭 LEAD · QUẢN LÝ CÔNG VIỆC",
            value: commandList([
              [
                "/job create",
                "Tạo job và gửi lời mời nhận việc cho thành viên.",
              ],
              ["/job approve", "Xác nhận hoàn thành job và ghi nhận điểm KPI."],
              ["/job return", "Yêu cầu thành viên chỉnh sửa kết quả."],
              ["/job reschedule", "Thay đổi deadline của job."],
              ["/job reassign", "Chuyển job cho người phụ trách khác."],
              ["/job cancel", "Mở xác nhận riêng; bấm xác nhận để hủy job."],
            ]),
          },
          {
            name: "✅ LEAD · DUYỆT ĐƠN & BÁO CÁO",
            value: commandList([
              ["/absence approve", "Duyệt đơn báo bận / xin nghỉ."],
              ["/absence reject", "Từ chối đơn và gửi lý do phản hồi."],
              [
                "/report",
                "Xem báo cáo tổng hợp công việc, đơn nghỉ và kết quả.",
              ],
              ["/kpi set", "Đặt chỉ tiêu KPI theo tháng cho thành viên."],
            ]),
          },
          {
            name: "🛡️ CẤU HÌNH BOT",
            value: `Dành cho quản trị viên hoặc role **${BOT_CONFIGURATION_ROLE}**.\n\n` + commandList([
              [
                "/setup",
                "Cấu hình role Lead, channel báo cáo và channel dùng lệnh.",
              ],
              ["/settings show", "Xem cấu hình và tình trạng gửi thông báo."],
              [
                "/settings channel-add",
                "Cho phép sử dụng bot tại một channel.",
              ],
              [
                "/settings channel-remove",
                "Bỏ quyền sử dụng bot tại một channel.",
              ],
            ]),
          },
          {
            name: "📌 LƯU Ý KHI SỬ DỤNG",
            value: [
              "• **Ngày giờ:** nhập theo format `YYYY-MM-DD HH:mm`, theo giờ Việt Nam (UTC+7).",
              "• **Xin nghỉ:** thời gian phải ở tương lai; kết thúc phải sau bắt đầu.",
              "• **Nhận job:** lời mời giữ riêng qua DM hoặc `/job view`; nhận/từ chối xong mới công khai trạng thái.",
              "• **Hủy job:** tin xác nhận chỉ Lead xem; xác nhận xong mới công khai kết quả.",
              "• **Báo bận:** đơn, nút duyệt và kết quả hiển thị công khai; chỉ Lead/admin được duyệt. Không tự duyệt đơn của mình.",
              "• **Thông báo:** tập trung ở channel đã cấu hình; bật nhận DM từ server để nhận lời mời và cập nhật.",
              "• **Deadline & KPI:** báo bận không tự gia hạn deadline hoặc giảm chỉ tiêu; Lead quyết định.",
            ].join("\n"),
          },
        )
        .setFooter({
          text: "💡 Nhập / rồi chọn lệnh để xem các tham số cần điền.",
        }),
    ],
  };
};

async function slash(interaction, actor, service) {
  const options = interaction.options;
  const command = interaction.commandName;
  const action = options.getSubcommand(false);
  if (command === "setup") {
    authorizeBotConfiguration(actor);
    const report = options.getChannel("report-channel", true);
    const channel = options.getChannel("command-channel", true);
    const role = options.getRole("lead-role", true);
    //ensure(role.id !== actor.guildId, 'Không được dùng @everyone làm role lead.');
    //validateChannel(interaction, report, true);
    //validateChannel(interaction, channel);
    ensure(
      report.permissionsFor(role)?.has(PermissionFlagsBits.ViewChannel),
      "Role lead phải có quyền View Channel ở channel báo cáo.",
    );
    await service.configure(actor, {
      leadRoleId: role.id,
      reportChannelId: report.id,
      commandChannelId: channel.id,
    });
    return {
      content:
        "✅ Đã cấu hình bot. Dùng /settings show để kiểm tra và /help để xem lệnh.",
    };
  }
  if (command === "settings") {
    authorizeBotConfiguration(actor);
    if (action === "show") {
      const { settings, counts } = await service.deliveryStatus(actor);
      return {
        content:
          `🧭 Role lead: <@&${settings.lead_role_id}>\n📣 Channel báo cáo: <#${settings.report_channel_id}>\n` +
          `💬 Channel dùng lệnh: ${settings.channels.map((id) => `<#${id}>`).join(", ") || "Chỉ channel báo cáo"}\n` +
          `⏳ Thông báo đang chờ: ${counts.pending} · 📭 DM thất bại: ${counts.failed}`,
      };
    }
    const channel = options.getChannel("channel", true);
    //if (action === 'channel-add') validateChannel(interaction, channel);
    await service.changeChannel(actor, channel.id, action === "channel-add");
    return { content: "✅ Đã cập nhật danh sách channel." };
  }
  if (command === "help") return help();
  if (command === "report")
    return reportView(
      await service.report(
        actor,
        options.getInteger("days") ?? 30,
        options.getInteger("page") ?? 1,
      ),
    );
  if (command === "kpi") {
    const userId = options.getUser("user")?.id;
    const month = options.getString("month", true);
    if (action === "set") {
      await service.access(actor, service.pool, true);
      await validateTarget(interaction, userId);
      await service.setKpi(actor, {
        userId,
        month,
        target: options.getInteger("target", true),
      });
      return {
        content: `🎯 Đã đặt chỉ tiêu KPI tháng ${month}. Dùng /kpi view để xem.`,
      };
    }
    return kpiView(
      await service.viewKpi(actor, { ...(userId ? { userId } : {}), month }),
    );
  }
  if (command === "job") {
    if (action === "create") {
      await service.access(actor, service.pool, true);
      const userId = options.getUser("user", true).id;
      await validateTarget(interaction, userId);
      const checkin = options.getString("checkin");
      const { job, warning } = await service.createJob(actor, {
        title: options.getString("title", true),
        assigneeId: userId,
        description: options.getString("description"),
        points: options.getInteger("points") ?? 1,
        dueAt: parseVietnamTime(options.getString("deadline", true)),
        nextCheckinAt: checkin ? parseVietnamTime(checkin) : undefined,
      });
      return {
        privateReply: true,
        content: `✅ Đã lưu job #${job.id}. Lời mời nhận/từ chối sẽ được gửi riêng cho người nhận qua DM ở lượt worker tiếp theo.${warning ? `\n⚠️ ${warning}` : ""}`,
      };
    }
    if (action === "list") {
      const data = await service.listJobs(actor, {
        userId: options.getUser("user")?.id,
        filter: options.getString("filter") || "active",
        page: options.getInteger("page") ?? 1,
      });
      return {
        ...jobList(data),
        privateReply: data.jobs.some((job) => job.status === "assigned"),
      };
    }
    const id = options.getInteger("id", true);
    if (action === "view") {
      const data = await service.viewJob(actor, id);
      return {
        ...jobDetail(data, {
          canRespond: data.job.assignee_id === actor.userId,
        }),
        privateReply: data.job.status === "assigned",
      };
    }
    if (action === "cancel") {
      const preview = await service.previewCancellation(
        actor,
        id,
        options.getString("note", true),
      );
      return cancellationConfirmation(preview.job, preview.note);
    }
    const input = { note: options.getString("note") || undefined };
    if (action === "reschedule")
      input.dueAt = parseVietnamTime(options.getString("deadline", true));
    if (action === "reassign") {
      await service.access(actor, service.pool, true);
      input.assigneeId = options.getUser("user", true).id;
      await validateTarget(interaction, input.assigneeId);
    }
    const job = await service.mutateJob(actor, id, action, input);
    return {
      privateReply: job.status === "assigned",
      content: "✅ Đã lưu thay đổi. ",
      embeds: [jobEmbed(job)],
    };
  }
  if (command === "absence") {
    if (action === "list")
      return absenceList(
        await service.listAbsences(actor, {
          userId: options.getUser("user")?.id,
          filter: options.getString("filter") || "active",
          page: options.getInteger("page") ?? 1,
        }),
      );
    const absence = await service.mutateAbsence(
      actor,
      options.getInteger("id", true),
      action,
      options.getString("note") || "",
    );
    return {
      content: "✅ Đã xử lý đơn. Deadline và KPI vẫn do lead quyết định riêng.",
      embeds: [absenceEmbed(absence, "🌴 Đơn báo bận")],
    };
  }
  throw new UserError("Lệnh chưa được hỗ trợ.");
}

async function component(interaction, actor, service) {
  const parts = interaction.customId.split(":");
  const [entity, action] =
    parts[0] === "assignment" ? ["job", parts[1]] : parts;
  const rawId = parts[0] === "assignment" ? parts[3] : parts[2];
  if (
    entity === "absence" &&
    action === "request" &&
    rawId === "new" &&
    interaction.isModalSubmit()
  ) {
    const input = {
      startsAt: parseVietnamTime(interaction.fields.getTextInputValue("start")),
      endsAt: parseVietnamTime(interaction.fields.getTextInputValue("end")),
      reason: interaction.fields.getTextInputValue("reason"),
    };
    const absence = await service.requestAbsence(actor, input);
    return {
      content: `✅ Đã lưu đơn #${absence.id}, chờ Lead xử lý.`,
      embeds: [absenceEmbed(absence, "🌴 Báo bận")],
    };
  }
  const id = positiveInteger(Number(rawId), "Mã job / đơn");
  const note = interaction.isModalSubmit()
    ? interaction.fields.getTextInputValue("note")
    : undefined;
  if (entity === "job") {
    ensure(
      [
        "accept",
        "decline",
        "update",
        "submit",
        "approve",
        "return",
        "cancel",
      ].includes(action),
      "Nút không hợp lệ.",
    );
    const input = { note };
    if (action === "cancel") {
      ensure(
        interaction.isButton(),
        "Hãy dùng /job cancel để mở xác nhận riêng.",
      );
      // Chấp nhận cả tiêu đề cũ để các tin xác nhận đã gửi vẫn hoạt động sau cập nhật giao diện.
      input.note = interaction.message.embeds.find((embed) =>
        ["📝 Lý do hủy", "Lý do hủy"].includes(embed.title),
      )?.description;
      ensure(input.note, "Không tìm thấy lý do hủy. Hãy mở lại /job cancel.");
    }
    if (action === "update") {
      const progress = interaction.fields.getTextInputValue("progress").trim();
      ensure(
        /^\d{1,3}$/.test(progress),
        "Tiến độ phải là số nguyên từ 0 đến 100.",
      );
      input.progress = Number(progress);
      const status = interaction.fields
        .getTextInputValue("status")
        .trim()
        .toLowerCase();
      ensure(
        ["doing", "blocked"].includes(status),
        "Nhập trạng thái doing hoặc blocked.",
      );
      input.status = status === "doing" ? "in_progress" : "blocked";
      const checkin = interaction.fields.getTextInputValue("checkin").trim();
      if (checkin) input.nextCheckinAt = parseVietnamTime(checkin);
    }
    const job = await service.mutateJob(actor, id, action, input);
    return { content: "✅ Đã lưu thay đổi.", embeds: [jobEmbed(job)] };
  }
  ensure(
    entity === "absence" && ["review", "approve", "reject"].includes(action),
    "Nút không hợp lệ.",
  );
  if (action === "review") {
    const { absence, impacted } = await service.reviewAbsence(actor, id);
    return {
      privateReply: true,
      embeds: [absenceEmbed(absence, "🌴 Đơn báo bận", impacted)],
      components: absenceButtons(absence),
    };
  }
  const absence = await service.mutateAbsence(actor, id, action, note || "");
  return {
    content: "✅ Đã xử lý đơn báo bận.",
    embeds: [absenceEmbed(absence, "🌴 Đơn báo bận")],
  };
}

export function interactionHandler({ service, guildId }) {
  return async (interaction) => {
    if (
      !interaction.isChatInputCommand() &&
      !interaction.isButton() &&
      !interaction.isModalSubmit() &&
      !interaction.isStringSelectMenu?.()
    )
      return;
    let stage = "receive";
    let command = interaction.commandName || "component";
    try {
      let actor;
      const dmAssignment = !interaction.inGuild()
        ? assignmentRoute(interaction.customId, guildId)
        : null;
      if (!dmAssignment) actor = actorFrom(interaction, guildId);
      ensure(
        !interaction.customId?.startsWith("absencepick:"),
        "Lịch chọn cũ đã được thay bằng form. Hãy chạy lại /absence request.",
      );
      ensure(!interaction.isStringSelectMenu?.(), "Lựa chọn không hợp lệ.");
      // Modal phải mở ngay, không deferReply trước showModal.
      if (interaction.isChatInputCommand()) {
        const action = interaction.options.getSubcommand(false);
        command = `/${interaction.commandName}${action ? ` ${action}` : ""}`;
        if (interaction.commandName === "absence" && action === "request") {
          await interaction.showModal(absenceModal());
          return;
        }
        if (
          interaction.commandName === "job" &&
          ["update", "submit"].includes(action)
        ) {
          await interaction.showModal(
            actionModal(
              "job",
              action,
              interaction.options.getInteger("id", true),
            ),
          );
          return;
        }
      }
      if (interaction.isButton()) {
        if (dmAssignment) {
          if (dmAssignment.action === "decline") {
            await interaction.showModal(
              actionModal("job", "decline", dmAssignment.id).setCustomId(
                interaction.customId,
              ),
            );
            return;
          }
        } else {
          const match =
            /^(job|absence):(accept|decline|update|submit|approve|return|reject|cancel|review):(\d+)$/.exec(
              interaction.customId,
            );
          ensure(match, "Nút không hợp lệ.");
          if (
            ["decline", "update", "submit", "return", "reject"].includes(
              match[2],
            )
          ) {
            await interaction.showModal(
              actionModal(match[1], match[2], match[3]),
            );
            return;
          }
        }
      }
      const adminCommand =
        interaction.isChatInputCommand() &&
        ["setup", "settings"].includes(interaction.commandName);
      // These commands always return private results. List/view defer publicly;
      // assigned-job details are sent in a separate ephemeral follow-up below.
      const protectedJobCommand =
        interaction.isChatInputCommand() &&
        interaction.commandName === "job" &&
        ["create", "cancel", "reassign"].includes(
          interaction.options.getSubcommand(false),
        );
      // Nút Mở đơn của phiên bản cũ vẫn mở riêng; luồng báo bận hiện tại trả lời công khai.
      const privateAbsence =
        !interaction.isChatInputCommand() &&
        /^absence:review:/.test(interaction.customId);
      stage = "defer";
      await interaction.deferReply(
        adminCommand || protectedJobCommand || dmAssignment || privateAbsence
          ? { flags: MessageFlags.Ephemeral }
          : {},
      );
      if (dmAssignment)
        actor = await assignmentActor(interaction, service, guildId);
      stage = "handle";
      const response = interaction.isChatInputCommand()
        ? await slash(interaction, actor, service)
        : await component(interaction, actor, service);
      const { privateReply = false, ...body } = response;
      const reply = { ...body, allowedMentions: { parse: [] } };
      if (privateReply && !interaction.ephemeral) {
        // Never put assigned-job details into the public command response.
        // Complete the public acknowledgement before sending a private follow-up.
        stage = "reply";
        await interaction.editReply({
          content: "📩 Kết quả được gửi riêng cho bạn vì có thông tin job đang chờ nhận.",
          embeds: [],
          components: [],
          allowedMentions: { parse: [] },
        });
        stage = "private-reply";
        await interaction.followUp({
          ...reply,
          flags: MessageFlags.Ephemeral,
        });
      } else {
        stage = "reply";
        await interaction.editReply(reply);
      }
    } catch (error) {
      const permissionError = [50001, 50013].includes(Number(error.code));
      const content =
        error instanceof UserError
          ? error.message
          : permissionError
            ? `Bot ${Number(error.code) === 50001 ? "không truy cập được channel này" : "thiếu quyền thực hiện thao tác trong channel này"} (mã ${error.code}). Nhờ quản trị viên cấp View Channel, Send Messages và Embed Links cho chính bot tại channel gọi lệnh và channel báo cáo. Nếu vừa thay đổi job, hãy kiểm tra trạng thái trước khi thử lại.`
          : "Có lỗi khi xử lý. Kiểm tra trạng thái bằng lệnh xem danh sách trước khi thử lại; quản trị viên có thể xem log.";
      if (!(error instanceof UserError))
        console.error(
          `Lỗi interaction (${error.code || error.name}). command=${command} guild=${interaction.guildId || guildId} channel=${interaction.channelId || "DM"} stage=${stage}`,
        );
      try {
        const response = {
          content: `${error instanceof UserError ? "⚠️" : "❌"} ${safe(content, 1900)}`,
          embeds: [],
          components: [],
          allowedMentions: { parse: [] },
        };
        if (interaction.deferred || interaction.replied) {
          if (interaction.ephemeral) await interaction.editReply(response);
          else {
            // Discord không cho đổi một reply đã defer công khai thành ephemeral.
            // Hoàn tất defer trước để followUp không bị Discord xử lý như editReply.
            if (!interaction.replied)
              await interaction.editReply({
                content: "❌ Không thể thực hiện yêu cầu.",
                embeds: [],
                components: [],
                allowedMentions: { parse: [] },
              });
            // Giữ phản hồi chung để còn biết ai đã gọi lệnh, chi tiết lỗi vẫn gửi riêng.
            await interaction.followUp({
              ...response,
              flags: MessageFlags.Ephemeral,
            });
          }
        } else
          await interaction.reply({
            ...response,
            flags: MessageFlags.Ephemeral,
          });
      } catch {
        console.error("Không thể trả lời interaction (có thể đã hết hạn).");
      }
    }
  };
}
