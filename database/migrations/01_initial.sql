-- Tất cả ngày giờ được lưu ở UTC. Discord ID là chuỗi, không phải JS Number.
CREATE TABLE IF NOT EXISTS guild_settings (
  guild_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  lead_role_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  report_channel_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS command_channels (
  guild_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  channel_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (guild_id, channel_id),
  FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS jobs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  guild_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  creator_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  assignee_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title VARCHAR(150) NOT NULL,
  description TEXT NOT NULL,
  status ENUM(
    'assigned',
    'in_progress',
    'blocked',
    'submitted',
    'completed',
    'declined',
    'cancelled'
  ) NOT NULL DEFAULT 'assigned',
  points INT UNSIGNED NOT NULL DEFAULT 1,
  progress TINYINT UNSIGNED NOT NULL DEFAULT 0,
  due_at DATETIME(3) NOT NULL,
  next_checkin_at DATETIME(3) NOT NULL,
  submitted_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CHECK (progress <= 100),
  CHECK (
    points BETWEEN 1 AND 1000
  ),
  FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id),
  INDEX idx_jobs_assignee (guild_id, assignee_id, status),
  INDEX idx_jobs_due (guild_id, status, due_at),
  INDEX idx_jobs_checkin (guild_id, status, next_checkin_at),
  INDEX idx_jobs_completed (guild_id, completed_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS job_updates (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  job_id INT UNSIGNED NOT NULL,
  actor_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action VARCHAR(40) NOT NULL,
  note TEXT NOT NULL,
  progress TINYINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id),
  INDEX idx_updates_job (job_id, id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS absences (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  guild_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  starts_at DATETIME(3) NOT NULL,
  ends_at DATETIME(3) NOT NULL,
  reason TEXT NOT NULL,
  status ENUM('pending', 'approved', 'rejected', 'cancelled') NOT NULL DEFAULT 'pending',
  reviewer_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL,
  review_note TEXT NULL,
  reviewed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CHECK (ends_at > starts_at),
  FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id),
  INDEX idx_absences_user (guild_id, user_id, status, ends_at),
  INDEX idx_absences_pending (guild_id, status, created_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS audit_logs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  guild_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  entity_type VARCHAR(20) NOT NULL,
  entity_id VARCHAR(30) NOT NULL,
  action VARCHAR(40) NOT NULL,
  details JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id),
  INDEX idx_audit_entity (guild_id, entity_type, entity_id, id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
-- Transactional outbox: ghi dữ liệu nghiệp vụ và thông báo trong cùng transaction.
CREATE TABLE IF NOT EXISTS notification_outbox (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  guild_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_key VARCHAR(190) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  destination ENUM('channel', 'dm') NOT NULL,
  target_id VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload JSON NOT NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  available_at DATETIME(3) NOT NULL,
  delivered_at DATETIME(3) NULL,
  failed_at DATETIME(3) NULL,
  last_error VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL,
  FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id),
  INDEX idx_outbox_pending (delivered_at, failed_at, available_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;