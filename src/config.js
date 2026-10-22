import "dotenv/config";
import { readFileSync } from "node:fs";

function required(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Thiếu ${key}. Hãy cấu hình file .env.`);
  return value;
}

function integer(value, fallback, min, max, name) {
  const number = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} phải là số nguyên từ ${min} đến ${max}.`);
  }
  return number;
}

export function databaseConfig(env = process.env) {
  return {
    host: env.MYSQL_HOST || "127.0.0.1",
    port: integer(env.MYSQL_PORT, 3306, 1, 65535, "MYSQL_PORT"),
    user: required(env, "MYSQL_USER"),
    password: env.MYSQL_PASSWORD || "",
    database: required(env, "MYSQL_DATABASE"),
    ...(env.MYSQL_SSL === "true"
      ? {
          ssl: {
            rejectUnauthorized: true,
            ...(env.MYSQL_SSL_CA_FILE
              ? { ca: readFileSync(env.MYSQL_SSL_CA_FILE, "utf8") }
              : {}),
          },
        }
      : {}),
  };
}

export function discordConfig(env = process.env) {
  const token = required(env, "DISCORD_TOKEN");
  const clientId = required(env, "DISCORD_CLIENT_ID");
  const guildId = required(env, "DISCORD_GUILD_ID");
  if (![clientId, guildId].every((id) => /^\d{17,20}$/.test(id))) {
    throw new Error(
      "DISCORD_CLIENT_ID và DISCORD_GUILD_ID phải là Discord ID.",
    );
  }
  return {
    token,
    clientId,
    guildId,
    intervalMs:
      integer(
        env.WORKER_INTERVAL_SECONDS,
        60,
        5,
        3600,
        "WORKER_INTERVAL_SECONDS",
      ) * 1000,
  };
}