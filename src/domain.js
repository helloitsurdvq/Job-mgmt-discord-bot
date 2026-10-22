export class UserError extends Error {}

export const ACTIVE_STATUSES = ["assigned", "in_progress", "blocked"];
export const STATUS_LABELS = {
  assigned: "📨 Chờ nhận",
  in_progress: "🛠️ Đang làm",
  blocked: "🚧 Đang vướng",
  submitted: "🔎 Chờ duyệt",
  completed: "✅ Hoàn thành",
  declined: "❌ Đã từ chối",
  cancelled: "🚫 Đã hủy",
  pending: "⏳ Chờ duyệt",
  approved: "✅ Đã duyệt",
  rejected: "❌ Không duyệt",
};

export function ensure(condition, message) {
  if (!condition) throw new UserError(message);
}

export function text(value, label, max, min = 1) {
  const result = typeof value === "string" ? value.trim() : "";
  ensure(
    result.length >= min && result.length <= max,
    `${label} phải có ${min}–${max} ký tự.`,
  );
  return result;
}

export function positiveInteger(value, label, max = 4294967295) {
  ensure(
    Number.isInteger(value) && value > 0 && value <= max,
    `${label} không hợp lệ.`,
  );
  return value;
}

export function discordId(value) {
  ensure(
    typeof value === "string" && /^\d{17,20}$/.test(value),
    "Discord ID không hợp lệ.",
  );
  return value;
}

// Cố định giờ Việt Nam (UTC+7), không phụ thuộc múi giờ máy chạy bot.
export function parseVietnamTime(input) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(input || "");
  ensure(match, "Nhập ngày giờ theo dạng YYYY-MM-DD HH:mm (giờ Việt Nam).");
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  ensure(
      year >= 2000 &&
      year <= 2100 &&
      month >= 1 &&
      month <= 12 &&
      hour >= 0 &&
      hour <= 23 &&
      minute >= 0 &&
      minute <= 59,
    "Ngày giờ không hợp lệ.",
  );
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute));
  ensure(
      local.getUTCFullYear() === year &&
      local.getUTCMonth() === month - 1 &&
      local.getUTCDate() === day,
    "Ngày không tồn tại trong lịch.",
  );
  return new Date(local.getTime() - 7 * 3600_000);
}

export function future(date, now, label = "Thời hạn") {
  ensure(
    date instanceof Date && Number.isFinite(date.getTime()) && date > now,
    `${label} phải ở tương lai.`,
  );
  return date;
}

export function defaultCheckin(now, dueAt) {
  return new Date(
    Math.min(
      now.getTime() + 7 * 86400_000,
      dueAt > now ? dueAt.getTime() : now.getTime() + 86400_000,
    ),
  );
}

export function isLead(actor, settings) {
  return actor.isAdmin || actor.roleIds.includes(settings.lead_role_id);
}

export function authorizeJobAction(job, actor, settings, action) {
  const leadActions = ["approve", "return", "cancel", "reschedule", "reassign"];
  ensure(
    leadActions.includes(action)
      ? isLead(actor, settings)
      : job.assignee_id === actor.userId,
    leadActions.includes(action)
      ? "Chỉ lead hoặc quản trị viên được thực hiện."
      : "Chỉ người được giao job được thực hiện.",
  );
  const states = {
    accept: ["assigned"],
    decline: ["assigned"],
    update: ["in_progress", "blocked"],
    submit: ["in_progress", "blocked"],
    approve: ["submitted"],
    return: ["submitted"],
    cancel: ["assigned", "in_progress", "blocked", "submitted", "declined"],
    reschedule: ["assigned", "in_progress", "blocked", "declined"],
    reassign: ["assigned", "in_progress", "blocked", "declined"],
  };
  ensure(
    states[action]?.includes(job.status),
    `Không thể thực hiện khi job đang ở trạng thái “${STATUS_LABELS[job.status]}”.`,
  );
  // if (action === 'approve') ensure(job.assignee_id !== actor.userId, 'Cần một lead khác duyệt kết quả của bạn.');
}

export function utcDay(now) {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

export function monthRange(month) {
  ensure(
    /^20\d{2}-(0[1-9]|1[0-2])$/.test(month || ""),
    "Tháng phải theo dạng YYYY-MM, ví dụ 2026-10.",
  );
  const start = parseVietnamTime(`${month}-01 00:00`);
  const [year, number] = month.split("-").map(Number);
  const nextMonth = new Date(Date.UTC(year, number, 1));
  return { start, end: new Date(nextMonth.getTime() - 7 * 3600_000) };
}

// Chỉ quyết định lịch nhắc. Việc lưu/gửi nằm ở worker và database.
export function jobReminders(job, now) {
  const result = [];
  if (ACTIVE_STATUSES.includes(job.status)) {
    if (job.status === "assigned" && now - job.updated_at >= 86400_000)
      result.push("acceptance");
    if (job.due_at <= now) result.push("overdue");
    else if (job.due_at - now <= 86400_000) result.push("due_soon");
    if (job.next_checkin_at <= now) result.push("checkin");
  } else if (
    job.status === "submitted" &&
    now - job.submitted_at >= 86400_000
  ) {
    result.push("review");
  }
  return result;
}