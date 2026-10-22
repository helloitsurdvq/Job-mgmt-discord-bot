import { REST, Routes } from "discord.js";
import { discordConfig } from "../src/config.js";
import { commands } from "../src/commands.js";

try {
  const config = discordConfig();
  const rest = new REST({ version: "10" }).setToken(config.token);
  await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.guildId),
    {
      body: commands.map((command) => command.toJSON()),
    },
  );
  console.log(
    `Đã đăng ký ${commands.length} nhóm lệnh cho server ${config.guildId}.`,
  );
} catch (error) {
  console.error(`Đăng ký lệnh thất bại: ${error.code || error.message}`);
  process.exitCode = 1;
}