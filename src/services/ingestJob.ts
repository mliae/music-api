/**
 * 异步入库任务：执行器 + 任务表读写
 *
 * 五步真实进度（onStage 回调）：
 *   0 解析音源（汽水 parse + 元数据归一）
 *   1 下载音频（聚合换源 resolveAudio）
 *   2 获取封面与歌词
 *   3 上传到存储（R2 put）
 *   4 写入曲库（D1 insert）
 * 任务状态 running | done | error | duplicate 落 ingest_jobs，轮询只读该表。
 */
import type { Env } from "../types";
import { AUDIO_MIME, audioExt, downloadCover, fetchLyric, newKey, resolveAudio } from "./ingest";
import { parseQishui, type ParsedQishui } from "../platforms/qishui";
import type { MusicSource } from "../platforms/types";

export const INGEST_STAGES = ["解析音源", "下载音频", "获取封面与歌词", "上传到存储", "写入曲库"] as const;
/** 超过此时长仍在 running，视为被运行时强杀，轮询端收敛为失败 */
export const JOB_TIMEOUT_MS = 90_000;

export interface IngestBody {
  source: MusicSource;
  songId: string;
  title?: string;
  artist?: string;
  album?: string;
  cover?: string;
  vip?: boolean | number;
  duration?: number;
}

export type IngestResult =
  | { id: number; duplicate: true; title: string }
  | { id: number; duplicate: false; via: string; title: string };

/** 入库核心链路（同步 /ingest 与异步任务共用，保证两条路径行为一致） */
export async function performIngest(
  env: Env,
  body: IngestBody,
  onStage?: (idx: number) => void
): Promise<IngestResult> {
  const { DB, R2 } = env;
  const source = body.source;
  const songId = String(body.songId ?? "").trim();

  // 同源同 ID 防重复（任务在第一步之前直接收敛为 duplicate）
  const dup = await DB.prepare("SELECT id FROM tracks WHERE source = ? AND source_id = ?")
    .bind(source, songId)
    .first<{ id: number }>();
  if (dup) return { id: dup.id, duplicate: true, title: "" };

  // 步骤 0：汽水先解析拿元数据（歌名/歌手/专辑/封面/歌词/时长以解析为准）
  onStage?.(0);
  let qishuiParsed: ParsedQishui | null = null;
  if (source === "qishui") {
    qishuiParsed = await parseQishui(songId).catch(() => null);
    if (!qishuiParsed) throw new Error("汽水解析失败：歌曲不存在或已下架");
  }

  const title = String(body.title ?? "").trim() || qishuiParsed?.title || "";
  const artist = String(body.artist ?? "").trim() || qishuiParsed?.artist || "";
  const album = String(body.album ?? "").trim() || qishuiParsed?.album || "";
  const coverUrl = String(body.cover ?? "").trim() || qishuiParsed?.cover || "";
  const vip = body.vip ? 1 : qishuiParsed?.vip_only ? 1 : 0;
  const duration = Number(body.duration ?? 0) || qishuiParsed?.duration_s || 0;
  if (!title) throw new Error("缺少歌名");

  // 步骤 1：聚合解析 + 下载音频
  onStage?.(1);
  const resolved = await resolveAudio(songId, source, title, artist, qishuiParsed);
  if (!resolved) throw new Error("解析失败：所有音源均不可用（VIP 付费或已下架），未入库");

  // 步骤 2：封面与歌词
  onStage?.(2);
  const [coverRes, lyric] = await Promise.all([
    downloadCover(coverUrl, source, songId, title, artist, qishuiParsed),
    fetchLyric(source, songId, title, artist, qishuiParsed),
  ]);

  // 步骤 3：音频/封面上传 R2
  onStage?.(3);
  const ext = audioExt(resolved.buf);
  const audioKey = newKey("audio", ext);
  await R2.put(audioKey, resolved.buf, {
    httpMetadata: { contentType: AUDIO_MIME[ext] || "audio/mpeg" },
  });
  let coverKey = "";
  if (coverRes) {
    coverKey = newKey("cover", coverRes.ext);
    await R2.put(coverKey, coverRes.buf, {
      httpMetadata: { contentType: `image/${coverRes.ext === "jpg" ? "jpeg" : coverRes.ext}` },
    });
  }

  // 步骤 4：写入曲库
  onStage?.(4);
  const r = await DB.prepare(
    "INSERT INTO tracks (title, artist, album, source, source_id, vip, audio_key, cover_key, lyric, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(title, artist, album, source, songId, vip, audioKey, coverKey, lyric, duration)
    .run();
  return { id: r.meta.last_row_id as number, duplicate: false, via: resolved.via, title };
}

/** 生成短随机 job_id（只含小写字母数字，防猜测） */
function newJobId(): string {
  const t = Date.now().toString(36).slice(-5);
  const r = Math.random().toString(36).slice(2, 10);
  return t + r;
}

/** 创建任务（running + 参数快照），返回 job_id */
export async function createJob(db: D1Database, payload: IngestBody): Promise<string> {
  const id = newJobId();
  await db
    .prepare("INSERT INTO ingest_jobs (id, status, stage, payload) VALUES (?, 'running', 0, ?)")
    .bind(id, JSON.stringify(payload))
    .run();
  return id;
}

/** 后台执行任务；异常与成功都收敛为终态，不会留下 running（除非运行时强杀） */
export async function runIngestJob(env: Env, jobId: string): Promise<void> {
  const row = await env.DB.prepare("SELECT payload FROM ingest_jobs WHERE id = ?")
    .bind(jobId)
    .first<{ payload: string }>();
  if (!row) return;
  const payload = JSON.parse(row.payload || "{}") as IngestBody;
  try {
    const result = await performIngest(env, payload, idx => {
      env.DB.prepare("UPDATE ingest_jobs SET stage = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND status = 'running'")
        .bind(idx, jobId)
        .run()
        .catch(() => {});
    });
    if (result.duplicate) {
      await env.DB.prepare("UPDATE ingest_jobs SET status = 'duplicate', result_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .bind(result.id, jobId)
        .run();
    } else {
      await env.DB.prepare("UPDATE ingest_jobs SET status = 'done', stage = 4, result_id = ?, via = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
        .bind(result.id, result.via || "", jobId)
        .run();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "未知错误";
    await env.DB.prepare("UPDATE ingest_jobs SET status = 'error', error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .bind(msg, jobId)
      .run()
      .catch(() => {});
  }
}

export interface JobView {
  id: string;
  status: string;
  stage: number;
  error: string;
  result_id: number | null;
  via: string;
  created_at: string;
}

/** 读任务；running 超过 90s 收敛为 error（被运行时时限强杀的兜底，保证状态闭环） */
export async function getJob(db: D1Database, jobId: string): Promise<JobView | null> {
  const row = await db.prepare(
    "SELECT id, status, stage, error, result_id, via, created_at FROM ingest_jobs WHERE id = ?"
  )
    .bind(jobId)
    .first<JobView>();
  if (!row) return null;
  if (row.status === "running" && Date.now() - Date.parse(row.created_at) > JOB_TIMEOUT_MS) {
    row.status = "error";
    row.error = "任务超时（服务端执行超时或被中断），请重试";
    await db.prepare("UPDATE ingest_jobs SET status = 'error', error = ? WHERE id = ? AND status = 'running'")
      .bind(row.error, jobId)
      .run()
      .catch(() => {});
  }
  return row;
}
