import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  escapeMarkdown,
} from "discord.js";
import { STATUS_LABELS } from "./domain.js";

export const ACTION_LABELS = {
  create: "📨 Giao việc mới",
  accept: "🤝 Đã nhận việc",
  decline: "❌ Từ chối nhận việc",
  update: "📝 Cập nhật tiến độ",
  submit: "📤 Gửi kết quả",
  approve: "✅ Đã duyệt",
  return: "🔧 Yêu cầu sửa",
  cancel: "🚫 Đã hủy",
  reschedule: "🗓️ Thay đổi deadline",
  reassign: "🔄 Chuyển người phụ trách",
  request: "🌴 Báo bận mới",
  reject: "❌ Không duyệt",
};
export const REMINDER_LABELS = {
  acceptance: "📨 Job chờ xác nhận nhận việc hơn 24 giờ",
  due_soon: "⏰ Sắp đến hạn trong 24 giờ",
  overdue: "🚨 Công việc đã quá hạn",
  checkin: "📝 Đến mốc cập nhật tiến độ",
  review: "🔎 Kết quả chờ lead duyệt hơn 24 giờ",
  absence_pending: "⏳ Đơn báo bận chờ xử lý hơn 24 giờ",
};
export const safe = (value, max = 1000) =>
  escapeMarkdown(String(value ?? "")).slice(0, max) || "—";
export const when = (value) =>
  value ? `<t:${Math.floor(new Date(value).getTime() / 1000)}:f>` : "—";

function row(buttons) {
  return new ActionRowBuilder().addComponents(
    buttons.map(([customId, label, style, emoji]) => {
      const button = new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(label)
        .setStyle(style);
      if (emoji) button.setEmoji(emoji);
      return button;
    }),
  );
}

export function jobButtons(
  job,
  { assignmentDm = false, canRespond = true } = {},
) {
  const key = (action) =>
    assignmentDm
      ? `assignment:${action}:${job.guild_id}:${job.id}`
      : `job:${action}:${job.id}`;
  if (job.status === "assigned" && !canRespond) return [];
  if (job.status === "assigned")
    return [
      row([
        [key("accept"), "Nhận việc", ButtonStyle.Success, "🤝"],
        [key("decline"), "Từ chối", ButtonStyle.Danger, "❌"],
      ]),
    ];
  if (["in_progress", "blocked"].includes(job.status))
    return [
      row([
        [key("update"), "Cập nhật", ButtonStyle.Primary, "📝"],
        [key("submit"), "Gửi kết quả", ButtonStyle.Success, "📤"],
      ]),
    ];
  if (job.status === "submitted")
    return [
      row([
        [key("approve"), "Duyệt hoàn thành", ButtonStyle.Success, "✅"],
        [key("return"), "Yêu cầu sửa", ButtonStyle.Danger, "🔧"],
      ]),
    ];
  return [];
}

export function jobEmbed(job, title = "📋 Chi tiết công việc", note = "") {
  const embed = new EmbedBuilder()
    .setColor(job.status === "completed" ? 0x2ecc71 : 0x5865f2)
    .setTitle(`${title} · #${job.id}`)
    .setDescription(
      `**${safe(job.title, 300)}**\n${safe(job.description, 1500)}`,
    )
    .addFields(
      { name: "👤 Người nhận", value: `<@${job.assignee_id}>`, inline: true },
      {
        name: "📌 Trạng thái",
        value: `${STATUS_LABELS[job.status]} · ${job.progress}%`,
        inline: true,
      },
      { name: "⭐ Điểm", value: String(job.points), inline: true },
      { name: "⏰ Deadline", value: when(job.due_at), inline: true },
      {
        name: "🗓️ Mốc cập nhật",
        value: when(job.next_checkin_at),
        inline: true,
      },
    );
  if (note)
    embed.addFields({ name: "📝 Nội dung / lý do", value: safe(note, 1000) });
  return embed;
}

export function jobDetail({ job, updates }, { canRespond = true } = {}) {
  const embed = jobEmbed(job);
  if (updates.length)
    embed.addFields({
      name: "🕒 5 thay đổi gần nhất",
      value: updates
        .map(
          (update) =>
            `${when(update.created_at)} · <@${update.actor_id}> · ${ACTION_LABELS[update.action] || update.action}\n${safe(update.note, 140)}`,
        )
        .join("\n")
        .slice(0, 1000),
    });
  return { embeds: [embed], components: jobButtons(job, { canRespond }) };
}

// Chỉ gửi view này bằng ephemeral sau khi service xác thực quyền Lead.
export function cancellationConfirmation(job, note) {
  return {
    privateReply: true,
    content:
      "⚠️ Job chưa bị hủy. Nhấn xác nhận bên dưới, hoặc bỏ qua để giữ nguyên job.",
    embeds: [
      jobEmbed(job, "🚫 Xác nhận hủy job"),
      new EmbedBuilder().setTitle("📝 Lý do hủy").setDescription(note),
    ],
    components: [
      row([
        [`job:cancel:${job.id}`, "Xác nhận hủy job", ButtonStyle.Danger, "🚫"],
      ]),
    ],
  };
}

export function jobList({ jobs, hasMore, page }) {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📋 Danh sách job · Trang ${page}`)
    .setDescription(
      jobs.length
        ? "🔎 Dùng /job view id để xem chi tiết."
        : "📭 Không có job phù hợp.",
    );
  for (const job of jobs)
    embed.addFields({
      name: `#${job.id} · ${safe(job.title, 160)}`,
      value: `${STATUS_LABELS[job.status]} · ${job.progress}% · Deadline ${when(job.due_at)}`,
    });
  if (hasMore)
    embed.setFooter({
      text: `➡️ Còn dữ liệu. Dùng page:${page + 1} để xem tiếp.`,
    });
  return { embeds: [embed] };
}

export function absenceSummaryEmbed(absence, title) {
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`${title} · Đơn #${absence.id}`)
    .setDescription(
      `👤 Thành viên: <@${absence.user_id}>\n📌 Trạng thái: **${STATUS_LABELS[absence.status]}**`,
    )
    .addFields(
      { name: "🗓️ Bắt đầu", value: when(absence.starts_at), inline: true },
      { name: "🏁 Kết thúc", value: when(absence.ends_at), inline: true },
    );
  return embed;
}

// Nội dung đơn và phản hồi được hiển thị công khai theo luồng báo bận hiện tại.
export function absenceEmbed(absence, title, impacted = []) {
  const embed = absenceSummaryEmbed(absence, title).addFields({
    name: "📝 Lý do",
    value: safe(absence.reason, 1000),
  });
  if (absence.review_note)
    embed.addFields({
      name: "💬 Phản hồi",
      value: safe(absence.review_note, 700),
    });
  if (impacted.length)
    embed.addFields({
      name: "⚠️ Job đang mở cần xem xét (tối đa 10)",
      value: impacted
        .map(
          (job) => `#${job.id} · ${safe(job.title, 50)} · ${when(job.due_at)}`,
        )
        .join("\n")
        .slice(0, 1000),
    });
  return embed;
}

export function absenceButtons(absence) {
  if (absence.status !== "pending") return [];
  return [
    row([
      [
        `absence:approve:${absence.id}`,
        "Duyệt báo bận",
        ButtonStyle.Success,
        "✅",
      ],
      [`absence:reject:${absence.id}`, "Không duyệt", ButtonStyle.Danger, "❌"],
    ]),
  ];
}

export function absenceList({ absences, hasMore, page }) {
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(`🌴 Đơn báo bận · Trang ${page}`);
  if (!absences.length) embed.setDescription("📭 Không có đơn.");
  for (const absence of absences)
    embed.addFields({
      name: `#${absence.id} · ${STATUS_LABELS[absence.status]}`,
      value: `<@${absence.user_id}> · ${when(absence.starts_at)} → ${when(absence.ends_at)}\n📝 ${safe(absence.reason, 180)}${absence.review_note ? `\n💬 Phản hồi: ${safe(absence.review_note, 120)}` : ""}`,
    });
  if (hasMore)
    embed.setFooter({ text: `➡️ Dùng page:${page + 1} để xem tiếp.` });
  return { embeds: [embed] };
}

export function reportView({
  totals,
  absenceTotals,
  members,
  days,
  page,
  hasMore,
}) {
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`📊 Báo cáo server · Trang ${page}`)
    .setDescription(
      `💼 Hiện tại: **${totals.active}** job đang làm · **${totals.awaiting_review}** chờ duyệt\n` +
        `🚨 **${totals.overdue}** quá hạn · **${totals.stale}** đến mốc cập nhật\n` +
        `🌴 Báo bận: **${absenceTotals.pending}** chờ duyệt · **${absenceTotals.away}** đơn đang nghỉ đã duyệt\n\n` +
        `Kết quả ${days} ngày gần nhất; “đúng hạn” dựa trên lần nộp được duyệt.`,
    );
  for (const member of members)
    embed.addFields({
      name: `👤 Thành viên ${member.assignee_id}`,
      value:
        `<@${member.assignee_id}> · ${member.completed} hoàn thành · ${member.on_time} đúng hạn · ${member.earned_points} điểm\n` +
        `Đang làm: ${member.active} · Chờ duyệt: ${member.awaiting_review}`,
    });
  if (hasMore)
    embed.setFooter({ text: `➡️ Dùng page:${page + 1} để xem tiếp.` });
  return { embeds: [embed] };
}

export function kpiView(data) {
  const earned = Number(data.earned_points);
  const percentage = data.target
    ? `${Math.round((earned / data.target) * 100)}%`
    : "Chưa đặt chỉ tiêu";
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle(`🎯 KPI tháng ${data.month}`)
        .setDescription(
          `👤 <@${data.userId}>\n⭐ Điểm: **${earned} / ${data.target ?? "—"}** · ${percentage}\n` +
            `✅ Hoàn thành: **${data.completed}** job · Đúng hạn: **${data.on_time}**\n` +
            "Điểm được ghi nhận vào tháng lead duyệt hoàn thành, theo giờ Việt Nam.",
        ),
    ],
  };
}

export function notificationView(payload, destination) {
  const dm = destination === "dm";
  let embed;
  let components = [];
  let content;
  let users = [];
  let roles = [];
  if (payload.kind === "job" || payload.kind === "job_reminder") {
    const reminder = payload.kind === "job_reminder";
    embed = jobEmbed(
      payload.job,
      reminder
        ? REMINDER_LABELS[payload.reminder]
        : ACTION_LABELS[payload.action],
      payload.note,
    );
    if (!dm && payload.job.status !== "assigned")
      components = jobButtons(payload.job);
    if (dm && payload.job.status === "assigned")
      components = jobButtons(payload.job, { assignmentDm: true });
    if (!dm && (payload.action === "create" || reminder)) {
      users = [payload.job.assignee_id];
      content = `<@${payload.job.assignee_id}>`;
    }
    if (!dm && (payload.action === "submit" || payload.reminder === "review")) {
      roles = [payload.leadRoleId];
      content = `${content || ""} <@&${payload.leadRoleId}>`.trim();
    }
  } else if (
    payload.kind === "absence" ||
    payload.kind === "absence_reminder"
  ) {
    const title =
      payload.kind === "absence_reminder"
        ? REMINDER_LABELS.absence_pending
        : ACTION_LABELS[payload.action];
    if (dm) embed = absenceEmbed(payload.absence, title);
    else if (payload.absence.status === "pending") {
      // Tin và nút hiển thị trong channel; service kiểm tra quyền của người bấm.
      embed = absenceEmbed(payload.absence, title, payload.impacted || []);
      components = absenceButtons(payload.absence);
      roles = [payload.leadRoleId];
      content = `<@&${payload.leadRoleId}>`;
    } else {
      embed = absenceEmbed(payload.absence, title, payload.impacted || []);
    }
  } else {
    embed = new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle(safe(payload.title, 200))
      .setDescription(safe(payload.description, 2000));
  }
  if (dm)
    embed.setFooter({
      text:
        payload.job?.status === "assigned"
          ? "📩 Chỉ bạn nhận được lời mời này. Chọn Nhận việc / Từ chối, hoặc dùng /job view trong server."
          : "📩 Dùng các lệnh của bot trong server để phản hồi. Không trả lời DM này.",
    });
  return {
    ...(content ? { content } : {}),
    embeds: [embed],
    components,
    allowedMentions: { parse: [], users, roles, repliedUser: false },
  };
}