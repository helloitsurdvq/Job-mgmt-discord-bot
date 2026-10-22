import test from "node:test";
import assert from "node:assert/strict";
import { MessageFlags } from "discord.js";
import { commands } from "../src/commands.js";
import {
  notificationView,
  jobDetail,
  absenceList,
  jobButtons,
} from "../src/views.js";
import {
  absenceModal,
  actionModal,
  actorFrom,
  interactionHandler,
} from "../src/interactions.js";
import { UserError, BOT_CONFIGURATION_ROLE } from "../src/domain.js";

const job = {
  id: 1,
  guild_id: "100000000000000001",
  assignee_id: "200000000000000001",
  title: "@everyone " + "*".repeat(140),
  description: "*".repeat(1500),
  status: "assigned",
  progress: 0,
  points: 5,
  due_at: new Date("2026-10-20T00:00:00Z"),
  next_checkin_at: new Date("2026-10-19T00:00:00Z"),
};
const absence = {
  id: 1,
  user_id: job.assignee_id,
  starts_at: job.next_checkin_at,
  ends_at: job.due_at,
  reason: "*".repeat(1500),
  review_note: "*".repeat(1500),
  status: "pending",
};

function embedSize(embed) {
  const json = embed.toJSON();
  return (
    (json.title?.length || 0) +
    (json.description?.length || 0) +
    (json.footer?.text?.length || 0) +
    (json.fields || []).reduce(
      (sum, field) => sum + field.name.length + field.value.length,
      0,
    )
  );
}

test("Mọi command serialize được và required option đứng trước optional", () => {
  const check = (options) => {
    let optionalSeen = false;
    for (const option of options || []) {
      if (option.type === 1 || option.type === 2) {
        check(option.options);
        continue;
      }
      if (!option.required) optionalSeen = true;
      else assert.equal(optionalSeen, false, option.name);
    }
  };
  const json = commands.map((command) => command.toJSON());
  assert.equal(new Set(json.map((command) => command.name)).size, json.length);
  for (const command of json) check(command.options);
});

test("Thông báo không ping @everyone hoặc role tùy ý từ nội dung người dùng", () => {
  const view = notificationView(
    { kind: "job", action: "create", job, note: "@everyone <@&123>" },
    "channel",
  );
  assert.deepEqual(view.allowedMentions.parse, []);
  assert.deepEqual(view.allowedMentions.users, [job.assignee_id]);
  assert.deepEqual(view.allowedMentions.roles, []);
  const dm = notificationView({ kind: "job", action: "create", job }, "dm");
  assert.deepEqual(
    dm.components[0].toJSON().components.map((button) => button.custom_id),
    [
      `assignment:accept:${job.guild_id}:1`,
      `assignment:decline:${job.guild_id}:1`,
    ],
  );
  assert.deepEqual(
    notificationView(
      { kind: "job", action: "accept", job: { ...job, status: "in_progress" } },
      "dm",
    ).components,
    [],
  );
});

test("Embed vẫn dưới giới hạn Discord khi nội dung và lịch sử dài", () => {
  const detail = jobDetail({
    job,
    updates: Array.from({ length: 5 }, () => ({
      actor_id: job.assignee_id,
      action: "update",
      note: "*".repeat(1500),
      created_at: job.due_at,
    })),
  });
  assert.ok(embedSize(detail.embeds[0]) < 6000);
  const list = absenceList({
    absences: Array.from({ length: 10 }, (_, id) => ({ ...absence, id })),
    page: 1,
    hasMore: true,
  });
  assert.ok(embedSize(list.embeds[0]) < 6000);
  const view = notificationView(
    {
      kind: "absence",
      absence,
      action: "request",
      impacted: Array(10).fill(job),
      leadRoleId: "300000000000000001",
    },
    "dm",
  );
  assert.ok(embedSize(view.embeds[0]) < 6000);
  assert.deepEqual(view.allowedMentions.roles, []);
});

test("Form có tối đa 5 hàng và custom ID giữ dưới 100 ký tự", () => {
  for (const modal of [
    absenceModal(),
    actionModal("job", "update", 4294967295),
    actionModal("job", "submit", 1),
    actionModal("absence", "reject", 1),
  ]) {
    const json = modal.toJSON();
    assert.ok(json.custom_id.length <= 100);
    assert.ok(json.components.length <= 5);
  }
});

test("Không nhận interaction từ DM hoặc server khác", () => {
  assert.throws(() => actorFrom({ inGuild: () => false }, "1"), UserError);
  assert.throws(
    () => actorFrom({ inGuild: () => true, guildId: "2" }, "1"),
    UserError,
  );
});

test("Lệnh cấu hình không còn bị Discord giới hạn chỉ Administrator", () => {
  for (const name of ["setup", "settings"]) {
    const command = commands.find((entry) => entry.name === name).toJSON();
    assert.equal(command.default_member_permissions, null);
  }
});

test("Role cấu hình dùng setup và toàn bộ settings qua cả hai dạng member roles", async () => {
  for (const cachedMember of [false, true]) {
    for (const [commandName, action] of [
      ["setup", null],
      ["settings", "show"],
      ["settings", "channel-add"],
      ["settings", "channel-remove"],
    ]) {
      const interaction = fakeInteraction({ commandName, action });
      const roles = new Map([["manager-role", { name: BOT_CONFIGURATION_ROLE }]]);
      interaction.member.roles = cachedMember
        ? { cache: roles }
        : ["manager-role"];
      interaction.guild = { roles: { cache: roles } };
      interaction.options.getChannel = () => ({
        id: "2",
        permissionsFor: () => ({ has: () => true }),
      });
      interaction.options.getRole = () => ({ id: "4" });
      let calls = 0;
      const verifyActor = (actor) => {
        calls++;
        assert.equal(actor.isAdmin, false);
        assert.deepEqual(actor.roleNames, [BOT_CONFIGURATION_ROLE]);
      };
      const service = {
        configure: async (actor) => verifyActor(actor),
        changeChannel: async (actor, channelId, add) => {
          verifyActor(actor);
          assert.equal(add, action === "channel-add");
        },
        deliveryStatus: async (actor) => {
          verifyActor(actor);
          return {
            settings: { lead_role_id: "4", report_channel_id: "2", channels: [] },
            counts: { pending: 0, failed: 0 },
          };
        },
      };
      await interactionHandler({ service, guildId: "1" })(interaction);
      assert.equal(calls, 1, `${commandName} ${action}`);
      assert.equal(interaction.ephemeral, true);
      assert.deepEqual(interaction.calls.map((call) => call.method), [
        "deferReply", "editReply",
      ]);
    }
  }
});

test("Thành viên không giữ role cấu hình bị chặn trước khi gọi service", async () => {
  for (const [commandName, action] of [
    ["setup", null],
    ["settings", "show"],
    ["settings", "channel-add"],
    ["settings", "channel-remove"],
  ]) {
    const interaction = fakeInteraction({ commandName, action });
    // Having the role in the guild, or the same display name, does not grant membership.
    interaction.guild = {
      roles: { cache: new Map([["manager-role", { name: BOT_CONFIGURATION_ROLE }]]) },
    };
    interaction.user.username = BOT_CONFIGURATION_ROLE;
    const deniedService = new Proxy({}, {
      get: () => assert.fail("Không được gọi service khi không có quyền"),
    });
    await interactionHandler({ service: deniedService, guildId: "1" })(interaction);
    assert.equal(interaction.ephemeral, true);
    assert.ok(interaction.calls.at(-1).options.content.includes(BOT_CONFIGURATION_ROLE));
  }
});

test("Lệnh xin nghỉ mở ngay form bắt đầu, kết thúc và lý do như trước", async () => {
  const interaction = fakeInteraction({
    commandName: "absence",
    action: "request",
  });
  await interactionHandler({ service: {}, guildId: "1" })(interaction);
  assert.deepEqual(
    interaction.calls.map((call) => call.method),
    ["showModal"],
  );
  const modal = interaction.calls[0].options.toJSON();
  assert.equal(modal.custom_id, "absence:request:new");
  assert.deepEqual(
    modal.components.map((row) => row.components[0].custom_id),
    ["start", "end", "reason"],
  );
  assert.match(modal.components[2].components[0].label, /Lý do báo bận/);
});

test("Gửi form xin nghỉ chuyển giờ Việt Nam sang UTC và trả xác nhận công khai như trước", async () => {
  const interaction = fakeInteraction({
    kind: "modal",
    customId: "absence:request:new",
    inputs: {
      start: "2026-10-25 08:00",
      end: "2026-10-28 18:00",
      reason: "Bận công việc",
    },
  });
  let saved = 0;
  const service = {
    requestAbsence: async (actor, input) => {
      saved++;
      assert.equal(actor.userId, "3");
      assert.equal(input.startsAt.toISOString(), "2026-10-25T01:00:00.000Z");
      assert.equal(input.endsAt.toISOString(), "2026-10-28T11:00:00.000Z");
      assert.equal(input.reason, "Bận công việc");
      return {
        ...absence,
        user_id: actor.userId,
        starts_at: input.startsAt,
        ends_at: input.endsAt,
        reason: input.reason,
      };
    },
  };
  await interactionHandler({ service, guildId: "1" })(interaction);
  assert.equal(saved, 1);
  assert.equal(interaction.ephemeral, false);
  assert.deepEqual(
    interaction.calls.map((call) => call.method),
    ["deferReply", "editReply"],
  );
  assert.match(interaction.calls[1].options.content, /chờ Lead/);
});

test("Ngày sai định dạng hoặc không tồn tại bị từ chối riêng trước khi gọi service", async () => {
  for (const start of ["25/10/2026 08:00", "2026-02-30 08:00"]) {
    const interaction = fakeInteraction({
      kind: "modal",
      customId: "absence:request:new",
      inputs: {
        start,
        end: "2026-10-28 18:00",
        reason: "Bận",
      },
    });
    const service = {
      requestAbsence: () => assert.fail("Không được lưu ngày không hợp lệ"),
    };
    await interactionHandler({ service, guildId: "1" })(interaction);
    assert.deepEqual(
      interaction.calls.map((call) => call.method),
      ["deferReply", "editReply", "followUp"],
    );
    assert.equal(interaction.calls[2].options.flags, MessageFlags.Ephemeral);
    assert.deepEqual(interaction.calls[2].options.embeds, []);
  }
});

test("Nút, menu và form lịch cũ hướng dẫn chạy lại lệnh, không update lịch lỗi", async () => {
  for (const kind of ["button", "select", "modal"]) {
    const interaction = fakeInteraction({
      kind,
      customId: "absencepick:old:0:next",
    });
    await interactionHandler({ service: {}, guildId: "1" })(interaction);
    assert.deepEqual(
      interaction.calls.map((call) => call.method),
      ["reply"],
    );
    assert.equal(interaction.calls[0].options.flags, MessageFlags.Ephemeral);
    assert.match(
      interaction.calls[0].options.content,
      /Hãy chạy lại \/absence request/,
    );
  }
});

function fakeInteraction({
  commandName = "help",
  action = null,
  kind = "slash",
  customId,
  inputs = {},
} = {}) {
  const calls = [];
  return {
    calls,
    commandName,
    customId,
    deferred: false,
    replied: false,
    ephemeral: false,
    isChatInputCommand: () => kind === "slash",
    isButton: () => kind === "button",
    isModalSubmit: () => kind === "modal",
    isStringSelectMenu: () => kind === "select",
    inGuild: () => true,
    guildId: "1",
    channelId: "2",
    member: { roles: [] },
    memberPermissions: { has: () => false },
    user: { id: "3" },
    options: {
      getSubcommand: () => action,
      getUser: () => null,
      getInteger: (name) => (name === "id" ? 1 : null),
      getString: (name) => (name === "month" ? "2026-10" : null),
    },
    fields: { getTextInputValue: (name) => inputs[name] ?? "" },
    async showModal(options) {
      calls.push({ method: "showModal", options });
      this.replied = true;
    },
    channel: {
      send: async (options) => {
        calls.push({ method: "channel.send", options });
      },
    },
    async deferReply(options) {
      calls.push({ method: "deferReply", options });
      this.deferred = true;
      this.ephemeral = Boolean(options.flags & MessageFlags.Ephemeral);
    },
    async editReply(options) {
      calls.push({ method: "editReply", options });
      this.replied = true;
    },
    async deleteReply() {
      calls.push({ method: "deleteReply" });
    },
    async followUp(options) {
      calls.push({ method: "followUp", options });
      this.replied = true;
    },
    async reply(options) {
      calls.push({ method: "reply", options });
      this.replied = true;
    },
  };
}

test("Lệnh thành viên và Lead trả lời công khai, vẫn chặn mention ngoài ý muốn", async () => {
  const service = {
    listJobs: async () => ({ jobs: [], page: 1 }),
    listAbsences: async () => ({ absences: [], page: 1 }),
    report: async () => ({
      totals: {},
      absenceTotals: {},
      members: [],
      days: 30,
      page: 1,
    }),
    viewKpi: async () => ({
      userId: "3",
      month: "2026-10",
      earned_points: 0,
      target: null,
      completed: 0,
      on_time: 0,
    }),
  };
  for (const [commandName, action] of [
    ["help", null],
    ["job", "list"],
    ["absence", "list"],
    ["report", null],
    ["kpi", "view"],
  ]) {
    const interaction = fakeInteraction({ commandName, action });
    await interactionHandler({ service, guildId: "1" })(interaction);
    assert.deepEqual(
      interaction.calls.map((call) => call.method),
      ["deferReply", "editReply"],
      commandName,
    );
    assert.equal(interaction.ephemeral, false, commandName);
    assert.deepEqual(interaction.calls[1].options.allowedMentions, {
      parse: [],
    });
  }
});

test("/setup giữ channel đang dùng, không yêu cầu channel riêng cho Lead", async () => {
  const interaction = fakeInteraction({ commandName: "setup" });
  interaction.memberPermissions = { has: () => true };
  const report = { id: "2", permissionsFor: () => ({ has: () => true }) };
  interaction.options.getChannel = (name) =>
    name === "report-channel" ? report : { id: "8" };
  interaction.options.getRole = () => ({ id: "4" });
  let saved = 0;
  const service = {
    configure: async (actor, input) => {
      assert.equal(input.reportChannelId, "2");
      saved++;
    },
  };
  await interactionHandler({ service, guildId: "1" })(interaction);
  assert.equal(interaction.ephemeral, true);
  assert.equal(saved, 1);
});

test("Lệnh cấu hình của quản trị viên vẫn trả lời riêng", async () => {
  const interaction = fakeInteraction({
    commandName: "settings",
    action: "show",
  });
  interaction.memberPermissions = { has: () => true };
  const service = {
    deliveryStatus: async () => ({
      settings: { lead_role_id: "4", report_channel_id: "5", channels: ["2"] },
      counts: { pending: 0, failed: 0 },
    }),
  };
  await interactionHandler({ service, guildId: "1" })(interaction);
  assert.equal(interaction.ephemeral, true);
  assert.deepEqual(
    interaction.calls.map((call) => call.method),
    ["deferReply", "editReply"],
  );
});

test("Kết quả nhận và nộp job vẫn giữ công khai", async () => {
  const service = {
    mutateJob: async () => ({ ...job, status: "in_progress" }),
    requestAbsence: async () => absence,
  };
  for (const config of [
    { kind: "button", customId: "job:accept:1" },
    {
      kind: "modal",
      customId: "job:submit:1",
      inputs: { note: "Sản phẩm đã xong" },
    },
  ]) {
    const interaction = fakeInteraction(config);
    await interactionHandler({ service, guildId: "1" })(interaction);
    assert.deepEqual(
      interaction.calls.map((call) => call.method),
      ["deferReply", "editReply"],
      config.customId,
    );
    assert.equal(interaction.ephemeral, false, config.customId);
  }
});

test("Lỗi quyền sau khi defer công khai được chuyển sang thông báo riêng", async () => {
  const interaction = fakeInteraction({ commandName: "report" });
  const service = {
    report: async () => {
      throw new UserError("Channel này chưa được phép sử dụng bot.");
    },
  };
  await interactionHandler({ service, guildId: "1" })(interaction);
  assert.deepEqual(
    interaction.calls.map((call) => call.method),
    ["deferReply", "editReply", "followUp"],
  );
  assert.equal(
    interaction.calls[1].options.content,
    "❌ Không thể thực hiện yêu cầu.",
  );
  assert.equal(interaction.calls[2].options.flags, MessageFlags.Ephemeral);
  assert.match(interaction.calls[2].options.content, /chưa được phép/);
});

test("Lỗi của lệnh cấu hình giữ nguyên phản hồi riêng", async () => {
  const interaction = fakeInteraction({
    commandName: "settings",
    action: "show",
  });
  interaction.memberPermissions = { has: () => true };
  const service = {
    deliveryStatus: async () => {
      throw new UserError("Chỉ quản trị viên được xem cấu hình.");
    },
  };
  await interactionHandler({ service, guildId: "1" })(interaction);
  assert.equal(interaction.ephemeral, true);
  assert.deepEqual(
    interaction.calls.map((call) => call.method),
    ["deferReply", "editReply"],
  );
});

test("Tạo job chỉ xác nhận riêng cho Lead và không đăng thông tin job ngay", async () => {
  const interaction = fakeInteraction({ commandName: "job", action: "create" });
  interaction.options.getUser = () => ({ id: job.assignee_id });
  interaction.options.getString = (name) =>
    ({ title: "Job riêng", deadline: "2026-10-25 18:00" })[name] ?? null;
  interaction.guild = {
    members: { fetch: async () => ({ user: { bot: false } }) },
  };
  const service = {
    access: async () => {},
    createJob: async () => ({ job, warning: "" }),
  };
  await interactionHandler({ service, guildId: "1" })(interaction);
  assert.equal(interaction.ephemeral, true);
  assert.deepEqual(
    interaction.calls.map((call) => call.method),
    ["deferReply", "editReply"],
  );
  assert.equal(interaction.calls[1].options.embeds, undefined);
});

test("Job chờ nhận chỉ hiện riêng; chỉ người được giao thấy nút nhận/từ chối", async () => {
  for (const assignee of ["3", job.assignee_id]) {
    const interaction = fakeInteraction({ commandName: "job", action: "view" });
    const service = {
      viewJob: async () => ({
        job: { ...job, assignee_id: assignee },
        updates: [],
      }),
    };
    await interactionHandler({ service, guildId: "1" })(interaction);
    assert.equal(interaction.ephemeral, false);
    assert.deepEqual(
      interaction.calls.map((call) => call.method),
      ["deferReply", "editReply", "followUp"],
    );
    assert.deepEqual(interaction.calls[1].options.embeds, []);
    assert.deepEqual(interaction.calls[1].options.components, []);
    assert.equal(interaction.calls[2].options.flags, MessageFlags.Ephemeral);
    assert.equal(
      interaction.calls[2].options.components.length,
      assignee === "3" ? 1 : 0,
    );
  }
});

test("Danh sách có job chờ nhận giữ riêng, job đã nhận vẫn xem công khai như trước", async () => {
  const list = fakeInteraction({ commandName: "job", action: "list" });
  await interactionHandler({
    guildId: "1",
    service: { listJobs: async () => ({ jobs: [job], page: 1 }) },
  })(list);
  assert.deepEqual(
    list.calls.map((call) => call.method),
    ["deferReply", "editReply", "followUp"],
  );
  assert.deepEqual(list.calls[1].options.embeds, []);
  assert.equal(list.calls[2].options.flags, MessageFlags.Ephemeral);
  const view = fakeInteraction({ commandName: "job", action: "view" });
  await interactionHandler({
    guildId: "1",
    service: {
      viewJob: async () => ({
        job: { ...job, status: "in_progress" },
        updates: [],
      }),
    },
  })(view);
  assert.deepEqual(
    view.calls.map((call) => call.method),
    ["deferReply", "editReply"],
  );
  assert.equal(view.ephemeral, false);
  assert.equal(view.calls[1].options.reply, undefined);
  assert.equal(view.calls[1].options.messageReference, undefined);
});

test("Job list/view báo rõ quyền bot khi Discord trả 50001 hoặc 50013", async (t) => {
  const logs = t.mock.method(console, "error", () => {});
  for (const code of [50001, 50013]) {
    for (const action of ["list", "view"]) {
      const interaction = fakeInteraction({ commandName: "job", action });
      const editReply = interaction.editReply;
      interaction.editReply = async function (options) {
        if (options.embeds?.length) {
          throw Object.assign(new Error("Discord error"), { code });
        }
        return editReply.call(this, options);
      };
      const service = {
        listJobs: async () => ({ jobs: [], page: 1 }),
        viewJob: async () => ({
          job: { ...job, status: "in_progress" }, updates: [],
        }),
      };
      await interactionHandler({ service, guildId: "1" })(interaction);
      const response = interaction.calls.at(-1).options;
      assert.ok(response.content.includes(String(code)));
      assert.match(response.content, /View Channel, Send Messages và Embed Links/);
      assert.deepEqual(response.embeds, []);
      assert.deepEqual(response.components, []);
      assert.equal(response.flags, MessageFlags.Ephemeral);
      const log = logs.mock.calls.at(-1).arguments[0];
      assert.ok(log.includes(`command=/job ${action}`));
      assert.match(log, /channel=2 stage=reply/);
    }
  }
});

test("Các lệnh job list/view/decline/accept/update/submit đi hết luồng phản hồi", async () => {
  const ownedJob = { ...job, assignee_id: "3", status: "in_progress" };
  const mutations = [];
  const service = {
    listJobs: async () => ({ jobs: [ownedJob], page: 1 }),
    viewJob: async () => ({ job: ownedJob, updates: [] }),
    mutateJob: async (actor, id, action, input) => {
      assert.equal(actor.userId, "3");
      assert.equal(id, 1);
      mutations.push({ action, input });
      return { ...ownedJob, status: action === "decline" ? "declined" : action === "submit" ? "submitted" : "in_progress" };
    },
  };
  for (const action of ["list", "view", "decline", "accept", "update", "submit"]) {
    const interaction = fakeInteraction({ commandName: "job", action });
    interaction.channel.send = () => assert.fail("Phải trả lời trực tiếp vào lệnh");
    interaction.options.getString = (name) => name === "note" ? "Lý do từ chối" : null;
    await interactionHandler({ service, guildId: "1" })(interaction);
    if (["update", "submit"].includes(action)) {
      assert.deepEqual(interaction.calls.map((call) => call.method), ["showModal"]);
      const modal = fakeInteraction({
        kind: "modal", customId: `job:${action}:1`,
        inputs: { note: "Kết quả công việc", progress: "40", status: "doing", checkin: "" },
      });
      modal.channel.send = () => assert.fail("Phải trả lời trực tiếp vào form");
      await interactionHandler({ service, guildId: "1" })(modal);
      assert.ok(modal.calls.at(-1).options.embeds[0]);
    } else {
      const result = interaction.calls.at(-1);
      assert.equal(result.method, "editReply");
      assert.ok(result.options.embeds[0]);
    }
  }
  assert.deepEqual(mutations.map((entry) => entry.action), ["decline", "accept", "update", "submit"]);
  const update = mutations.find((entry) => entry.action === "update").input;
  assert.equal(update.progress, 40);
  assert.equal(update.status, "in_progress");
});

test("Hủy job phải mở xác nhận riêng, chỉ hủy sau khi Lead bấm xác nhận", async () => {
  const preview = fakeInteraction({ commandName: "job", action: "cancel" });
  preview.options.getString = () => "Không còn cần sản phẩm này";
  let cancelled = 0;
  const service = {
    previewCancellation: async () => ({
      job,
      note: "Không còn cần sản phẩm này",
    }),
    mutateJob: async (actor, id, action, input) => {
      assert.equal(action, "cancel");
      assert.equal(input.note, "Không còn cần sản phẩm này");
      cancelled++;
      return { ...job, status: "cancelled" };
    },
  };
  const handle = interactionHandler({ service, guildId: "1" });
  await handle(preview);
  assert.equal(cancelled, 0);
  assert.equal(preview.ephemeral, true);
  assert.deepEqual(
    preview.calls.map((call) => call.method),
    ["deferReply", "editReply"],
  );
  const body = preview.calls[1].options;
  assert.equal(
    body.components[0].toJSON().components[0].custom_id,
    "job:cancel:1",
  );
  const confirm = fakeInteraction({ kind: "button", customId: "job:cancel:1" });
  confirm.message = { embeds: body.embeds.map((embed) => embed.toJSON()) };
  await handle(confirm);
  assert.equal(cancelled, 1);
  assert.equal(confirm.ephemeral, false);
  assert.deepEqual(
    confirm.calls.map((call) => call.method),
    ["deferReply", "editReply"],
  );
  for (const status of ["assigned", "in_progress", "submitted", "cancelled"]) {
    const ids = jobButtons({ ...job, status }).flatMap((row) =>
      row.toJSON().components.map((button) => button.custom_id),
    );
    assert.equal(
      ids.some((id) => id.includes(":cancel:")),
      false,
    );
  }
});

test("Thành viên không được mở lựa chọn hủy dành cho Lead", async () => {
  const interaction = fakeInteraction({ commandName: "job", action: "cancel" });
  const service = {
    previewCancellation: async () => {
      throw new UserError("Chỉ lead hoặc quản trị viên được thực hiện.");
    },
  };
  await interactionHandler({ service, guildId: "1" })(interaction);
  assert.equal(interaction.ephemeral, true);
  assert.deepEqual(interaction.calls[1].options.components, []);
});

function fakeAssignment(kind, action, userId = job.assignee_id) {
  const interaction = fakeInteraction({
    kind,
    customId: `assignment:${action}:${job.guild_id}:1`,
    inputs: { note: "Đang bận" },
  });
  interaction.inGuild = () => false;
  interaction.user.id = userId;
  interaction.client = {
    guilds: {
      fetch: async () => ({
        members: {
          fetch: async () => ({
            user: { bot: false },
            permissions: { has: () => false },
            roles: { cache: new Map() },
          }),
        },
      }),
    },
  };
  return interaction;
}

test("Nhận/từ chối qua DM dùng đúng server và danh tính người nhận", async () => {
  for (const [kind, action] of [
    ["button", "accept"],
    ["modal", "decline"],
  ]) {
    const interaction = fakeAssignment(kind, action);
    const service = {
      settings: async () => ({ report_channel_id: "2" }),
      mutateJob: async (actor, id, selected) => {
        assert.equal(actor.guildId, job.guild_id);
        assert.equal(actor.userId, job.assignee_id);
        assert.equal(actor.channelId, "2");
        assert.equal(selected, action);
        return {
          ...job,
          status: action === "accept" ? "in_progress" : "declined",
        };
      },
    };
    await interactionHandler({ service, guildId: job.guild_id })(interaction);
    assert.equal(interaction.ephemeral, true);
    assert.deepEqual(
      interaction.calls.map((call) => call.method),
      ["deferReply", "editReply"],
    );
  }
});

test("Từ chối trong DM mở form giữ nguyên mã server và job", async () => {
  const interaction = fakeAssignment("button", "decline");
  let modal;
  interaction.showModal = async (value) => {
    modal = value.toJSON();
  };
  await interactionHandler({ service: {}, guildId: job.guild_id })(interaction);
  assert.equal(modal.custom_id, interaction.customId);
  assert.deepEqual(interaction.calls, []);
});

test("Nút DM sai server hoặc người ngoài không làm thay đổi job", async () => {
  const wrongServer = fakeAssignment("button", "accept");
  let calls = 0;
  const service = {
    settings: async () => ({ report_channel_id: "2" }),
    mutateJob: async () => {
      calls++;
      throw new UserError("Chỉ người được giao job được thực hiện.");
    },
  };
  await interactionHandler({ service, guildId: "100000000000000002" })(
    wrongServer,
  );
  assert.equal(calls, 0);
  assert.equal(wrongServer.calls[0].options.flags, MessageFlags.Ephemeral);
  const outsider = fakeAssignment("button", "accept", "200000000000000002");
  await interactionHandler({ service, guildId: job.guild_id })(outsider);
  assert.equal(calls, 1);
  assert.equal(outsider.ephemeral, true);
  assert.deepEqual(outsider.calls[1].options.components, []);
});

const privateAbsence = {
  ...absence,
  reason: "CONFIDENTIAL REASON",
  review_note: "CONFIDENTIAL REVIEW",
};

test("Đơn gửi channel hiện tại có nội dung và hai nút duyệt, không có bước Mở đơn", () => {
  for (const kind of ["absence", "absence_reminder"]) {
    const view = notificationView(
      {
        kind,
        absence: privateAbsence,
        action: "request",
        impacted: [{ ...job, title: "CONFIDENTIAL JOB" }],
        leadRoleId: "300000000000000001",
      },
      "channel",
    );
    const json = JSON.stringify(view.embeds[0].toJSON());
    assert.ok(json.includes("CONFIDENTIAL REASON"));
    assert.deepEqual(
      view.components[0].toJSON().components.map((button) => button.custom_id),
      ["absence:approve:1", "absence:reject:1"],
    );
    assert.deepEqual(view.allowedMentions.roles, ["300000000000000001"]);
  }
});

test("Kết quả báo bận công khai gồm lý do và phản hồi", () => {
  for (const [status, action] of [
    ["approved", "approve"],
    ["rejected", "reject"],
    ["cancelled", "cancel"],
  ]) {
    const payload = {
      kind: "absence",
      absence: { ...privateAbsence, status },
      action,
      impacted: [job],
    };
    const channel = notificationView(payload, "channel");
    const json = JSON.stringify(channel.embeds.map((embed) => embed.toJSON()));
    assert.ok(json.includes("CONFIDENTIAL REASON"));
    assert.ok(json.includes("CONFIDENTIAL REVIEW"));
    assert.equal(json.includes(absence.user_id), true);
    assert.deepEqual(channel.components, []);
    const dm = notificationView(payload, "dm");
    assert.ok(
      JSON.stringify(dm.embeds[0].toJSON()).includes("CONFIDENTIAL REASON"),
    );
    assert.deepEqual(dm.components, []);
  }
});

test("Mở đơn cũ vẫn kiểm tra quyền và mở phản hồi riêng", async () => {
  const interaction = fakeInteraction({
    kind: "button",
    customId: "absence:review:1",
  });
  const service = {
    reviewAbsence: async (actor, id) => {
      assert.equal(actor.userId, "3");
      assert.equal(id, 1);
      return { absence: privateAbsence, impacted: [job] };
    },
  };
  await interactionHandler({ service, guildId: "1" })(interaction);
  assert.equal(interaction.ephemeral, true);
  assert.deepEqual(
    interaction.calls.map((call) => call.method),
    ["deferReply", "editReply"],
  );
  const response = interaction.calls[1].options;
  assert.ok(
    JSON.stringify(response.embeds[0].toJSON()).includes("CONFIDENTIAL REASON"),
  );
  assert.deepEqual(
    response.components[0]
      .toJSON()
      .components.map((button) => button.custom_id),
    ["absence:approve:1", "absence:reject:1"],
  );
});

test("Thành viên không có quyền xem đơn qua nút Mở đơn cũ", async () => {
  const interaction = fakeInteraction({
    kind: "button",
    customId: "absence:review:1",
  });
  const service = {
    reviewAbsence: async () => {
      throw new UserError("Chỉ lead hoặc quản trị viên được thực hiện.");
    },
  };
  await interactionHandler({ service, guildId: "1" })(interaction);
  assert.equal(interaction.ephemeral, true);
  assert.deepEqual(
    interaction.calls.map((call) => call.method),
    ["deferReply", "editReply"],
  );
  assert.deepEqual(interaction.calls[1].options.embeds, []);
  assert.deepEqual(interaction.calls[1].options.components, []);
});

test("Mở lại đơn đã xử lý không hiển thị nút duyệt lần nữa", async () => {
  const interaction = fakeInteraction({
    kind: "button",
    customId: "absence:review:1",
  });
  const service = {
    reviewAbsence: async () => ({
      absence: { ...privateAbsence, status: "approved" },
      impacted: [],
    }),
  };
  await interactionHandler({ service, guildId: "1" })(interaction);
  assert.equal(interaction.ephemeral, true);
  assert.deepEqual(interaction.calls[1].options.components, []);
});

test("Danh sách báo bận trả lời công khai cả khi có đơn chờ duyệt hoặc đã duyệt", async () => {
  for (const status of ["pending", "approved"]) {
    const interaction = fakeInteraction({
      commandName: "absence",
      action: "list",
    });
    const service = {
      listAbsences: async () => ({
        absences: [{ ...privateAbsence, status }],
        page: 1,
      }),
    };
    await interactionHandler({ service, guildId: "1" })(interaction);
    assert.equal(interaction.ephemeral, false);
    assert.deepEqual(
      interaction.calls.map((call) => call.method),
      ["deferReply", "editReply"],
    );
    const response = interaction.calls[1].options;
    const json = JSON.stringify(response.embeds[0].toJSON());
    assert.ok(json.includes("CONFIDENTIAL REASON"));
    assert.ok(json.includes("CONFIDENTIAL REVIEW"));
    assert.equal(response.components?.length ?? 0, 0);
  }
});

test("Thao tác duyệt, từ chối và hủy báo bận trả lời công khai", async () => {
  const service = {
    mutateAbsence: async () => ({ ...privateAbsence, status: "approved" }),
  };
  for (const config of [
    { commandName: "absence", action: "approve" },
    { commandName: "absence", action: "reject" },
    { commandName: "absence", action: "cancel" },
    { kind: "button", customId: "absence:approve:1" },
    {
      kind: "modal",
      customId: "absence:reject:1",
      inputs: { note: "CONFIDENTIAL REVIEW" },
    },
  ]) {
    const interaction = fakeInteraction(config);
    await interactionHandler({ service, guildId: "1" })(interaction);
    assert.equal(interaction.ephemeral, false);
    assert.deepEqual(
      interaction.calls.map((call) => call.method),
      ["deferReply", "editReply"],
    );
  }
});
