import test from "node:test";
import assert from "node:assert/strict";
import { JobService } from "../src/service.js";
import {
  BOT_CONFIGURATION_ROLE,
  UserError,
  isLead,
} from "../src/domain.js";

const actor = {
  guildId: "100000000000000001",
  channelId: "100000000000000002",
  userId: "200000000000000001",
  isAdmin: false,
  roleIds: [],
};
const input = {
  leadRoleId: "300000000000000001",
  reportChannelId: "100000000000000003",
  commandChannelId: "100000000000000004",
};

test("Service cho admin và role riêng cấu hình, sửa channel và xem settings", async () => {
  for (const manager of [
    { ...actor, isAdmin: true },
    { ...actor, roleNames: [BOT_CONFIGURATION_ROLE] },
  ]) {
    const queries = [];
    const connection = {
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
      execute: async (sql) => {
        queries.push(sql);
        if (sql.includes("SELECT * FROM guild_settings")) {
          return [[{
            lead_role_id: input.leadRoleId,
            report_channel_id: input.reportChannelId,
          }]];
        }
        if (sql.includes("SELECT channel_id FROM command_channels")) {
          return [[{ channel_id: input.commandChannelId }]];
        }
        if (sql.includes("FROM notification_outbox")) {
          return [[{ pending: 2, failed: 1 }]];
        }
        if (sql.includes("INSERT INTO") || sql.includes("DELETE FROM")) return [{}];
        assert.fail(`Truy vấn ngoài dự kiến: ${sql}`);
      },
    };
    const service = new JobService({
      getConnection: async () => connection,
      execute: connection.execute,
    });
    await service.configure(manager, input);
    await service.changeChannel(manager, input.commandChannelId, true);
    await service.changeChannel(manager, input.commandChannelId, false);
    const result = await service.deliveryStatus(manager);
    assert.deepEqual(result.counts, { pending: 2, failed: 1 });
    assert.ok(queries.some((sql) => sql.includes("INSERT INTO guild_settings")));
    assert.ok(queries.some((sql) => sql.includes("DELETE FROM command_channels")));
    assert.equal(queries.filter((sql) => sql.includes("INSERT INTO audit_logs")).length, 3);
  }
});

test("Service từ chối thành viên thường, Lead và tên role không đúng trước khi truy cập DB", async () => {
  const service = new JobService({
    getConnection: () => assert.fail("Không được ghi DB"),
    execute: () => assert.fail("Không được đọc DB"),
  });
  for (const member of [
    actor,
    { ...actor, roleIds: [input.leadRoleId], roleNames: ["Lead"] },
    { ...actor, roleNames: [`${BOT_CONFIGURATION_ROLE} (role khác)`] },
    { ...actor, roleNames: [] },
  ]) {
    await assert.rejects(service.configure(member, input), UserError);
    await assert.rejects(service.changeChannel(member, input.commandChannelId, true), UserError);
    await assert.rejects(service.changeChannel(member, input.commandChannelId, false), UserError);
    await assert.rejects(service.deliveryStatus(member), UserError);
  }
});

test("Role cấu hình không tự nhận quyền Lead hoặc Administrator", () => {
  const manager = { ...actor, roleNames: [BOT_CONFIGURATION_ROLE] };
  assert.equal(manager.isAdmin, false);
  assert.equal(isLead(manager, { lead_role_id: input.leadRoleId }), false);
});
