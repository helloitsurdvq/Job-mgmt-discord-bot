import { databaseConfig } from "../src/config.js";
import { createPool, migrate } from "../src/database.js";

const config = databaseConfig();
const pool = createPool(config);
try {
  await migrate(pool, config.database);
  console.log("Database đã sẵn sàng.");
} catch (error) {
  console.error(`Migration thất bại: ${error.code || error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}