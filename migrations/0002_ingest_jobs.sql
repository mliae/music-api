-- 异步入库任务：进度轮询的单一事实源
CREATE TABLE IF NOT EXISTS ingest_jobs (
  id         TEXT PRIMARY KEY,                 -- 短随机 job_id
  status     TEXT NOT NULL DEFAULT 'running',  -- running | done | error | duplicate
  stage      INTEGER NOT NULL DEFAULT 0,       -- 当前步骤 0-4
  error      TEXT NOT NULL DEFAULT '',
  result_id  INTEGER,                          -- 成功后的 tracks.id
  via        TEXT NOT NULL DEFAULT '',         -- 音源途径
  payload    TEXT NOT NULL DEFAULT '{}',       -- 入库参数快照（重试可重放）
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
