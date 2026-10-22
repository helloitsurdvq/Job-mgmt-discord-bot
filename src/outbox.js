import { randomUUID } from "node:crypto";

export async function enqueue(
  connection,
  guildId,
  destination,
  targetId,
  payload,
  key = randomUUID(),
  now = new Date(),
) {
  // UNIQUE event_key chống xếp cùng một lịch nhắc nhiều lần khi worker chạy lại.
  await connection.execute(
    `INSERT INTO notification_outbox
    (guild_id, event_key, destination, target_id, payload, available_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE event_key = event_key`,
    [guildId, key, destination, targetId, JSON.stringify(payload), now, now],
  );
}

export function decodePayload(value) {
  return typeof value === "string" ? JSON.parse(value) : value;
}