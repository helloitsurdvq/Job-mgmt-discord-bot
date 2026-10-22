import test from "node:test";
import assert from "node:assert/strict";
import {
  refreshReminder,
  deliverNotifications,
  enqueueReminders,
} from "../src/worker.js";

test("Bỏ thông báo xin nghỉ chờ duyệt còn trong outbox khi đơn đã được xử lý", async () => {
  for (const kind of ["absence", "absence_reminder"]) {
    const payload = { kind, absence: { id: 1, status: "pending" } };
    const pool = {
      execute: async (sql, params) => {
        assert.deepEqual(params, [1, "server"]);
        return [[{ id: 1, status: "approved" }]];
      },
    };
    assert.equal(
      await refreshReminder(pool, payload, "server", new Date()),
      false,
    );
  }
});

test("Đơn chờ duyệt được gửi vào channel hiện tại, không cần channel riêng hoặc quyền tạo channel", async () => {
  const now = new Date("2026-10-21T08:00:00Z");
  const sent = [];
  const client = {
    channels: {
      fetch: async (id) => {
        assert.equal(id, "2");
        return {
          guildId: "1",
          isTextBased: () => true,
          send: async (view) => {
            sent.push(view);
          },
        };
      },
    },
  };
  const completed = [];
  const pool = {
    execute: async (sql, params) => {
      if (sql.includes("SELECT * FROM notification_outbox")) {
        return [
          [
            ...["absence", "absence_reminder"].map((kind, index) => ({
              id: index + 1,
              guild_id: "1",
              destination: "channel",
              attempts: 0,
              payload: {
                kind,
                action: "request",
                absence: { id: 1, status: "pending" },
              },
            })),
          ],
        ];
      }
      if (sql.includes("SELECT * FROM absences"))
        return [
          [
            {
              id: 1,
              status: "pending",
              user_id: "3",
              reason: "Bận",
              starts_at: now,
              ends_at: now,
            },
          ],
        ];
      if (sql.includes("FROM guild_settings"))
        return [[{ report_channel_id: "2", lead_role_id: "4" }]];
      if (sql.includes("UPDATE notification_outbox SET delivered_at")) {
        completed.push(params[1]);
        return [{}];
      }
      assert.fail(`Truy vấn ngoài dự kiến: ${sql}`);
    },
  };
  await deliverNotifications(pool, client, now);
  assert.deepEqual(completed, [1, 2]);
  assert.equal(sent.length, 2);
  assert.deepEqual(
    sent[0].components[0].toJSON().components.map((button) => button.custom_id),
    ["absence:approve:1", "absence:reject:1"],
  );
  assert.deepEqual(sent[0].allowedMentions.roles, ["4"]);
});

test("Worker không tạo lại lời nhắc Mở đơn khi chạy định kỳ", async () => {
  const pool = {
    execute: async (sql) => {
      if (sql === "SELECT * FROM guild_settings")
        return [[{ guild_id: "server" }]];
      if (sql.includes("SELECT * FROM jobs")) return [[]];
      assert.fail(`Không được tạo lịch nhắc đơn chờ duyệt: ${sql}`);
    },
  };
  await enqueueReminders(pool, new Date("2026-10-21T08:00:00Z"));
});