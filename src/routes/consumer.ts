/**
 * 消费方 API（X-Api-Key 鉴权）：
 *   GET  /search?kw=            五平台聚合搜索
 *   GET  /resolve?source=&id=   试听地址解析
 *   POST /ingest                搜索结果入库
 *   POST /ingest/upload         本地上传入库
 *   POST /ingest/url            网络地址转存
 *   GET  /library               曲库列表
 *   POST /library/tag|fill|edit|toggle|delete
 * 同一组 handler 也会被 /admin/api 复用（cookie 鉴权），实现后台曲库管理。
 */
import { Hono } from "hono";
import { ok, fail } from "../respond";
import type { HonoEnv } from "../types";
import { keyToUrl, getSetting } from "../db";
import { SOURCES, type MusicSource, type SearchHit } from "../platforms/types";
import { searchNetease } from "../platforms/netease";
import { searchQQ } from "../platforms/qq";
import { searchKugou } from "../platforms/kugou";
import { searchKuwo } from "../platforms/kuwo";
import { searchQishui, parseQishui, type ParsedQishui } from "../platforms/qishui";
import {
  AUDIO_MIME,
  MAX_AUDIO_BYTES,
  audioExt,
  downloadCover,
  fetchLyric,
  looksLikeImage,
  newKey,
  resolveAudio,
  resolvePreviewUrl,
} from "../services/ingest";
import { UA } from "../platforms/types";

const app = new Hono<HonoEnv>();

const SOURCE_LABEL: Record<string, string> = {
  netease: "网易云",
  qq: "QQ",
  kugou: "酷狗",
  kuwo: "酷我",
  qishui: "汽水",
  upload: "本地上传",
  url: "网络地址",
};

function parseSource(v: unknown): MusicSource | null {
  return (SOURCES as readonly string[]).includes(String(v)) ? (v as MusicSource) : null;
}

/** 五平台聚合搜索：GET /search?kw=xxx */
app.get("/search", async c => {
  const kw = (c.req.query("kw") || "").trim();
  if (!kw) return fail(c, "请输入搜索关键词", 400);
  const [netease, qq, kugou, kuwo, qishui] = await Promise.all([
    searchNetease(kw),
    searchQQ(kw),
    searchKugou(kw),
    searchKuwo(kw),
    searchQishui(kw).catch(() => [] as SearchHit[]),
  ]);
  return ok(c, { netease, qq, kugou, kuwo, qishui });
});

/** 试听地址解析：GET /resolve?source=&id=&title=&artist= */
app.get("/resolve", async c => {
  const source = parseSource(c.req.query("source") || "netease");
  const id = (c.req.query("id") || "").trim();
  if (!source || !id || !/^[A-Za-z0-9_-]+$/.test(id)) return fail(c, "参数错误", 400);
  const title = (c.req.query("title") || "").trim();
  const artist = (c.req.query("artist") || "").trim();
  const url = await resolvePreviewUrl(source, id, title, artist);
  if (!url) return fail(c, "未找到可用音源，无法试听", 404);
  return ok(c, { url });
});

/** 搜索结果入库：POST /ingest { source, songId, title?, artist?, album?, cover?, vip?, duration? } */
app.post("/ingest", async c => {
  const body = await c.req.json().catch(() => null);
  const source = parseSource(body?.source);
  const songId = String(body?.songId ?? body?.id ?? "").trim();
  if (!source) return fail(c, "未知来源", 400);
  if (!songId) return fail(c, "参数错误", 400);

  // 同源同 ID 防重复
  const dup = await c.env.DB.prepare("SELECT id FROM tracks WHERE source = ? AND source_id = ?")
    .bind(source, songId)
    .first<{ id: number }>();
  if (dup) return ok(c, { id: dup.id, duplicate: true }, "该歌曲已在音乐库中");

  // 汽水：先解析拿元数据（歌名/歌手/专辑/封面/歌词/时长以解析为准）
  let qishuiParsed: ParsedQishui | null = null;
  if (source === "qishui") {
    qishuiParsed = await parseQishui(songId).catch(() => null);
    if (!qishuiParsed) return fail(c, "汽水解析失败：歌曲不存在或已下架", 502);
  }

  const title = String(body?.title ?? "").trim() || qishuiParsed?.title || "";
  const artist = String(body?.artist ?? "").trim() || qishuiParsed?.artist || "";
  const album = String(body?.album ?? "").trim() || qishuiParsed?.album || "";
  const coverUrl = String(body?.cover ?? "").trim() || qishuiParsed?.cover || "";
  const vip = body?.vip ? 1 : qishuiParsed?.vip_only ? 1 : 0;
  const duration = Number(body?.duration ?? 0) || qishuiParsed?.duration_s || 0;
  if (!title) return fail(c, "缺少歌名", 400);

  const resolved = await resolveAudio(songId, source, title, artist, qishuiParsed);
  if (!resolved) return fail(c, "解析失败：所有音源均不可用（VIP 付费或已下架），未入库", 502);

  const [coverRes, lyric] = await Promise.all([
    downloadCover(coverUrl, source, songId, title, artist, qishuiParsed),
    fetchLyric(source, songId, title, artist, qishuiParsed),
  ]);

  const ext = audioExt(resolved.buf);
  const audioKey = newKey("audio", ext);
  await c.env.R2.put(audioKey, resolved.buf, {
    httpMetadata: { contentType: AUDIO_MIME[ext] || "audio/mpeg" },
  });

  let coverKey = "";
  if (coverRes) {
    coverKey = newKey("cover", coverRes.ext);
    await c.env.R2.put(coverKey, coverRes.buf, {
      httpMetadata: { contentType: `image/${coverRes.ext === "jpg" ? "jpeg" : coverRes.ext}` },
    });
  }

  const r = await c.env.DB.prepare(
    "INSERT INTO tracks (title, artist, album, source, source_id, vip, audio_key, cover_key, lyric, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(title, artist, album, source, songId, vip, audioKey, coverKey, lyric, duration)
    .run();
  return ok(c, { id: r.meta.last_row_id, title, artist, via: resolved.via }, "入库成功（音频/封面/歌词已存 R2）");
});

/** 本地上传入库：POST /ingest/upload（multipart: file, title?, artist?, cover?） */
app.post("/ingest/upload", async c => {
  const form = await c.req.parseBody().catch(() => null);
  if (!form) return fail(c, "表单解析失败", 400);
  const file = form.file;
  if (!(file instanceof File)) return fail(c, "请选择音频文件", 400);
  if (file.size > MAX_AUDIO_BYTES) return fail(c, "文件超过 60MB 限制", 400);
  if (file.size < 1024) return fail(c, "文件太小，不是有效音频", 400);
  const buf = await file.arrayBuffer();
  const ext = audioExt(buf);
  if (!ext) return fail(c, "不支持的音频格式（仅 mp3 / m4a / flac / wav / ogg）", 400);

  const title = (typeof form.title === "string" && form.title.trim()) || file.name.replace(/\.[^.]+$/, "") || "未命名";
  const artist = (typeof form.artist === "string" && form.artist.trim()) || "本地音乐";

  const audioKey = newKey("audio", ext);
  await c.env.R2.put(audioKey, buf, {
    httpMetadata: { contentType: AUDIO_MIME[ext] || "audio/mpeg" },
  });

  let coverKey = "";
  const coverFile = form.cover;
  if (coverFile instanceof File && coverFile.size > 1024 && coverFile.size < 5 * 1024 * 1024) {
    const cb = await coverFile.arrayBuffer();
    const iext = looksLikeImage(cb);
    if (iext) {
      coverKey = newKey("cover", iext);
      await c.env.R2.put(coverKey, cb, {
        httpMetadata: { contentType: `image/${iext === "jpg" ? "jpeg" : iext}` },
      });
    }
  }

  const r = await c.env.DB.prepare(
    "INSERT INTO tracks (title, artist, source, source_id, audio_key, cover_key) VALUES (?, ?, 'upload', '', ?, ?)"
  )
    .bind(title, artist, audioKey, coverKey)
    .run();
  return ok(c, { id: r.meta.last_row_id, title, artist }, "上传成功");
});

/** 网络地址转存：POST /ingest/url { url, title?, artist?, cover? } */
app.post("/ingest/url", async c => {
  const body = await c.req.json().catch(() => null);
  const url = String(body?.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return fail(c, "请提供 http(s) 音频地址", 400);

  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return fail(c, `源地址返回 HTTP ${res.status}`, 400);
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_AUDIO_BYTES) return fail(c, "文件超过 60MB 限制", 400);
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_AUDIO_BYTES) return fail(c, "文件超过 60MB 限制", 400);
    const ext = audioExt(buf);
    if (!ext) return fail(c, "该地址不是有效的音频文件（mp3 / m4a / flac / wav / ogg）", 400);

    const fallbackName =
      decodeURIComponent((url.split("?")[0].split("/").pop() || "").replace(/\.[^.]+$/, "")) || "网络音乐";
    const title = String(body?.title ?? "").trim() || fallbackName;
    const artist = String(body?.artist ?? "").trim() || "网络音乐";

    let coverKey = "";
    const coverUrl = String(body?.cover ?? "").trim();
    if (coverUrl) {
      const coverRes = await downloadCover(coverUrl);
      if (coverRes) {
        coverKey = newKey("cover", coverRes.ext);
        await c.env.R2.put(coverKey, coverRes.buf, {
          httpMetadata: { contentType: `image/${coverRes.ext === "jpg" ? "jpeg" : coverRes.ext}` },
        });
      }
    }

    const audioKey = newKey("audio", ext);
    await c.env.R2.put(audioKey, buf, {
      httpMetadata: { contentType: AUDIO_MIME[ext] || "audio/mpeg" },
    });

    const r = await c.env.DB.prepare(
      "INSERT INTO tracks (title, artist, source, source_id, audio_key, cover_key) VALUES (?, ?, 'url', ?, ?, ?)"
    )
      .bind(title, artist, url.slice(0, 500), audioKey, coverKey)
      .run();
    return ok(c, { id: r.meta.last_row_id, title, artist }, coverKey ? "转存成功" : "转存成功（封面获取失败，可忽略）");
  } catch (e) {
    return fail(c, `转存失败：${e instanceof Error ? e.message : "网络错误"}`, 502);
  }
});

interface TrackRow {
  id: number;
  title: string;
  artist: string;
  album: string;
  source: string;
  source_id: string;
  vip: number;
  audio_key: string;
  cover_key: string;
  lyric: string;
  duration: number;
  enabled: number;
  tag: string;
  created_at: string;
}

function trackJson(r: TrackRow, r2Domain: string, origin: string) {
  return {
    id: r.id,
    title: r.title,
    artist: r.artist,
    album: r.album,
    source: r.source,
    source_label: SOURCE_LABEL[r.source] || r.source,
    vip: !!r.vip,
    duration: r.duration,
    enabled: !!r.enabled,
    tag: r.tag,
    has_cover: !!r.cover_key,
    has_lyric: r.lyric.length > 0,
    created_at: r.created_at,
    audio_url: r.audio_key ? keyToUrl(r.audio_key, r2Domain, origin) : "",
    cover_url: r.cover_key ? keyToUrl(r.cover_key, r2Domain, origin) : "",
  };
}

/** 曲库列表：GET /library[?tag=] */
app.get("/library", async c => {
  const origin = new URL(c.req.url).origin;
  const r2Domain = await getSetting(c.env.DB, "r2_domain");
  const { results } = await c.env.DB.prepare(
    "SELECT id, title, artist, album, source, source_id, vip, audio_key, cover_key, lyric, duration, enabled, tag, created_at FROM tracks ORDER BY id DESC LIMIT 1000"
  ).all<TrackRow>();
  const list = (results || []).map(r => trackJson(r, r2Domain, origin));
  return ok(c, { list, total: list.length });
});

/** 批量设置标签：POST /library/tag { ids: [1,2], tag: "最爱" }（tag 为空即清除） */
app.post("/library/tag", async c => {
  const body = await c.req.json().catch(() => null);
  const ids = (Array.isArray(body?.ids) ? body.ids : [])
    .map((v: unknown) => Number(String(v).replace(/^t/, "")))
    .filter((n: number) => Number.isInteger(n) && n > 0)
    .slice(0, 200);
  const tag = String(body?.tag ?? "").trim().slice(0, 30);
  if (!ids.length) return fail(c, "请先勾选曲目", 400);
  const stmts = ids.map((id: number) => c.env.DB.prepare("UPDATE tracks SET tag = ? WHERE id = ?").bind(tag, id));
  if (tag) stmts.push(c.env.DB.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").bind(tag));
  await c.env.DB.batch(stmts);
  return ok(c, { count: ids.length, tag }, tag ? `已给 ${ids.length} 首打上「${tag}」标签` : `已清除 ${ids.length} 首的标签`);
});

/* ---------- 标签（歌单）管理 ---------- */

function normTagName(v: unknown): string {
  return String(v ?? "").trim().slice(0, 30);
}

/** 标签列表：GET /tags → [{ name, count }]（含空标签，count 为标签内曲目数） */
app.get("/tags", async c => {
  const { results } = await c.env.DB.prepare(
    `SELECT t.name AS name, COUNT(tr.id) AS count
     FROM tags t
     LEFT JOIN tracks tr ON tr.tag = t.name
     GROUP BY t.name
     ORDER BY t.created_at DESC`
  ).all<{ name: string; count: number }>();
  return ok(c, { list: (results || []).map(r => ({ name: r.name, count: r.count })) });
});

/** 新建标签：POST /tags { name }（允许空标签，稍后往里加歌） */
app.post("/tags", async c => {
  const body = await c.req.json().catch(() => null);
  const name = normTagName(body?.name);
  if (!name) return fail(c, "请填写标签名", 400);
  const dup = await c.env.DB.prepare("SELECT name FROM tags WHERE name = ?").bind(name).first();
  if (dup) return fail(c, "标签已存在", 409);
  await c.env.DB.prepare("INSERT INTO tags (name) VALUES (?)").bind(name).run();
  return ok(c, { name }, "标签已创建");
});

/** 重命名标签：POST /tags/rename { old, name }（标签表 + 曲目 tag 一起改） */
app.post("/tags/rename", async c => {
  const body = await c.req.json().catch(() => null);
  const oldName = normTagName(body?.old);
  const newName = normTagName(body?.name);
  if (!oldName || !newName) return fail(c, "参数错误", 400);
  const exists = await c.env.DB.prepare("SELECT name FROM tags WHERE name = ?").bind(oldName).first();
  if (!exists) return fail(c, "标签不存在", 404);
  if (oldName === newName) return ok(c, { name: newName });
  const dup = await c.env.DB.prepare("SELECT name FROM tags WHERE name = ?").bind(newName).first();
  if (dup) return fail(c, "目标标签名已存在", 409);
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO tags (name) VALUES (?)").bind(newName),
    c.env.DB.prepare("UPDATE tracks SET tag = ? WHERE tag = ?").bind(newName, oldName),
    c.env.DB.prepare("DELETE FROM tags WHERE name = ?").bind(oldName),
  ]);
  return ok(c, { name: newName }, "已重命名");
});

/** 删除标签：POST /tags/delete { name }（标签删除，其下曲目变为无标签，不删歌） */
app.post("/tags/delete", async c => {
  const body = await c.req.json().catch(() => null);
  const name = normTagName(body?.name);
  if (!name) return fail(c, "参数错误", 400);
  const r = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tracks WHERE tag = ?"
  ).bind(name).first<{ n: number }>();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE tracks SET tag = '' WHERE tag = ?").bind(name),
    c.env.DB.prepare("DELETE FROM tags WHERE name = ?").bind(name),
  ]);
  return ok(c, { name, freed: r?.n || 0 }, "标签已删除");
});

/** 加入标签：POST /tags/assign { name, ids:[1,2] }
 *  单标签语义：歌曲会从原标签移动到该标签 */
app.post("/tags/assign", async c => {
  const body = await c.req.json().catch(() => null);
  const name = normTagName(body?.name);
  const ids = (Array.isArray(body?.ids) ? body.ids : [])
    .map((v: unknown) => Number(v))
    .filter((n: number) => Number.isInteger(n) && n > 0)
    .slice(0, 500);
  if (!name) return fail(c, "参数错误", 400);
  if (!ids.length) return fail(c, "请选择歌曲", 400);
  const tagExists = await c.env.DB.prepare("SELECT name FROM tags WHERE name = ?").bind(name).first();
  if (!tagExists) return fail(c, "标签不存在", 404);
  const stmts = ids.map((id: number) => c.env.DB.prepare("UPDATE tracks SET tag = ? WHERE id = ?").bind(name, id));
  await c.env.DB.batch(stmts);
  return ok(c, { name, count: ids.length }, `已添加 ${ids.length} 首到「${name}」`);
});

/** 移出标签：POST /tags/unassign { name, ids:[1,2] }（仅当歌曲当前属于该标签时清空） */
app.post("/tags/unassign", async c => {
  const body = await c.req.json().catch(() => null);
  const name = normTagName(body?.name);
  const ids = (Array.isArray(body?.ids) ? body.ids : [])
    .map((v: unknown) => Number(v))
    .filter((n: number) => Number.isInteger(n) && n > 0)
    .slice(0, 500);
  if (!name || !ids.length) return fail(c, "参数错误", 400);
  const stmts = ids.map((id: number) =>
    c.env.DB.prepare("UPDATE tracks SET tag = '' WHERE id = ? AND tag = ?").bind(id, name)
  );
  await c.env.DB.batch(stmts);
  return ok(c, { name, count: ids.length }, `已从「${name}」移出 ${ids.length} 首`);
});

/** 补全封面/歌词：POST /library/fill { id } —— 已有的项不覆盖 */
app.post("/library/fill", async c => {
  const body = await c.req.json().catch(() => null);
  const id = Number(String(body?.id ?? "").replace(/^t/, ""));
  if (!id) return fail(c, "参数错误", 400);
  const row = await c.env.DB.prepare("SELECT id, title, artist, source, source_id, cover_key, lyric FROM tracks WHERE id = ?")
    .bind(id)
    .first<{ id: number; title: string; artist: string; source: string; source_id: string; cover_key: string; lyric: string }>();
  if (!row) return fail(c, "曲目不存在", 404);

  const result: { cover: "ok" | "exists" | "fail"; lyric: "ok" | "exists" | "fail" } = { cover: "exists", lyric: "exists" };

  if (!row.cover_key) {
    const parsed = row.source === "qishui" ? await parseQishui(row.source_id).catch(() => null) : null;
    const coverRes = await downloadCover("", row.source, row.source_id, row.title, row.artist, parsed);
    if (coverRes) {
      const coverKey = newKey("cover", coverRes.ext);
      await c.env.R2.put(coverKey, coverRes.buf, {
        httpMetadata: { contentType: `image/${coverRes.ext === "jpg" ? "jpeg" : coverRes.ext}` },
      });
      await c.env.DB.prepare("UPDATE tracks SET cover_key = ? WHERE id = ?").bind(coverKey, id).run();
      result.cover = "ok";
    } else {
      result.cover = "fail";
    }
  }

  if (!row.lyric) {
    const parsed = row.source === "qishui" ? await parseQishui(row.source_id).catch(() => null) : null;
    const lyric = await fetchLyric(row.source, row.source_id, row.title, row.artist, parsed);
    if (lyric) {
      await c.env.DB.prepare("UPDATE tracks SET lyric = ? WHERE id = ?").bind(lyric, id).run();
      result.lyric = "ok";
    } else {
      result.lyric = "fail";
    }
  }

  const parts = [
    result.cover === "ok" ? "封面已补" : result.cover === "fail" ? "封面补全失败" : "",
    result.lyric === "ok" ? "歌词已补" : result.lyric === "fail" ? "歌词补全失败" : "",
  ].filter(Boolean);
  return ok(c, { id, ...result }, parts.join("，") || "封面和歌词都已存在，无需补全");
});

/** 手动编辑歌词：POST /library/edit { id, lyric }（空串即清除） */
app.post("/library/edit", async c => {
  const body = await c.req.json().catch(() => null);
  const id = Number(String(body?.id ?? "").replace(/^t/, ""));
  if (!id) return fail(c, "参数错误", 400);
  const lyric = String(body?.lyric ?? "").slice(0, 20000);
  const r = await c.env.DB.prepare("UPDATE tracks SET lyric = ? WHERE id = ?").bind(lyric, id).run();
  if (!r.meta.changes) return fail(c, "曲目不存在", 404);
  return ok(c, { id, has_lyric: lyric.trim().length > 0 }, lyric.trim() ? "歌词已保存" : "歌词已清除");
});

/** 启用/停用：POST /library/toggle { id, enabled } */
app.post("/library/toggle", async c => {
  const body = await c.req.json().catch(() => null);
  const id = Number(String(body?.id ?? "").replace(/^t/, ""));
  if (!id) return fail(c, "参数错误", 400);
  const enabled = body?.enabled === false ? 0 : 1;
  const r = await c.env.DB.prepare("UPDATE tracks SET enabled = ? WHERE id = ?").bind(enabled, id).run();
  if (!r.meta.changes) return fail(c, "曲目不存在", 404);
  return ok(c, { id, enabled: enabled === 1 });
});

/** 删除（同时清理 R2 音频+封面）：POST /library/delete { id } */
app.post("/library/delete", async c => {
  const body = await c.req.json().catch(() => null);
  const id = Number(String(body?.id ?? "").replace(/^t/, ""));
  if (!id) return fail(c, "参数错误", 400);
  const row = await c.env.DB.prepare("SELECT audio_key, cover_key FROM tracks WHERE id = ?")
    .bind(id)
    .first<{ audio_key: string; cover_key: string }>();
  if (!row) return fail(c, "曲目不存在", 404);
  for (const key of [row.audio_key, row.cover_key]) {
    if (key) await c.env.R2.delete(key);
  }
  await c.env.DB.prepare("DELETE FROM tracks WHERE id = ?").bind(id).run();
  return ok(c, { id }, "已删除");
});

export default app;
