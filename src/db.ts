/** D1 schema 幂等初始化 + 通用小工具（与博客同款模式） */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tracks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL DEFAULT '',
  artist     TEXT NOT NULL DEFAULT '',
  album      TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT '',
  source_id  TEXT NOT NULL DEFAULT '',
  vip        INTEGER NOT NULL DEFAULT 0,
  audio_key  TEXT NOT NULL DEFAULT '',
  cover_key  TEXT NOT NULL DEFAULT '',
  lyric      TEXT NOT NULL DEFAULT '',
  duration   INTEGER NOT NULL DEFAULT 0,
  enabled    INTEGER NOT NULL DEFAULT 1,
  tag        TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tracks_enabled ON tracks (enabled, id);
CREATE INDEX IF NOT EXISTS idx_tracks_tag ON tracks (tag);
CREATE INDEX IF NOT EXISTS idx_tracks_source ON tracks (source, source_id);
CREATE TABLE IF NOT EXISTS api_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL DEFAULT '',
  api_key    TEXT NOT NULL UNIQUE,
  enabled    INTEGER NOT NULL DEFAULT 1,
  calls      INTEGER NOT NULL DEFAULT 0,
  last_used  TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS admin_auth (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
`;

let schemaPromise: Promise<void> | null = null;

/** 首次请求时检测并建表（与 wrangler d1 migrations apply 幂等共存） */
export function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const row = await db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tracks'")
        .first<{ name: string }>();
      if (row?.name) return;
      await db.exec(SCHEMA_SQL);
    })().catch(err => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

/** R2 key → 可访问 URL：r2_domain 有值走自定义域名，否则走本服务 /media/ 代理（绝对地址） */
export function keyToUrl(keyOrUrl: string, r2Domain: string, origin: string): string {
  if (/^https?:\/\//i.test(keyOrUrl)) return keyOrUrl;
  const encoded = keyOrUrl.split("/").map(encodeURIComponent).join("/");
  if (r2Domain) return `${r2Domain.replace(/\/$/, "")}/${encoded}`;
  return `${origin}/media/${encoded}`;
}

export async function getSetting(db: D1Database, key: string): Promise<string> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value || "";
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}
