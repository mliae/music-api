/**
 * 公开读取 API（无需鉴权，供消费方前端 / <audio> 直接用）：
 *   GET /track/:id        曲目元数据（卡片渲染）
 *   GET /playlist.json    胶囊播放器歌单（纯数组，lrc 为内联文本）
 *   GET /media/*          R2 音频/封面输出（见 media.ts）
 */
import { Hono } from "hono";
import { ok } from "../respond";
import type { HonoEnv } from "../types";
import { keyToUrl, getSetting } from "../db";

const app = new Hono<HonoEnv>();

/** 曲目元数据：GET /track/:id（:id 可带 t 前缀） */
app.get("/track/:id", async c => {
  const raw = c.req.param("id") || "";
  const m = /^t?(\d+)$/.exec(raw);
  if (!m) return ok(c, { title: "", artist: "", cover: "", url: "", lyric: "", available: false }, "无效的曲目 ID");
  const row = await c.env.DB.prepare("SELECT title, artist, audio_key, cover_key, lyric, enabled FROM tracks WHERE id = ?")
    .bind(Number(m[1]))
    .first<{ title: string; artist: string; audio_key: string; cover_key: string; lyric: string; enabled: number }>();
  if (!row || !row.enabled) {
    return ok(c, { title: "", artist: "", cover: "", url: "", lyric: "", available: false }, "曲目不存在或已停用");
  }
  const origin = new URL(c.req.url).origin;
  const r2Domain = await getSetting(c.env.DB, "r2_domain");
  return ok(c, {
    title: row.title,
    artist: row.artist || "未知歌手",
    cover: row.cover_key ? keyToUrl(row.cover_key, r2Domain, origin) : "",
    url: row.audio_key ? keyToUrl(row.audio_key, r2Domain, origin) : "",
    lyric: row.lyric || "",
    available: true,
  });
});

/** 胶囊播放器歌单：GET /playlist.json[?tag=xxx] → [{ id, name, artist, url, pic, lrc }] */
app.get("/playlist.json", async c => {
  const origin = new URL(c.req.url).origin;
  const r2Domain = await getSetting(c.env.DB, "r2_domain");
  const tag = (c.req.query("tag") || "").trim().slice(0, 30);
  const { results } = tag
    ? await c.env.DB.prepare(
        "SELECT id, title, artist, audio_key, cover_key, lyric FROM tracks WHERE enabled = 1 AND tag = ? ORDER BY id DESC LIMIT 500"
      )
        .bind(tag)
        .all<{ id: number; title: string; artist: string; audio_key: string; cover_key: string; lyric: string }>()
    : await c.env.DB.prepare(
        "SELECT id, title, artist, audio_key, cover_key, lyric FROM tracks WHERE enabled = 1 ORDER BY id DESC LIMIT 500"
      ).all<{ id: number; title: string; artist: string; audio_key: string; cover_key: string; lyric: string }>();
  const list = (results || []).map(r => ({
    id: `t${r.id}`,
    name: r.title,
    artist: r.artist || "未知歌手",
    url: r.audio_key ? keyToUrl(r.audio_key, r2Domain, origin) : "",
    pic: r.cover_key ? keyToUrl(r.cover_key, r2Domain, origin) : "",
    lrc: r.lyric || "",
  }));
  return c.json(list, 200, { "Cache-Control": "public, max-age=60, s-maxage=300" });
});

export default app;
