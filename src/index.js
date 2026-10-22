import { Client, Events, GatewayIntentBits } from "discord.js";
import { databaseConfig, discordConfig } from "./config.js";
import { createPool } from "./database.js";
import { JobService } from "./service.js";
import { interactionHandler } from "./interactions.js";
import { startWorker } from "./worker.js";

let client;
let pool;
let stopWorker;
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (stopWorker) await stopWorker();
  client?.destroy();
  if (pool) await pool.end();
}

try {
  const discord = discordConfig();
  const database = databaseConfig();
  pool = createPool(database);
  await pool.execute("SELECT 1 FROM schema_migrations LIMIT 1");
  // Slash command và nút bấm không cần Message Content / Members privileged intent.
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    allowedMentions: { parse: [] },
  });
  const service = new JobService(pool);
  client.on(
    Events.InteractionCreate,
    interactionHandler({ service, guildId: discord.guildId }),
  );
  client.on(Events.Error, (error) =>
    console.error(`Discord client gặp lỗi (${error.code || error.name}).`),
  );
  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Đăng nhập thành công: ${readyClient.user.tag}`);
    stopWorker = startWorker({
      pool,
      client,
      database: database.database,
      intervalMs: discord.intervalMs,
    });
  });
  process.once("SIGINT", () => {
    shutdown().catch(() => {
      process.exitCode = 1;
    });
  });
  process.once("SIGTERM", () => {
    shutdown().catch(() => {
      process.exitCode = 1;
    });
  });
  await client.login(discord.token);
} catch (error) {
  console.error(
    `Không khởi động được bot (${error.code || error.message}). Kiểm tra .env và chạy npm run db:migrate.`,
  );
  process.exitCode = 1;
  await shutdown();
}