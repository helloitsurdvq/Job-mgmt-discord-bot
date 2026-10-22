CREATE TABLE IF NOT EXISTS kpi_targets (
  guild_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  month CHAR(7) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_points INT UNSIGNED NOT NULL,
  setter_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (guild_id, user_id, month),
  FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id),
  CHECK (
    target_points BETWEEN 1 AND 1000000
  )
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;