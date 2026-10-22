import mysql from "mysql2/promise";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";

export function createPool(config) {
  const pool = mysql.createPool({
    ...config,
    timezone: "Z",
    charset: "utf8mb4",
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 100,
    supportBigNumbers: true,
    // Số BIGINT an toàn (COUNT, GET_LOCK) là Number; số quá lớn vẫn thành chuỗi.
    bigNumberStrings: false,
    multipleStatements: false,
  });
  return pool;
}

export function lockName(database, purpose) {
  return `jobbot:${purpose}:${createHash("sha256").update(database).digest("hex").slice(0, 32)}`;
}

// Chỉ dùng connection này trong callback, tránh rơi truy vấn ra ngoài transaction.
export async function transaction(pool, callback) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function migrate(pool, database) {
  const connection = await pool.getConnection();
  const name = lockName(database, "migrate");
  let locked = false;
  try {
    const [[row]] = await connection.execute(
      "SELECT GET_LOCK(?, 10) AS acquired",
      [name],
    );
    if (Number(row.acquired) !== 1)
      throw new Error("Không lấy được khóa migration.");
    locked = true;
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(190) PRIMARY KEY, applied_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    const directory = new URL("../database/migrations/", import.meta.url);
    const files = (await readdir(directory))
      .filter((file) => /^\d+.*\.sql$/.test(file))
      .sort();
    for (const file of files) {
      const [[applied]] = await connection.execute(
        "SELECT name FROM schema_migrations WHERE name = ?",
        [file],
      );
      if (applied) continue;
      const sql = await readFile(new URL(file, directory), "utf8");
      // Migration hiện tại chỉ có DDL đơn giản, không chứa stored procedure.
      for (const statement of sql
        .split(/;\s*(?:\r?\n|$)/)
        .filter((part) => part.trim())) {
        await connection.query(statement);
      }
      await connection.execute(
        "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
        [file, new Date()],
      );
      console.log(`Đã áp dụng migration ${file}`);
    }
  } finally {
    if (locked) await connection.execute("SELECT RELEASE_LOCK(?)", [name]);
    connection.release();
  }
}