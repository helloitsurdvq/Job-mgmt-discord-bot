import { transaction } from "./database.js";
import { enqueue } from "./outbox.js";
import {
  ensure,
  text,
  positiveInteger,
  discordId,
  future,
  defaultCheckin,
  isLead,
  authorizeJobAction,
  monthRange,
  authorizeBotConfiguration,
} from "./domain.js";

// Service chứa quy tắc nghiệp vụ. Không import Discord cho dễ đọc và kiểm thử độc lập.
export class JobService {
  constructor(pool, clock = () => new Date()) {
    this.pool = pool;
    this.clock = clock;
  }

  async settings(guildId, connection = this.pool) {
    const [[settings]] = await connection.execute(
      "SELECT * FROM guild_settings WHERE guild_id = ?",
      [guildId],
    );
    ensure(
      settings,
      "Server chưa được cấu hình. Người có quyền cấu hình bot hãy chạy /setup.",
    );
    const [channels] = await connection.execute(
      "SELECT channel_id FROM command_channels WHERE guild_id = ?",
      [guildId],
    );
    return { ...settings, channels: channels.map((row) => row.channel_id) };
  }

  async access(actor, connection = this.pool, leadOnly = false) {
    const settings = await this.settings(actor.guildId, connection);
    ensure(
      settings.channels.includes(actor.channelId) ||
        settings.report_channel_id === actor.channelId,
      "Channel này chưa được phép sử dụng bot.",
    );
    if (leadOnly)
      ensure(
        isLead(actor, settings),
        "Chỉ lead hoặc quản trị viên được thực hiện.",
      );
    return settings;
  }

  async audit(connection, actor, entityType, entityId, action, details = {}) {
    await connection.execute(
      `INSERT INTO audit_logs
      (guild_id, actor_id, entity_type, entity_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        actor.guildId,
        actor.userId,
        entityType,
        String(entityId),
        action,
        JSON.stringify(details),
        this.clock(),
      ],
    );
  }

  async configure(actor, { leadRoleId, reportChannelId, commandChannelId }) {
    authorizeBotConfiguration(actor);
    [leadRoleId, reportChannelId, commandChannelId].forEach(discordId);
    return transaction(this.pool, async (connection) => {
      const now = this.clock();
      await connection.execute(
        `INSERT INTO guild_settings
        (guild_id, lead_role_id, report_channel_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE lead_role_id = VALUES(lead_role_id),
        report_channel_id = VALUES(report_channel_id), updated_at = VALUES(updated_at)`,
        [actor.guildId, leadRoleId, reportChannelId, now, now],
      );
      await connection.execute(
        `INSERT INTO command_channels (guild_id, channel_id) VALUES (?, ?)
        ON DUPLICATE KEY UPDATE channel_id = channel_id`,
        [actor.guildId, commandChannelId],
      );
      await this.audit(
        connection,
        actor,
        "settings",
        actor.guildId,
        "configure",
        { leadRoleId, reportChannelId, commandChannelId },
      );
    });
  }

  async changeChannel(actor, channelId, add) {
    authorizeBotConfiguration(actor);
    discordId(channelId);
    return transaction(this.pool, async (connection) => {
      await this.settings(actor.guildId, connection);
      if (add) {
        await connection.execute(
          `INSERT INTO command_channels (guild_id, channel_id) VALUES (?, ?)
          ON DUPLICATE KEY UPDATE channel_id = channel_id`,
          [actor.guildId, channelId],
        );
      } else {
        await connection.execute(
          "DELETE FROM command_channels WHERE guild_id = ? AND channel_id = ?",
          [actor.guildId, channelId],
        );
      }
      await this.audit(
        connection,
        actor,
        "settings",
        actor.guildId,
        add ? "channel_add" : "channel_remove",
        { channelId },
      );
    });
  }

  async jobEvent(connection, actor, settings, job, action, note = "") {
    const payload = {
      kind: "job",
      job,
      action,
      note,
      actorId: actor.userId,
      leadRoleId: settings.lead_role_id,
    };
    // Chưa nhận việc: chỉ gửi lời mời riêng, không đăng chi tiết vào channel quản lý.
    if (job.status !== "assigned") {
      await enqueue(
        connection,
        actor.guildId,
        "channel",
        settings.report_channel_id,
        payload,
        undefined,
        this.clock(),
      );
    }
    if (job.assignee_id !== actor.userId || job.status === "assigned") {
      await enqueue(
        connection,
        actor.guildId,
        "dm",
        job.assignee_id,
        payload,
        undefined,
        this.clock(),
      );
    }
    await connection.execute(
      `INSERT INTO job_updates (job_id, actor_id, action, note, progress, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
      [job.id, actor.userId, action, note, job.progress, this.clock()],
    );
    await this.audit(connection, actor, "job", job.id, action, {
      status: job.status,
      note,
      assigneeId: job.assignee_id,
      dueAt: job.due_at,
    });
  }

  async createJob(actor, input) {
    const title = text(input.title, "Tên job", 150);
    const description = text(
      input.description || "Chưa có mô tả.",
      "Mô tả",
      1500,
    );
    const assigneeId = discordId(input.assigneeId);
    const points = positiveInteger(input.points ?? 1, "Điểm công việc", 1000);
    const now = this.clock();
    const dueAt = future(input.dueAt, now, "Deadline");
    const nextCheckin = input.nextCheckinAt
      ? future(input.nextCheckinAt, now, "Mốc cập nhật")
      : defaultCheckin(now, dueAt);
    ensure(nextCheckin <= dueAt, "Mốc cập nhật không được sau deadline.");
    return transaction(this.pool, async (connection) => {
      const settings = await this.access(actor, connection, true);
      const [result] = await connection.execute(
        `INSERT INTO jobs
        (guild_id, creator_id, assignee_id, title, description, points, due_at, next_checkin_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          actor.guildId,
          actor.userId,
          assigneeId,
          title,
          description,
          points,
          dueAt,
          nextCheckin,
          now,
          now,
        ],
      );
      const [[job]] = await connection.execute(
        "SELECT * FROM jobs WHERE id = ?",
        [result.insertId],
      );
      const [absences] = await connection.execute(
        `SELECT id, starts_at, ends_at, status FROM absences
        WHERE guild_id = ? AND user_id = ? AND status IN ('pending','approved') AND ends_at > ? AND starts_at <= ?
        ORDER BY starts_at LIMIT 5`,
        [actor.guildId, assigneeId, now, dueAt],
      );
      const note = absences.length
        ? `Lưu ý: người nhận có đơn báo bận liên quan: ${absences.map((row) => `#${row.id}`).join(", ")}.`
        : "";
      await this.jobEvent(connection, actor, settings, job, "create", note);
      return { job, warning: note };
    });
  }

  async mutateJob(actor, id, action, input = {}) {
    positiveInteger(id, "Mã job");
    return transaction(this.pool, async (connection) => {
      const settings = await this.access(actor, connection);
      // Khóa dòng để hai lượt bấm nút không cùng duyệt hoặc sửa đè nhau.
      const [[job]] = await connection.execute(
        "SELECT * FROM jobs WHERE id = ? AND guild_id = ? FOR UPDATE",
        [id, actor.guildId],
      );
      ensure(job, "Không tìm thấy job trong server này.");
      authorizeJobAction(job, actor, settings, action);
      const now = this.clock();
      const requireNote = [
        "decline",
        "update",
        "submit",
        "return",
        "cancel",
        "reschedule",
        "reassign",
      ].includes(action);
      const note = requireNote
        ? text(input.note, "Nội dung / lý do", 1500)
        : text(input.note || "Xác nhận bằng /cmd.", "Ghi chú", 1500);
      const oldAssignee = job.assignee_id;
      switch (action) {
        case "accept":
          job.status = "in_progress";
          job.next_checkin_at = defaultCheckin(now, job.due_at);
          break;
        case "decline":
          job.status = "declined";
          break;
        case "update":
          ensure(
            Number.isInteger(input.progress) &&
              input.progress >= 0 &&
              input.progress <= 100,
            "Tiến độ phải từ 0 đến 100.",
          );
          ensure(
            ["in_progress", "blocked"].includes(input.status),
            "Trạng thái cập nhật không hợp lệ.",
          );
          job.progress = input.progress;
          job.status = input.status;
          job.next_checkin_at = input.nextCheckinAt
            ? future(input.nextCheckinAt, now, "Mốc cập nhật")
            : defaultCheckin(now, job.due_at);
          ensure(
            job.due_at <= now || job.next_checkin_at <= job.due_at,
            "Mốc cập nhật không được sau deadline.",
          );
          break;
        case "submit":
          job.status = "submitted";
          job.submitted_at = now;
          job.progress = 100;
          break;
        case "approve":
          job.status = "completed";
          job.completed_at = now;
          break;
        case "return":
          job.status = "in_progress";
          job.submitted_at = null;
          job.progress = Math.min(job.progress, 99);
          job.next_checkin_at = defaultCheckin(now, job.due_at);
          break;
        case "cancel":
          job.status = "cancelled";
          break;
        case "reschedule":
          job.due_at = future(input.dueAt, now, "Deadline mới");
          job.next_checkin_at = defaultCheckin(now, job.due_at);
          break;
        case "reassign":
          job.assignee_id = discordId(input.assigneeId);
          ensure(oldAssignee !== job.assignee_id, "Hãy chọn người nhận khác.");
          ensure(
            job.due_at > now,
            "Hãy gia hạn job trước khi chuyển một job đã quá hạn.",
          );
          job.status = "assigned";
          job.progress = 0;
          job.submitted_at = null;
          job.next_checkin_at = defaultCheckin(now, job.due_at);
          break;
      }
      job.updated_at = now;
      await connection.execute(
        `UPDATE jobs SET status = ?, assignee_id = ?, progress = ?, due_at = ?, next_checkin_at = ?,
        submitted_at = ?, completed_at = ?, updated_at = ? WHERE id = ? AND guild_id = ?`,
        [
          job.status,
          job.assignee_id,
          job.progress,
          job.due_at,
          job.next_checkin_at,
          job.submitted_at,
          job.completed_at,
          now,
          id,
          actor.guildId,
        ],
      );
      await this.jobEvent(connection, actor, settings, job, action, note);
      if (action === "reassign") {
        await enqueue(
          connection,
          actor.guildId,
          "dm",
          oldAssignee,
          {
            kind: "notice",
            title: `🔄 Job #${id} đã được chuyển người phụ trách`,
            description: note,
          },
          undefined,
          this.clock(),
        );
      }
      return job;
    });
  }

  async viewJob(actor, id) {
    positiveInteger(id, "Mã job");
    const settings = await this.access(actor);
    const [[job]] = await this.pool.execute(
      "SELECT * FROM jobs WHERE id = ? AND guild_id = ?",
      [id, actor.guildId],
    );
    ensure(job, "Không tìm thấy job trong server này.");
    ensure(
      isLead(actor, settings) || job.assignee_id === actor.userId,
      "Bạn chỉ được xem job của mình.",
    );
    const [updates] = await this.pool.execute(
      "SELECT * FROM job_updates WHERE job_id = ? ORDER BY id DESC LIMIT 5",
      [id],
    );
    return { job, updates };
  }

  async previewCancellation(actor, id, note) {
    const settings = await this.access(actor, this.pool, true);
    const { job } = await this.viewJob(actor, id);
    authorizeJobAction(job, actor, settings, "cancel");
    return { job, note: text(note, "Lý do hủy", 1500) };
  }

  async listJobs(actor, { userId, filter = "active", page = 1 } = {}) {
    const settings = await this.access(actor);
    positiveInteger(page, "Trang", 10000);
    ensure(
      ["active", "completed", "all", "overdue", "submitted"].includes(filter),
      "Bộ lọc không hợp lệ.",
    );
    if (userId && userId !== actor.userId)
      ensure(isLead(actor, settings), "Chỉ lead được xem job của người khác.");
    // Mặc định ai cũng xem job của chính mình. Lead chọn người khác qua tùy chọn user.
    const target = userId || actor.userId;
    const filters = {
      active: "AND status IN ('assigned','in_progress','blocked','submitted')",
      completed: "AND status = 'completed'",
      all: "",
      overdue:
        "AND status IN ('assigned','in_progress','blocked') AND due_at < ?",
      submitted: "AND status = 'submitted'",
    };
    const params = [
      actor.guildId,
      target,
      ...(filter === "overdue" ? [this.clock()] : []),
    ];
    const [rows] = await this.pool.execute(
      `SELECT * FROM jobs WHERE guild_id = ? AND assignee_id = ?
      ${filters[filter]} ORDER BY due_at, id LIMIT 11 OFFSET ${(page - 1) * 10}`,
      params,
    );
    return { jobs: rows.slice(0, 10), hasMore: rows.length > 10, page };
  }

  async requestAbsence(actor, input) {
    const now = this.clock();
    const reason = text(input.reason, "Lý do báo bận", 1500);
    future(input.startsAt, now, "Thời gian bắt đầu");
    const endsAt = future(input.endsAt, now, "Thời gian kết thúc");
    ensure(endsAt > input.startsAt, "Kết thúc phải sau thời gian bắt đầu.");
    return transaction(this.pool, async (connection) => {
      const settings = await this.access(actor, connection);
      // Thời gian có thể trôi qua trong lúc chờ DB: kiểm tra lại trước khi lưu.
      future(input.startsAt, this.clock(), "Thời gian bắt đầu");
      future(endsAt, this.clock(), "Thời gian kết thúc");
      const [result] = await connection.execute(
        `INSERT INTO absences
        (guild_id, user_id, starts_at, ends_at, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [actor.guildId, actor.userId, input.startsAt, endsAt, reason, now, now],
      );
      const [[absence]] = await connection.execute(
        "SELECT * FROM absences WHERE id = ?",
        [result.insertId],
      );
      await this.absenceEvent(connection, actor, settings, absence, "request");
      return absence;
    });
  }

  async absenceEvent(connection, actor, settings, absence, action) {
    const [impacted] = await connection.execute(
      `SELECT id, title, due_at, status FROM jobs
      WHERE guild_id = ? AND assignee_id = ? AND status IN ('in_progress','blocked','submitted')
      ORDER BY due_at LIMIT 10`,
      [actor.guildId, absence.user_id],
    );
    const payload = {
      kind: "absence",
      absence,
      action,
      impacted,
      actorId: actor.userId,
      leadRoleId: settings.lead_role_id,
    };
    // Gửi đơn và kết quả vào channel đã cấu hình; chỉ Lead/admin được duyệt ở service.
    await enqueue(
      connection,
      actor.guildId,
      "channel",
      settings.report_channel_id,
      payload,
      undefined,
      this.clock(),
    );
    if (actor.userId !== absence.user_id)
      await enqueue(
        connection,
        actor.guildId,
        "dm",
        absence.user_id,
        payload,
        undefined,
        this.clock(),
      );
    await this.audit(connection, actor, "absence", absence.id, action, {
      status: absence.status,
      reviewNote: absence.review_note,
    });
  }

  async reviewAbsence(actor, id) {
    positiveInteger(id, "Mã đơn");
    await this.access(actor, this.pool, true);
    const [[absence]] = await this.pool.execute(
      "SELECT * FROM absences WHERE id = ? AND guild_id = ?",
      [id, actor.guildId],
    );
    ensure(absence, "Không tìm thấy đơn trong server này.");
    const [impacted] = await this.pool.execute(
      `SELECT id, title, due_at, status FROM jobs
      WHERE guild_id = ? AND assignee_id = ? AND status IN ('in_progress','blocked','submitted')
      ORDER BY due_at LIMIT 10`,
      [actor.guildId, absence.user_id],
    );
    return { absence, impacted };
  }

  async mutateAbsence(actor, id, action, note = "") {
    positiveInteger(id, "Mã đơn");
    ensure(
      ["approve", "reject", "cancel"].includes(action),
      "Hành động không hợp lệ.",
    );
    return transaction(this.pool, async (connection) => {
      const settings = await this.access(
        actor,
        connection,
        action !== "cancel",
      );
      const [[absence]] = await connection.execute(
        "SELECT * FROM absences WHERE id = ? AND guild_id = ? FOR UPDATE",
        [id, actor.guildId],
      );
      ensure(absence, "Không tìm thấy đơn trong server này.");
      if (action === "cancel") {
        ensure(
          actor.userId === absence.user_id || isLead(actor, settings),
          "Bạn chỉ được hủy đơn của mình.",
        );
        ensure(
          ["pending", "approved"].includes(absence.status),
          "Đơn này đã được đóng.",
        );
        absence.status = "cancelled";
      } else {
        ensure(absence.status === "pending", "Đơn này đã được xử lý.");
        ensure(
          actor.userId !== absence.user_id,
          "Bạn không được tự duyệt đơn của mình. Quản trị viên khác cần xử lý.",
        );
        if (action === "approve")
          ensure(
            absence.ends_at > this.clock(),
            "Đơn đã hết thời gian, hãy từ chối hoặc yêu cầu gửi đơn mới.",
          );
        absence.status = action === "approve" ? "approved" : "rejected";
      }
      absence.reviewer_id = actor.userId;
      absence.review_note =
        action === "reject" || action === "cancel"
          ? text(note, "Lý do", 1500)
          : text(note || "Đồng ý.", "Ghi chú", 1500);
      absence.reviewed_at = this.clock();
      absence.updated_at = this.clock();
      await connection.execute(
        `UPDATE absences SET status = ?, reviewer_id = ?, review_note = ?, reviewed_at = ?, updated_at = ?
        WHERE id = ? AND guild_id = ?`,
        [
          absence.status,
          absence.reviewer_id,
          absence.review_note,
          absence.reviewed_at,
          absence.updated_at,
          id,
          actor.guildId,
        ],
      );
      await this.absenceEvent(connection, actor, settings, absence, action);
      return absence;
    });
  }

  async listAbsences(actor, { filter = "active", userId, page = 1 } = {}) {
    const settings = await this.access(actor);
    positiveInteger(page, "Trang", 10000);
    ensure(
      ["active", "pending", "all"].includes(filter),
      "Bộ lọc không hợp lệ.",
    );
    const lead = isLead(actor, settings);
    if (userId && userId !== actor.userId)
      ensure(lead, "Bạn chỉ được xem đơn của mình.");
    const where = ["guild_id = ?"];
    const params = [actor.guildId];
    if (!lead || userId) {
      where.push("user_id = ?");
      params.push(userId || actor.userId);
    }
    if (filter === "active") {
      where.push("status IN ('pending','approved') AND ends_at > ?");
      params.push(this.clock());
    }
    if (filter === "pending") where.push("status = 'pending'");
    const [rows] = await this.pool.execute(
      `SELECT * FROM absences WHERE ${where.join(" AND ")}
      ORDER BY id DESC LIMIT 11 OFFSET ${(page - 1) * 10}`,
      params,
    );
    return { absences: rows.slice(0, 10), hasMore: rows.length > 10, page };
  }

  async report(actor, days = 30, page = 1) {
    await this.access(actor, this.pool, true);
    positiveInteger(days, "Số ngày", 365);
    positiveInteger(page, "Trang", 10000);
    const now = this.clock();
    const since = new Date(now.getTime() - days * 86400_000);
    const [[totals]] = await this.pool.execute(
      `SELECT
      COUNT(CASE WHEN status IN ('assigned','in_progress','blocked') THEN 1 END) AS active,
      COUNT(CASE WHEN status = 'submitted' THEN 1 END) AS awaiting_review,
      COUNT(CASE WHEN status IN ('assigned','in_progress','blocked') AND due_at < ? THEN 1 END) AS overdue,
      COUNT(CASE WHEN status IN ('assigned','in_progress','blocked') AND next_checkin_at < ? THEN 1 END) AS stale
      FROM jobs WHERE guild_id = ?`,
      [now, now, actor.guildId],
    );
    const [[absenceTotals]] = await this.pool.execute(
      `SELECT COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending,
      COUNT(CASE WHEN status = 'approved' AND starts_at <= ? AND ends_at > ? THEN 1 END) AS away
      FROM absences WHERE guild_id = ?`,
      [now, now, actor.guildId],
    );
    const [members] = await this.pool.execute(
      `SELECT assignee_id,
      COUNT(CASE WHEN status = 'completed' AND completed_at >= ? THEN 1 END) AS completed,
      COUNT(CASE WHEN status = 'completed' AND completed_at >= ? AND submitted_at <= due_at THEN 1 END) AS on_time,
      COALESCE(SUM(CASE WHEN status = 'completed' AND completed_at >= ? THEN points ELSE 0 END), 0) AS earned_points,
      COUNT(CASE WHEN status IN ('assigned','in_progress','blocked') THEN 1 END) AS active,
      COUNT(CASE WHEN status = 'submitted' THEN 1 END) AS awaiting_review
      FROM jobs WHERE guild_id = ? GROUP BY assignee_id
      ORDER BY earned_points DESC, assignee_id LIMIT 11 OFFSET ${(page - 1) * 10}`,
      [since, since, since, actor.guildId],
    );
    return {
      totals,
      absenceTotals,
      members: members.slice(0, 10),
      hasMore: members.length > 10,
      days,
      page,
    };
  }

  async deliveryStatus(actor) {
    authorizeBotConfiguration(actor);
    const settings = await this.settings(actor.guildId);
    const [[counts]] = await this.pool.execute(
      `SELECT
      COUNT(CASE WHEN delivered_at IS NULL AND failed_at IS NULL THEN 1 END) AS pending,
      COUNT(CASE WHEN failed_at IS NOT NULL THEN 1 END) AS failed
      FROM notification_outbox WHERE guild_id = ?`,
      [actor.guildId],
    );
    return { settings, counts };
  }

  async setKpi(actor, { userId, month, target }) {
    discordId(userId);
    monthRange(month);
    positiveInteger(target, "Chỉ tiêu điểm", 1000000);
    return transaction(this.pool, async (connection) => {
      const settings = await this.access(actor, connection, true);
      await connection.execute(
        `INSERT INTO kpi_targets (guild_id, user_id, month, target_points, setter_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE target_points = VALUES(target_points),
        setter_id = VALUES(setter_id), updated_at = VALUES(updated_at)`,
        [actor.guildId, userId, month, target, actor.userId, this.clock()],
      );
      await this.audit(
        connection,
        actor,
        "kpi",
        `${userId}:${month}`,
        "set_target",
        { target },
      );
      const payload = {
        kind: "notice",
        title: `🎯 Chỉ tiêu KPI tháng ${month}`,
        description: `Thành viên ID ${userId}: ${target} điểm công việc. Dùng /kpi view để xem kết quả.`,
      };
      await enqueue(
        connection,
        actor.guildId,
        "channel",
        settings.report_channel_id,
        payload,
        undefined,
        this.clock(),
      );
      if (userId !== actor.userId)
        await enqueue(
          connection,
          actor.guildId,
          "dm",
          userId,
          payload,
          undefined,
          this.clock(),
        );
    });
  }

  async viewKpi(actor, { userId = actor.userId, month }) {
    const settings = await this.access(actor);
    ensure(
      userId === actor.userId || isLead(actor, settings),
      "Bạn chỉ được xem KPI của mình.",
    );
    const { start, end } = monthRange(month);
    const [[target]] = await this.pool.execute(
      `SELECT target_points FROM kpi_targets
      WHERE guild_id = ? AND user_id = ? AND month = ?`,
      [actor.guildId, userId, month],
    );
    const [[stats]] = await this.pool.execute(
      `SELECT COUNT(*) AS completed,
      COALESCE(SUM(points), 0) AS earned_points, COUNT(CASE WHEN submitted_at <= due_at THEN 1 END) AS on_time
      FROM jobs WHERE guild_id = ? AND assignee_id = ? AND status = 'completed' AND completed_at >= ? AND completed_at < ?`,
      [actor.guildId, userId, start, end],
    );
    return { userId, month, target: target?.target_points ?? null, ...stats };
  }
}
