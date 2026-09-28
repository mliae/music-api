-- 中央音乐解析服务：曲库 + ApiKey 授权 + 管理密码 + 设置
CREATE TABLE IF NOT EXISTS tracks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL DEFAULT '',
  artist     TEXT NOT NULL DEFAULT '',
  album      TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT '', -- netease / qq / kugou / kuwo / qishui / upload / url
  source_id  TEXT NOT NULL DEFAULT '',
  vip        INTEGER NOT NULL DEFAULT 0,      -- 0=免费 1=平台标为 VIP/付费
  audio_key  TEXT NOT NULL DEFAULT '',        -- R2 object key（music/audio-*）
  cover_key  TEXT NOT NULL DEFAULT '',        -- R2 object key（music/cover-*）
  lyric      TEXT NOT NULL DEFAULT '',        -- LRC 原文
  duration   INTEGER NOT NULL DEFAULT 0,      -- 秒
  enabled    INTEGER NOT NULL DEFAULT 1,
  tag        TEXT NOT NULL DEFAULT '',        -- 歌单分组标签
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tracks_enabled ON tracks (enabled, id);
CREATE INDEX IF NOT EXISTS idx_tracks_tag ON tracks (tag);
CREATE INDEX IF NOT EXISTS idx_tracks_source ON tracks (source, source_id);

-- 消费方授权：一项目一 Key，可启停，统计调用量
CREATE TABLE IF NOT EXISTS api_keys (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL DEFAULT '',        -- 项目备注，如「博客 jxe.me」
  api_key    TEXT NOT NULL UNIQUE,            -- mk_xxxxxxxx
  enabled    INTEGER NOT NULL DEFAULT 1,
  calls      INTEGER NOT NULL DEFAULT 0,      -- 累计调用次数
  last_used  TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 管理密码哈希（与博客 admin_auth 同构）
CREATE TABLE IF NOT EXISTS admin_auth (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 服务设置（r2_domain 等）
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
