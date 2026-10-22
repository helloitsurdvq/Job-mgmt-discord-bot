import test from "node:test";
import assert from "node:assert/strict";
import {
  parseVietnamTime,
  monthRange,
  utcDay,
  defaultCheckin,
  jobReminders,
  authorizeJobAction,
  positiveInteger,
  discordId,
  UserError,
} from "../src/domain.js";

const settings = { lead_role_id: "100000000000000001" };
const member = { userId: "200000000000000001", roleIds: [], isAdmin: false };
const lead = {
  userId: "200000000000000002",
  roleIds: [settings.lead_role_id],
  isAdmin: false,
};
const other = { ...member, userId: "200000000000000003" };
const now = new Date("2026-10-19T12:00:00Z");
const job = {
  assignee_id: member.userId,
  status: "in_progress",
  due_at: new Date("2026-10-20T12:00:00Z"),
  next_checkin_at: new Date("2026-10-20T00:00:00Z"),
  updated_at: now,
  submitted_at: null,
};

test("Giờ Việt Nam chuyển sang UTC, không phụ thuộc timezone của máy", () => {
  assert.equal(
    parseVietnamTime("2026-10-19 19:00").toISOString(),
    "2026-10-19T12:00:00.000Z",
  );
  assert.equal(
    parseVietnamTime("2026-10-19 00:30").toISOString(),
    "2026-10-18T17:30:00.000Z",
  );
});

test("Từ chối ngày bị JavaScript tự cuộn sang tháng khác và cú pháp mơ hồ", () => {
  for (const value of [
    "2026-02-29 12:00",
    "2026-04-31 12:00",
    "2026-00-10 12:00",
    "2026-10-00 12:00",
    "2026-10-19 24:00",
    "2026-10-19 12:60",
    "19/10/2026",
    "2026-10-19T12:00Z",
    "2026-1-1 01:00",
  ]) {
    assert.throws(() => parseVietnamTime(value), UserError, value);
  }
  assert.equal(
    parseVietnamTime("2028-02-29 12:00").toISOString(),
    "2028-02-29T05:00:00.000Z",
  );
});

test("KPI tháng tính đúng biên UTC+7 và chuyển năm", () => {
  const { start, end } = monthRange("2026-12");
  assert.equal(start.toISOString(), "2026-11-30T17:00:00.000Z");
  assert.equal(end.toISOString(), "2026-12-31T17:00:00.000Z");
  assert.throws(() => monthRange("2026-13"), UserError);
  assert.throws(() => monthRange("2026-1"), UserError);
  assert.equal(utcDay(new Date("2026-10-19T18:00:00Z")), "2026-10-20");
});

test("Chỉ người nhận được nhận việc, cập nhật, gửi kết quả", () => {
  authorizeJobAction(job, member, settings, "update");
  assert.throws(
    () => authorizeJobAction(job, other, settings, "update"),
    UserError,
  );
  assert.throws(
    () => authorizeJobAction(job, lead, settings, "submit"),
    UserError,
  );
});

test("Chỉ Lead được duyệt, kể cả job của mình theo quy tắc hiện tại; không duyệt lại", () => {
  const submitted = { ...job, status: "submitted" };
  authorizeJobAction(submitted, lead, settings, "approve");
  assert.throws(
    () => authorizeJobAction(submitted, member, settings, "approve"),
    UserError,
  );
  assert.doesNotThrow(
    () =>
      authorizeJobAction(
        { ...submitted, assignee_id: lead.userId },
        lead,
        settings,
        "approve",
      ),
  );
  assert.throws(
    () =>
      authorizeJobAction(
        { ...job, status: "completed" },
        lead,
        settings,
        "approve",
      ),
    UserError,
  );
});

test("Trạng thái chặn thao tác sai kể cả khi dùng nút cũ", () => {
  assert.throws(
    () => authorizeJobAction(job, member, settings, "accept"),
    UserError,
  );
  assert.throws(
    () =>
      authorizeJobAction(
        { ...job, status: "submitted" },
        member,
        settings,
        "update",
      ),
    UserError,
  );
  authorizeJobAction(
    { ...job, status: "declined" },
    lead,
    settings,
    "reschedule",
  );
  assert.throws(
    () => authorizeJobAction(job, member, settings, "made_up"),
    UserError,
  );
});

test("Lịch nhắc phân biệt sắp hạn, quá hạn, chờ nhận, chờ duyệt", () => {
  assert.deepEqual(jobReminders(job, now), ["due_soon"]);
  assert.deepEqual(
    jobReminders({ ...job, due_at: now, next_checkin_at: now }, now),
    ["overdue", "checkin"],
  );
  assert.deepEqual(jobReminders({ ...job, status: "completed" }, now), []);
  assert.deepEqual(
    jobReminders(
      { ...job, status: "submitted", submitted_at: new Date(now - 86400_000) },
      now,
    ),
    ["review"],
  );
  assert.ok(
    jobReminders(
      { ...job, status: "assigned", updated_at: new Date(now - 86400_000) },
      now,
    ).includes("acceptance"),
  );
});

test("Mốc cập nhật mặc định không vượt quá deadline", () => {
  assert.equal(defaultCheckin(now, job.due_at).getTime(), job.due_at.getTime());
  assert.ok(defaultCheckin(now, new Date(now - 1)) > now);
});

test("ID Discord giữ nguyên dạng chuỗi và ID job chặn input không an toàn", () => {
  assert.equal(discordId("99999999999999999999"), "99999999999999999999");
  assert.throws(() => discordId(999999999999999999), UserError);
  for (const value of [0, -1, NaN, 1.2, 4294967296, "1 OR 1=1"])
    assert.throws(() => positiveInteger(value, "ID"), UserError);
});