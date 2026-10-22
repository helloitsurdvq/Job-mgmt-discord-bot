import test from "node:test";
import assert from "node:assert/strict";
import { transaction, lockName } from "../src/database.js";
import { databaseConfig } from "../src/config.js";

test("Transaction rollback và release connection khi có lỗi giữa chừng", async () => {
  const calls = [];
  const connection = {
    beginTransaction: async () => calls.push("begin"),
    commit: async () => calls.push("commit"),
    rollback: async () => calls.push("rollback"),
    release: () => calls.push("release"),
  };
  await assert.rejects(
    transaction({ getConnection: async () => connection }, async () => {
      throw new Error("outbox write failed");
    }),
    /outbox write failed/,
  );
  assert.deepEqual(calls, ["begin", "rollback", "release"]);
});

test("Khóa worker riêng cho db và không vượt giới hạn tên khóa MySQL", () => {
  assert.notEqual(lockName("a", "worker"), lockName("b", "worker"));
  assert.ok(lockName("a".repeat(100), "worker").length <= 64);
});

test("Cấu hình MySQL báo lỗi rõ ràng khi thiếu thông tin", () => {
  assert.throws(() => databaseConfig({}), /MYSQL_USER/);
  assert.throws(
    () =>
      databaseConfig({
        MYSQL_USER: "test",
        MYSQL_DATABASE: "test",
        MYSQL_PORT: "abc",
      }),
    /MYSQL_PORT/,
  );
  assert.equal(
    databaseConfig({ MYSQL_USER: "test", MYSQL_DATABASE: "test" }).port,
    3306,
  );
});