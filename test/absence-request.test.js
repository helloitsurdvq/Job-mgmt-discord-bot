import test from "node:test";
import assert from "node:assert/strict";
import { UserError } from "../src/domain.js";
import { JobService } from "../src/service.js";

const actor = {
  guildId: "100000000000000001",
  channelId: "100000000000000002",
  userId: "200000000000000001",
};
const now = new Date("2026-10-21T07:32:40Z");

test("Service chặn thời gian quá khứ, bằng hiện tại và kết thúc không sau bắt đầu trước khi chạm DB", async () => {
  let connections = 0;
  const service = new JobService(
    {
      getConnection: async () => {
        connections++;
        assert.fail("Không được chạm DB");
      },
    },
    () => now,
  );
  const later = new Date(now.getTime() + 3600_000);
  for (const [startsAt, endsAt] of [
    [new Date(now.getTime() - 1), later],
    [now, later],
    [later, new Date(now.getTime() - 1)],
    [later, now],
    [later, later],
    [new Date(later.getTime() + 1), later],
  ]) {
    await assert.rejects(
      service.requestAbsence(actor, { startsAt, endsAt, reason: "Bận" }),
      UserError,
    );
  }
  assert.equal(connections, 0);
});

test("Nút hiển thị công khai nhưng service chỉ cho Lead/admin duyệt hoặc từ chối đơn", async () => {
  for (const role of ["member", "lead", "admin"]) {
    for (const action of ["approve", "reject"]) {
      let updates = 0;
      const connection = {
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
        execute: async (sql) => {
          if (sql.includes("SELECT * FROM guild_settings"))
            return [
              [{ lead_role_id: "lead", report_channel_id: actor.channelId }],
            ];
          if (sql.includes("SELECT channel_id FROM command_channels"))
            return [[]];
          if (sql.includes("SELECT * FROM absences"))
            return [
              [
                {
                  id: 1,
                  user_id: "owner",
                  status: "pending",
                  ends_at: new Date(now.getTime() + 3600_000),
                },
              ],
            ];
          if (sql.includes("UPDATE absences")) {
            updates++;
            return [{}];
          }
          if (sql.includes("SELECT id, title, due_at, status FROM jobs"))
            return [[]];
          if (
            sql.includes("INSERT INTO notification_outbox") ||
            sql.includes("INSERT INTO audit_logs")
          )
            return [{}];
          assert.fail(`Truy vấn ngoài dự kiến: ${sql}`);
        },
      };
      const service = new JobService(
        { getConnection: async () => connection },
        () => now,
      );
      const reviewer = {
        ...actor,
        isAdmin: role === "admin",
        roleIds: role === "lead" ? ["lead"] : [],
      };
      const result = service.mutateAbsence(reviewer, 1, action, "Lý do xử lý");
      if (role === "member") {
        await assert.rejects(result, /Chỉ lead hoặc quản trị viên/);
        assert.equal(updates, 0);
      } else {
        assert.equal(
          (await result).status,
          action === "approve" ? "approved" : "rejected",
        );
        assert.equal(updates, 1);
      }
    }
  }
});

test("Đơn mới xếp tin vào channel đã cấu hình và ghi audit; sau duyệt thêm DM cho người gửi", async () => {
  const queued = [];
  const audited = [];
  const connection = {
    execute: async (sql, params) => {
      if (sql.includes("SELECT id, title, due_at, status FROM jobs"))
        return [[]];
      if (sql.includes("INSERT INTO notification_outbox")) {
        queued.push(params[2]);
        return [{}];
      }
      assert.fail(`Truy vấn ngoài dự kiến: ${sql}`);
    },
  };
  const service = new JobService({}, () => now);
  service.audit = async (...args) => {
    audited.push(args[4]);
  };
  const settings = { report_channel_id: "report", lead_role_id: "lead" };
  const absence = { id: 1, user_id: actor.userId, status: "pending" };
  await service.absenceEvent(connection, actor, settings, absence, "request");
  assert.deepEqual(queued, ["channel"]);
  assert.deepEqual(audited, ["request"]);
  await service.absenceEvent(
    connection,
    { ...actor, userId: "reviewer" },
    settings,
    { ...absence, status: "approved" },
    "approve",
  );
  assert.deepEqual(queued, ["channel", "channel", "dm"]);
  assert.deepEqual(audited, ["request", "approve"]);
});