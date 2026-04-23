'use strict';
require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db;

function getDb() {
  if (!db) {
    const dbPath = process.env.DB_PATH || './data/ota.db';
    const dir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initSchema() {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id       TEXT NOT NULL UNIQUE,
      hostname        TEXT NOT NULL,
      os_version      TEXT NOT NULL,
      current_version TEXT NOT NULL DEFAULT '0.0.0',
      auth_token_hash TEXT NOT NULL,
      registered_at   TEXT NOT NULL,
      last_seen       TEXT,
      is_active       INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS packages (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      package_name        TEXT NOT NULL,
      version             TEXT NOT NULL UNIQUE,
      target_services     TEXT NOT NULL DEFAULT '[]',
      filename            TEXT NOT NULL UNIQUE,
      sha256_hash         TEXT NOT NULL,
      file_size           INTEGER NOT NULL,
      uploaded_at         TEXT NOT NULL,
      is_active           INTEGER NOT NULL DEFAULT 1,
      release_notes       TEXT,
      min_client_version  TEXT NOT NULL DEFAULT '0.0.0',
      rollout_percentage  INTEGER NOT NULL DEFAULT 100
    );

    CREATE TABLE IF NOT EXISTS package_file_mappings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id  INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
      source_path TEXT NOT NULL,
      dest_path   TEXT NOT NULL,
      file_type   TEXT NOT NULL DEFAULT 'binary',
      backup      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL,
      updated_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS update_jobs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id       TEXT NOT NULL REFERENCES devices(device_id),
      package_id      INTEGER NOT NULL REFERENCES packages(id),
      status          TEXT NOT NULL DEFAULT 'pending',
      created_at      TEXT NOT NULL,
      updated_at      TEXT,
      error_message   TEXT,
      attempt_count   INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_devices_device_id ON devices(device_id);
    CREATE INDEX IF NOT EXISTS idx_devices_token_hash ON devices(auth_token_hash);
    CREATE INDEX IF NOT EXISTS idx_packages_version ON packages(version);
    CREATE INDEX IF NOT EXISTS idx_file_mappings_pkg ON package_file_mappings(package_id);
    CREATE INDEX IF NOT EXISTS idx_update_jobs_device ON update_jobs(device_id);
    CREATE INDEX IF NOT EXISTS idx_update_jobs_status ON update_jobs(status);
  `);
}

module.exports = { getDb, initSchema };
