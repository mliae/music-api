/** D1 schema 幂等初始化 + 通用小工具（与博客同款模式） */

// 注意：D1 binding 的 exec() 对多语句解析不稳定，逐条 prepare 执行
const SCHEMA_STMTS = [
  `CREATE TABLE IF NOT EXISTS tracks (
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
)`,
  "CREATE INDEX IF NOT EXISTS idx_tracks_enabled ON tracks (enabled, id)",
  "CREATE INDEX IF NOT EXISTS idx_tracks_tag ON tracks (tag)",
  "CREATE INDEX IF NOT EXISTS idx_tracks_source ON tracks (source, source_id)",
  `CREATE TABLE IF NOT EXISTS api_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL DEFAULT '',
  api_key    TEXT NOT NULL UNIQUE,
  enabled    INTEGER NOT NULL DEFAULT 1,
  calls      INTEGER NOT NULL DEFAULT 0,
  last_used  TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`,
  `CREATE TABLE IF NOT EXISTS admin_auth (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`,
  `CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
)`,
  `CREATE TABLE IF NOT EXISTS tags (
  name       TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`,
  // 曲目-标签 多对多：一首歌可同时属于多个标签（歌单）
  `CREATE TABLE IF NOT EXISTS track_tags (
  track_id   INTEGER NOT NULL,
  tag        TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (track_id, tag)
)`,
  "CREATE INDEX IF NOT EXISTS idx_track_tags_tag ON track_tags (tag)",
  "CREATE INDEX IF NOT EXISTS idx_track_tags_track ON track_tags (track_id)",
];

let schemaPromise: Promise<void> | null = null;

/** 首次请求时幂等建表/补表（每个 isolate 只跑一次） */
export function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      for (const sql of SCHEMA_STMTS) await db.prepare(sql).run();
      // 老库升级：tracks 中已有的单标签迁入关联表；补齐 tags 表（均幂等）
      await db
        .prepare("INSERT OR IGNORE INTO track_tags (track_id, tag) SELECT id, tag FROM tracks WHERE tag <> ''")
        .run();
      await db
        .prepare("INSERT OR IGNORE INTO tags (name) SELECT DISTINCT tag FROM tracks WHERE tag <> ''")
        .run();
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
