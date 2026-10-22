import { databaseConfig } from "../src/config.js";
import { createPool } from "../src/database.js";

let pool;
try {
  const config = databaseConfig();
  const { host, port, user, database } = config;
  // Log only the connection destination; never print the password or full config.
  console.log(`Kiểm tra MySQL: ${JSON.stringify({ host, port, user, database })}`);
  pool = createPool({ ...config, connectTimeout: 10_000 });
  await pool.execute("SELECT 1");
  console.log("Kết nối MySQL thành công. Chưa chạy migration hoặc thay đổi dữ liệu.");
} catch (error) {
  console.error(`Kiểm tra MySQL thất bại: ${error.code || "CONFIGURATION_ERROR"}`);
  if (error.code === "ER_ACCESS_DENIED_ERROR") {
    console.error(
      "Kiểm tra MYSQL_USER, MYSQL_PASSWORD và host được phép của tài khoản MySQL trong /opt/eishin-flash/shared/.env. Quyền root SSH không thay thế thông tin đăng nhập MySQL.",
    );
  } else if (error.code === "ER_DBACCESS_DENIED_ERROR") {
    console.error("Tài khoản MySQL chưa được cấp quyền vào MYSQL_DATABASE.");
  } else if (error.code === "ER_BAD_DB_ERROR") {
    console.error("MYSQL_DATABASE chưa tồn tại hoặc tên database không đúng.");
  } else {
    console.error("Kiểm tra cấu hình MYSQL_* trong .env, dịch vụ MySQL và cổng kết nối.");
  }
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
