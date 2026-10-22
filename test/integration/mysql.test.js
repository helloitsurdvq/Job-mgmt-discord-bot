import test from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { databaseConfig } from "../../src/config.js";
import { createPool, migrate } from "../../src/database.js";
import { JobService } from "../../src/service.js";
import { UserError } from "../../src/domain.js";
import { enqueueReminders, deliverNotifications } from "../../src/worker.js";
import { enqueue, decodePayload } from "../../src/outbox.js";

// Chỉ chạy với database test do bạn chỉ định rõ, không dùng database thật.
const testDatabase = process.env.TEST_MYSQL_DATABASE;
test(
  "MySQL: luồng nghiệp vụ, transaction, cạnh tranh và gửi thông báo",
  {
    skip: !testDatabase
      ? "Đặt TEST_MYSQL_DATABASE có hậu tố _test để chạy với MySQL thật."
      : false,
  },
  async (t) => {
    assert.match(
      testDatabase,
      /^[a-zA-Z0-9_]+_test$/,
      "Database kiểm thử phải có hậu tố _test.",
    );
    const config = databaseConfig({
      ...process.env,
      MYSQL_DATABASE: testDatabase,
    });
    const pool = createPool(config);
    const guildId = `8${Date.now()}${randomInt(1000, 9999)}`;
    const otherGuildId = `9${Date.now()}${randomInt(1000, 9999)}`;
    const roleId = "100000000000000001";
    const channelId = "100000000000000002";
    const reportChannelId = "100000000000000003";
    const admin = {
      guildId,
      channelId,
      userId: "200000000000000001",
      isAdmin: true,
      roleIds: [],
    };
    const lead = {
      ...admin,
      userId: "200000000000000002",
      isAdmin: false,
      roleIds: [roleId],
    };
    const member = {
      ...admin,
      userId: "200000000000000003",
      isAdmin: false,
      roleIds: [],
    };
    const other = { ...member, userId: "200000000000000004" };
    let now = new Date("2026-10-19T12:00:00Z");
    const service = new JobService(pool, () => new Date(now));
    const create = async (input = {}) =>
      (
        await service.createJob(lead, {
          title: "Test job ' tiếng Việt",
          description: "Sản phẩm cần nộp",
          assigneeId: member.userId,
          points: 5,
          dueAt: new Date("2026-10-21T12:00:00Z"),
          ...input,
        })
      ).job;
    const count = async (table) => {
      const [[row]] = await pool.execute(
        `SELECT COUNT(*) AS total FROM ${table} WHERE guild_id = ?`,
        [guildId],
      );
      return row.total;
    };
    try {
      await migrate(pool, config.database);
      await migrate(pool, config.database); // Chạy lại migration không được phá dữ liệu.
      await service.configure(admin, {
        leadRoleId: roleId,
        reportChannelId,
        commandChannelId: channelId,
      });
      await service.configure(
        { ...admin, guildId: otherGuildId },
        { leadRoleId: roleId, reportChannelId, commandChannelId: channelId },
      );

      await t.test(
        "Phân quyền tạo job, channel và quyền xem dữ liệu cá nhân",
        async () => {
          await assert.rejects(
            service.createJob(member, {
              title: "test",
              assigneeId: member.userId,
              dueAt: new Date("2026-10-21T12:00Z"),
            }),
            UserError,
          );
          const job = await create();
          assert.equal(
            (await service.viewJob(member, job.id)).job.title,
            "Test job ' tiếng Việt",
          );
          await assert.rejects(service.viewJob(other, job.id), UserError);
          await assert.rejects(
            service.viewJob(
              { ...member, channelId: "300000000000000001" },
              job.id,
            ),
            UserError,
          );
          await assert.rejects(
            service.viewJob({ ...lead, guildId: otherGuildId }, job.id),
            UserError,
          );
        },
      );

      await t.test(
        "Job và outbox rollback cùng nhau khi bước audit bị lỗi",
        async () => {
          const beforeJobs = await count("jobs");
          const beforeOutbox = await count("notification_outbox");
          const original = service.audit;
          service.audit = async () => {
            throw new Error("SIMULATED_FAILURE");
          };
          try {
            await assert.rejects(create(), /SIMULATED_FAILURE/);
          } finally {
            service.audit = original;
          }
          assert.equal(await count("jobs"), beforeJobs);
          assert.equal(await count("notification_outbox"), beforeOutbox);
        },
      );

      await t.test(
        "Job chờ nhận chỉ xếp DM, quyết định nhận/từ chối mới xếp thông báo công khai",
        async () => {
          for (const action of ["accept", "decline"]) {
            const job = await create();
            const events = async () => {
              const [rows] = await pool.execute(
                `SELECT destination, payload FROM notification_outbox
            WHERE guild_id = ? AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.job.id')) = ? ORDER BY id`,
                [guildId, String(job.id)],
              );
              return rows.map((row) => ({
                ...row,
                payload: decodePayload(row.payload),
              }));
            };
            const initial = await events();
            assert.deepEqual(
              initial.map((row) => row.destination),
              ["dm"],
            );
            assert.equal(initial[0].payload.job.status, "assigned");
            await assert.rejects(
              service.mutateJob(other, job.id, action, {
                note: "Không được phép",
              }),
              UserError,
            );
            assert.equal((await events()).length, 1);
            await service.mutateJob(member, job.id, action, {
              note: "Xác nhận lựa chọn",
            });
            const published = (await events()).filter(
              (row) => row.destination === "channel",
            );
            assert.equal(published.length, 1);
            assert.equal(
              published[0].payload.job.status,
              action === "accept" ? "in_progress" : "declined",
            );
          }
        },
      );

      await t.test(
        "Lead xem xác nhận hủy chưa thay đổi job; xác nhận hủy mới công khai cancelled",
        async () => {
          const job = await create();
          await assert.rejects(
            service.previewCancellation(member, job.id, "Không được phép"),
            UserError,
          );
          const before = await count("notification_outbox");
          const preview = await service.previewCancellation(
            lead,
            job.id,
            "Thay đổi kế hoạch",
          );
          assert.equal(preview.job.status, "assigned");
          assert.equal(await count("notification_outbox"), before);
          await assert.rejects(
            service.mutateJob(member, job.id, "cancel", {
              note: "Không được phép",
            }),
            UserError,
          );
          await service.mutateJob(lead, job.id, "cancel", {
            note: preview.note,
          });
          const [rows] = await pool.execute(
            `SELECT payload FROM notification_outbox WHERE guild_id = ? AND destination = 'channel'
        AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.job.id')) = ?`,
            [guildId, String(job.id)],
          );
          assert.equal(rows.length, 1);
          assert.equal(decodePayload(rows[0].payload).job.status, "cancelled");
        },
      );

      await t.test(
        "Nhận → cập nhật → nộp → yêu cầu sửa → nộp lại → duyệt, không cộng điểm hai lần",
        async () => {
          const job = await create();
          await service.mutateJob(member, job.id, "accept");
          await service.mutateJob(member, job.id, "update", {
            note: "Đang chờ tài liệu",
            progress: 40,
            status: "blocked",
          });
          await service.mutateJob(member, job.id, "submit", {
            note: "https://example.com/result",
          });
          await service.mutateJob(lead, job.id, "return", {
            note: "Sửa phần đầu",
          });
          await service.mutateJob(member, job.id, "submit", {
            note: "Bản đã sửa",
          });
          const results = await Promise.allSettled([
            service.mutateJob(lead, job.id, "approve"),
            service.mutateJob(admin, job.id, "approve"),
          ]);
          assert.equal(
            results.filter((result) => result.status === "fulfilled").length,
            1,
          );
          assert.equal(
            (await service.viewJob(lead, job.id)).job.status,
            "completed",
          );
          await service.setKpi(lead, {
            userId: member.userId,
            month: "2026-10",
            target: 10,
          });
          const kpi = await service.viewKpi(member, { month: "2026-10" });
          assert.equal(Number(kpi.earned_points), 5);
          assert.equal(kpi.on_time, 1);
          assert.equal(kpi.target, 10);
          await assert.rejects(
            service.viewKpi(other, { userId: member.userId, month: "2026-10" }),
            UserError,
          );
        },
      );

      await t.test(
        "Không lưu đơn có thời gian quá khứ, kết thúc sai hoặc bắt đầu trôi qua lúc chờ DB",
        async () => {
          const before = await count("absences");
          for (const startsAt of [new Date(now.getTime() - 1), now]) {
            await assert.rejects(
              service.requestAbsence(member, {
                startsAt,
                endsAt: new Date(now.getTime() + 3600000),
                reason: "Bận",
              }),
              UserError,
            );
          }
          const startsAt = new Date(now.getTime() + 60000);
          await assert.rejects(
            service.requestAbsence(member, {
              startsAt,
              endsAt: startsAt,
              reason: "Bận",
            }),
            UserError,
          );
          const originalAccess = service.access;
          const originalNow = now;
          service.access = async (...args) => {
            const settings = await originalAccess.apply(service, args);
            now = new Date(now.getTime() + 2 * 60000);
            return settings;
          };
          try {
            await assert.rejects(
              service.requestAbsence(member, {
                startsAt,
                endsAt: new Date(originalNow.getTime() + 3600000),
                reason: "Bận",
              }),
              UserError,
            );
          } finally {
            service.access = originalAccess;
            now = originalNow;
          }
          assert.equal(await count("absences"), before);
        },
      );

      await t.test(
        "Đơn báo bận chỉ lead duyệt, không tự duyệt, không tự đổi deadline",
        async () => {
          const job = await create();
          const absence = await service.requestAbsence(member, {
            startsAt: new Date(now.getTime() + 60000),
            endsAt: new Date("2026-10-22T12:00Z"),
            reason: "Thi học kỳ",
          });
          const [notifications] = await pool.execute(
            `SELECT payload FROM notification_outbox WHERE guild_id = ?
        AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.absence.id')) = ?`,
            [guildId, String(absence.id)],
          );
          assert.equal(
            notifications.length,
            1,
            "Đơn mới tạo một tin trực tiếp vào channel đã cấu hình",
          );
          assert.ok(
            notifications.every(
              (row) =>
                !decodePayload(row.payload).impacted.some(
                  (item) => item.id === job.id,
                ),
            ),
          );
          await assert.rejects(
            service.reviewAbsence(member, absence.id),
            UserError,
          );
          await assert.rejects(
            service.reviewAbsence(other, absence.id),
            UserError,
          );
          await assert.rejects(
            service.reviewAbsence(
              { ...lead, guildId: otherGuildId },
              absence.id,
            ),
            UserError,
          );
          const review = await service.reviewAbsence(lead, absence.id);
          assert.equal(review.absence.reason, "Thi học kỳ");
          assert.equal(review.absence.status, "pending");
          assert.equal(
            review.impacted.some((item) => item.id === job.id),
            false,
          );
          await assert.rejects(
            service.mutateAbsence(other, absence.id, "approve"),
            UserError,
          );
          await service.mutateAbsence(lead, absence.id, "approve");
          assert.equal(
            (await service.reviewAbsence(lead, absence.id)).absence.status,
            "approved",
          );
          assert.equal(
            (await service.viewJob(member, job.id)).job.due_at.toISOString(),
            job.due_at.toISOString(),
          );
          assert.equal((await service.listAbsences(other)).absences.length, 0);
          assert.equal(
            (await service.listAbsences(member)).absences[0].reason,
            "Thi học kỳ",
          );
          const own = await service.requestAbsence(lead, {
            startsAt: new Date(now.getTime() + 60000),
            endsAt: new Date("2026-10-22T12:00Z"),
            reason: "Bận",
          });
          await assert.rejects(
            service.mutateAbsence(lead, own.id, "approve"),
            UserError,
          );
          const created = await service.createJob(lead, {
            title: "Job có cảnh báo bận",
            assigneeId: member.userId,
            dueAt: new Date("2026-10-21T12:00Z"),
          });
          assert.match(created.warning, new RegExp(`#${absence.id}`));
        },
      );

      await t.test(
        "Gia hạn và chuyển người, người cũ mất quyền sửa",
        async () => {
          const job = await create();
          await service.mutateJob(member, job.id, "decline", {
            note: "Không đủ thời gian",
          });
          await service.mutateJob(lead, job.id, "reschedule", {
            note: "Gia hạn",
            dueAt: new Date("2026-10-23T12:00Z"),
          });
          const updated = await service.mutateJob(lead, job.id, "reassign", {
            note: "Chuyển cho người rảnh",
            assigneeId: other.userId,
          });
          assert.equal(updated.status, "assigned");
          await assert.rejects(
            service.mutateJob(member, job.id, "accept"),
            UserError,
          );
          await service.mutateJob(other, job.id, "accept");
        },
      );

      await t.test(
        "Nhắc hạn không xếp trùng và bỏ nhắc job đã hủy",
        async () => {
          const job = await create({
            dueAt: new Date(now.getTime() + 3600_000),
          });
          const pending = await create({
            title: "Chưa được phép công khai",
            dueAt: new Date(now.getTime() + 3600_000),
          });
          // Mô phỏng một tin assigned đã xếp hàng bởi phiên bản bot cũ.
          await enqueue(
            pool,
            guildId,
            "channel",
            reportChannelId,
            { kind: "job", job: pending, action: "create" },
            undefined,
            now,
          );
          await enqueueReminders(pool, now);
          const [privateReminders] = await pool.execute(
            `SELECT destination FROM notification_outbox WHERE guild_id = ?
        AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.kind')) = 'job_reminder'
        AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.job.id')) = ?`,
            [guildId, String(pending.id)],
          );
          assert.ok(privateReminders.length > 0);
          assert.ok(privateReminders.every((row) => row.destination === "dm"));
          const before = await count("notification_outbox");
          await enqueueReminders(pool, now);
          assert.equal(await count("notification_outbox"), before);
          await service.mutateJob(lead, job.id, "cancel", {
            note: "Không còn cần",
          });
          const sent = [];
          const publicMessages = [];
          const fakeClient = {
            users: {
              fetch: async () => ({ send: async (view) => sent.push(view) }),
            },
            channels: {
              fetch: async () => ({
                guildId,
                isTextBased: () => true,
                send: async (view) => {
                  sent.push(view);
                  publicMessages.push(view);
                },
              }),
            },
          };
          // Những thông báo nghiệp vụ cũ vẫn là lịch sử. Riêng lịch nhắc đã cũ phải bị bỏ qua.
          for (let i = 0; i < 20; i++)
            await deliverNotifications(pool, fakeClient, now);
          const reminderTitles = sent.map(
            (view) => view.embeds[0].toJSON().title,
          );
          assert.equal(
            reminderTitles.some(
              (title) =>
                title.includes("Sắp đến hạn") && title.endsWith(`#${job.id}`),
            ),
            false,
          );
          assert.equal(
            publicMessages.some((view) =>
              view.embeds[0].toJSON().title.endsWith(`#${pending.id}`),
            ),
            false,
          );
          const [[row]] = await pool.execute(
            `SELECT COUNT(*) AS pending FROM notification_outbox
        WHERE guild_id = ? AND delivered_at IS NULL AND failed_at IS NULL`,
            [guildId],
          );
          assert.equal(row.pending, 0);
        },
      );

      await t.test(
        "Lỗi gửi channel được retry, DM bị chặn được báo cho lead",
        async () => {
          await create();
          const published = await create();
          await service.mutateJob(member, published.id, "accept");
          let failChannel = true;
          const sent = [];
          const fakeClient = {
            users: {
              fetch: async () => ({
                send: async () => {
                  throw Object.assign(new Error("DM blocked"), { code: 50007 });
                },
              }),
            },
            channels: {
              fetch: async () => ({
                guildId,
                isTextBased: () => true,
                send: async (view) => {
                  if (failChannel) {
                    failChannel = false;
                    throw Object.assign(new Error("Missing permissions"), {
                      code: 50013,
                    });
                  }
                  sent.push(view);
                },
              }),
            },
          };
          await deliverNotifications(pool, fakeClient, now);
          const [[row]] = await pool.execute(
            `SELECT
        COUNT(CASE WHEN failed_at IS NOT NULL THEN 1 END) AS failed,
        COUNT(CASE WHEN last_error = '50013' AND delivered_at IS NULL THEN 1 END) AS retrying
        FROM notification_outbox WHERE guild_id = ?`,
            [guildId],
          );
          assert.equal(row.failed, 1);
          assert.equal(row.retrying, 1);
          await deliverNotifications(
            pool,
            fakeClient,
            new Date(now.getTime() + 60000),
          );
          assert.ok(
            sent.some((view) =>
              view.embeds[0].toJSON().title.includes("Không gửi được"),
            ),
          );
          const [[pending]] = await pool.execute(
            `SELECT COUNT(*) AS total FROM notification_outbox
        WHERE guild_id = ? AND delivered_at IS NULL AND failed_at IS NULL`,
            [guildId],
          );
          assert.equal(pending.total, 0);
        },
      );

      await t.test(
        "Báo cáo chạy được, bộ lọc và phân trang chạy được",
        async () => {
          const report = await service.report(lead);
          assert.ok(report.members.length > 0);
          await assert.rejects(service.report(member), UserError);
          const list = await service.listJobs(member, {
            filter: "all",
            page: 1,
          });
          assert.ok(list.jobs.length > 0);
          assert.deepEqual(
            (await service.listJobs(member, { page: 100 })).jobs,
            [],
          );
        },
      );
    } finally {
      // Xóa đúng fixture theo guild_id, không DROP/TRUNCATE bảng hoặc database.
      for (const guild of [guildId, otherGuildId]) {
        await pool
          .execute(
            "DELETE u FROM job_updates u JOIN jobs j ON j.id = u.job_id WHERE j.guild_id = ?",
            [guild],
          )
          .catch(() => {});
        for (const table of [
          "notification_outbox",
          "audit_logs",
          "kpi_targets",
          "absences",
          "jobs",
          "command_channels",
          "guild_settings",
        ]) {
          await pool
            .execute(`DELETE FROM ${table} WHERE guild_id = ?`, [guild])
            .catch(() => {});
        }
      }
      await pool.end();
    }
  },
);