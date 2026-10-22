import { lockName, transaction } from "./database.js";
import { enqueue, decodePayload } from "./outbox.js";
import { jobReminders, utcDay } from "./domain.js";
import { notificationView } from "./views.js";

function reference(job, reminder) {
  const date =
    reminder === "checkin"
      ? job.next_checkin_at
      : reminder === "review"
        ? job.submitted_at
        : reminder === "acceptance"
          ? job.updated_at
          : job.due_at;
  return new Date(date).getTime();
}

export async function enqueueReminders(pool, now = new Date()) {
  const [settingsList] = await pool.execute("SELECT * FROM guild_settings");
  for (const settings of settingsList) {
    let cursor = 0;
    // Chia lô để không giữ tất cả job trong RAM.
    while (true) {
      const [jobs] = await pool.execute(
        `SELECT * FROM jobs WHERE guild_id = ? AND id > ?
        AND status IN ('assigned','in_progress','blocked','submitted') ORDER BY id LIMIT 100`,
        [settings.guild_id, cursor],
      );
      if (!jobs.length) break;
      for (const job of jobs) {
        for (const reminder of jobReminders(job, now)) {
          const version = reference(job, reminder);
          const day = reminder === "due_soon" ? "once" : utcDay(now);
          const key = `job:${settings.guild_id}:${job.id}:${job.assignee_id}:${reminder}:${version}:${day}`;
          const payload = {
            kind: "job_reminder",
            job,
            reminder,
            reference: version,
            leadRoleId: settings.lead_role_id,
          };
          await transaction(pool, async (connection) => {
            if (job.status !== "assigned") {
              await enqueue(
                connection,
                settings.guild_id,
                "channel",
                settings.report_channel_id,
                payload,
                `${key}:channel`,
                now,
              );
            }
            if (reminder !== "review")
              await enqueue(
                connection,
                settings.guild_id,
                "dm",
                job.assignee_id,
                payload,
                `${key}:dm`,
                now,
              );
          });
        }
        cursor = job.id;
      }
    }
  }
}

// Khi thông báo nằm chờ do lỗi mạng, kiểm tra lại để không nhắc một job đã xong.
export async function refreshReminder(pool, payload, guildId, now) {
  // Lời mời cũ còn trong outbox không được tiếp tục gửi nút cho người đã mất phân công.
  if (payload.kind === "job" && payload.job.status === "assigned") {
    const [[current]] = await pool.execute(
      "SELECT * FROM jobs WHERE id = ? AND guild_id = ?",
      [payload.job.id, guildId],
    );
    if (
      !current ||
      current.status !== "assigned" ||
      current.assignee_id !== payload.job.assignee_id
    )
      return false;
    payload.job = current;
  }
  if (payload.kind === "job_reminder") {
    const [[current]] = await pool.execute(
      "SELECT * FROM jobs WHERE id = ? AND guild_id = ?",
      [payload.job.id, guildId],
    );
    if (
      !current ||
      current.assignee_id !== payload.job.assignee_id ||
      reference(current, payload.reminder) !== payload.reference ||
      !jobReminders(current, now).includes(payload.reminder)
    )
      return false;
    payload.job = current;
  }
  if (
    payload.kind === "absence_reminder" ||
    (payload.kind === "absence" && payload.absence.status === "pending")
  ) {
    const [[current]] = await pool.execute(
      "SELECT * FROM absences WHERE id = ? AND guild_id = ?",
      [payload.absence.id, guildId],
    );
    if (!current || current.status !== "pending") return false;
    payload.absence = current;
  }
  return true;
}

export async function deliverNotifications(pool, client, now = new Date()) {
  const [messages] = await pool.execute(
    `SELECT * FROM notification_outbox
    WHERE delivered_at IS NULL AND failed_at IS NULL AND available_at <= ? ORDER BY id LIMIT 25`,
    [now],
  );
  for (const message of messages) {
    try {
      const payload = decodePayload(message.payload);
      if (payload.kind === "absence" && payload.impacted) {
        payload.impacted = payload.impacted.filter(
          (job) => job.status !== "assigned",
        );
      }
      // Cả các thông báo assigned đã xếp hàng trước khi cập nhật bot cũng phải giữ riêng.
      const privateAssignment =
        message.destination === "channel" && payload.job?.status === "assigned";
      const valid =
        !privateAssignment &&
        (await refreshReminder(pool, payload, message.guild_id, now));
      const view = valid
        ? notificationView(payload, message.destination)
        : null;
      if (view) {
        if (message.destination === "dm") {
          const member = await client.users.fetch(message.target_id);
          await member.send(view);
        } else {
          // Lấy kênh đích hiện tại, vì quản trị viên có thể đổi kênh sau khi xếp thông báo.
          const [[settings]] = await pool.execute(
            "SELECT report_channel_id, lead_role_id FROM guild_settings WHERE guild_id = ?",
            [message.guild_id],
          );
          const pendingAbsence =
            ["absence", "absence_reminder"].includes(payload.kind) &&
            payload.absence.status === "pending";
          const channel = await client.channels.fetch(
            settings.report_channel_id,
          );
          if (
            !channel?.isTextBased() ||
            channel.guildId !== message.guild_id ||
            typeof channel.send !== "function"
          ) {
            throw new Error("REPORT_CHANNEL_UNAVAILABLE");
          }
          if (pendingAbsence) {
            // Role Lead có thể đã đổi trong lúc tin còn nằm chờ trong outbox.
            view.content = `<@&${settings.lead_role_id}>`;
            view.allowedMentions.roles = [settings.lead_role_id];
          }
          await channel.send(view);
        }
      }
      await pool.execute(
        "UPDATE notification_outbox SET delivered_at = ?, last_error = NULL WHERE id = ?",
        [now, message.id],
      );
    } catch (error) {
      // Chỉ lưu mã lỗi, tránh đưa token, thông tin kết nối hoặc payload nhạy cảm vào log.
      const code = String(error.code || error.name || "DELIVERY_ERROR").slice(
        0,
        100,
      );
      const terminal =
        message.destination === "dm" &&
        ([50007, 10013].includes(Number(error.code)) || message.attempts >= 9);
      const retryAt = new Date(
        now.getTime() +
          Math.min(3600, 30 * 2 ** Math.min(message.attempts, 7)) * 1000,
      );
      await transaction(pool, async (connection) => {
        await connection.execute(
          `UPDATE notification_outbox SET attempts = attempts + 1, available_at = ?,
          last_error = ?, failed_at = ? WHERE id = ?`,
          [retryAt, code, terminal ? now : null, message.id],
        );
        if (terminal) {
          const [[settings]] = await connection.execute(
            "SELECT report_channel_id FROM guild_settings WHERE guild_id = ?",
            [message.guild_id],
          );
          await enqueue(
            connection,
            message.guild_id,
            "channel",
            settings.report_channel_id,
            {
              kind: "notice",
              title: "⚠️ Không gửi được thông báo riêng",
              description: `Thành viên ID ${message.target_id} không nhận được DM (mã ${code}). Lead hãy thông báo trực tiếp; thành viên vẫn có thể dùng /job list trong server.`,
            },
            `dm-failed:${message.id}`,
            now,
          );
        }
      });
      console.error(`Gửi thông báo #${message.id} thất bại (${code}).`);
    }
  }
}

export function startWorker({ pool, client, database, intervalMs = 60000 }) {
  let stopped = false;
  let timer;
  let running;
  const tick = async () => {
    let connection;
    let acquired = false;
    const name = lockName(database, "worker");
    try {
      connection = await pool.getConnection();
      const [[lock]] = await connection.execute(
        "SELECT GET_LOCK(?, 0) AS acquired",
        [name],
      );
      acquired = Number(lock.acquired) === 1;
      if (acquired) {
        await enqueueReminders(pool);
        await deliverNotifications(pool, client);
      }
    } catch (error) {
      console.error(
        `Worker gặp lỗi (${error.code || error.name}). Sẽ thử lại ở lượt sau.`,
      );
    } finally {
      if (connection) {
        try {
          if (acquired)
            await connection.execute("SELECT RELEASE_LOCK(?)", [name]);
        } finally {
          connection.release();
        }
      }
    }
  };
  const loop = async () => {
    try {
      await tick();
    } catch (error) {
      console.error(
        `Không giải phóng được khóa worker (${error.code || error.name}).`,
      );
    }
    if (!stopped)
      timer = setTimeout(() => {
        running = loop();
      }, intervalMs);
  };
  running = loop();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}