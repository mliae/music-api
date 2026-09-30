/**
 * 后台管理 API（cookie 鉴权）：
 *   POST /admin/api/login      登录（未设置密码时即为初始密码设置）
 *   POST /admin/api/logout     退出
 *   GET  /admin/api/status     { configured, authed }
 *   GET  /admin/api/keys       ApiKey 列表
 *   POST /admin/api/keys       新建 { name }
 *   POST /admin/api/keys/toggle  { id, enabled }
 *   POST /admin/api/keys/delete  { id }
 *   GET  /admin/api/settings   { r2_domain }
 *   POST /admin/api/settings   { r2_domain }
 *   POST /admin/api/password   { old_password, new_password }
 * 曲库管理（搜索/入库/列表/标签/歌词/启停/删除）复用消费方 handler，挂在 /admin/api 下。
 */
import { Hono } from "hono";
import { ok, fail } from "../respond";
import type { HonoEnv } from "../types";
import { getSetting, setSetting } from "../db";
import {
  clearAdminCookie,
  createAdminToken,
  getAdminSecret,
  hasAdminPassword,
  isAdmin,
  requireAdmin,
  setAdminCookie,
  setAdminPassword,
  verifyAdminPassword,
} from "../auth";
import { parseQishui } from "../platforms/qishui";
import { fetchLyric } from "../services/ingest";
import consumer from "./consumer";

const app = new Hono<HonoEnv>();

/** 状态：是否已配置密码 + 当前是否已登录（登录页据此渲染「设置初始密码」或「登录」） */
app.get("/status", async c => {
  return ok(c, {
    configured: await hasAdminPassword(c.env.DB, c.env.ADMIN_PASSWORD),
    authed: await isAdmin(c),
  });
});

/** 登录：未配置密码时，提交的密码即为初始密码（≥6 位） */
app.post("/login", async c => {
  const body = await c.req.json().catch(() => null);
  const password = String(body?.password ?? "");
  if (!password) return fail(c, "请输入密码", 400);

  const configured = await hasAdminPassword(c.env.DB, c.env.ADMIN_PASSWORD);
  if (!configured) {
    if (password.length < 6) return fail(c, "初始密码至少 6 位", 400);
    const secret = await setAdminPassword(c.env.DB, password);
    setAdminCookie(c, await createAdminToken(secret));
    return ok(c, { setup: true }, "初始密码已设置，已登录");
  }
  if (!(await verifyAdminPassword(c.env.DB, c.env.ADMIN_PASSWORD, password))) {
    return fail(c, "密码错误", 401);
  }
  const secret = await getAdminSecret(c.env.DB, c.env.ADMIN_PASSWORD);
  setAdminCookie(c, await createAdminToken(secret));
  return ok(c, { setup: false }, "登录成功");
});

app.post("/logout", c => {
  clearAdminCookie(c);
  return ok(c, null, "已退出");
});

/* ---------- 以下均需登录 ---------- */

app.use("/*", requireAdmin);

/** 曲库管理复用消费方 handler（搜索/入库/列表/标签/歌词/启停/删除） */
app.route("/", consumer);

/** 试听音频代理：GET /admin/api/stream?url=xxx
 *  汽水等平台直链有防盗链，浏览器 <audio> 直接请求 403，
 *  通过 Worker 代理 fetch 绕过 */
app.get("/stream", async c => {
  const url = c.req.query("url") || "";
  if (!/^https?:\/\//i.test(url)) return fail(c, "参数错误", 400);
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!resp.ok) return fail(c, `音频获取失败 HTTP ${resp.status}`, 502);
  const ct = resp.headers.get("Content-Type") || "audio/mpeg";
  const cl = resp.headers.get("Content-Length") || "";
  return new Response(resp.body, {
    headers: {
      "Content-Type": ct,
      "Cache-Control": "no-store",
      ...(cl ? { "Content-Length": cl } : {}),
      "Accept-Ranges": "bytes",
    },
  });
});

/** 粘贴链接/ID 直接解析（汽水）：GET /parse?input=xxx → 歌曲元信息，前端据此打开详情卡 */
app.get("/parse", async c => {
  const input = (c.req.query("input") || "").trim();
  if (!input) return fail(c, "请粘贴歌曲链接或 ID", 400);
  const p = await parseQishui(input).catch(() => null);
  if (!p) return fail(c, "解析失败：请确认是汽水音乐的歌曲链接或歌曲 ID", 502);
  return ok(c, {
    source: "qishui",
    songId: p.id,
    title: p.title,
    artist: p.artist,
    album: p.album,
    cover: p.cover,
    duration: p.duration_s,
    vip: p.vip_only,
  });
});

/** 歌曲详情补充：GET /songinfo?source=&id=&title=&artist= → { lyric, tiers, vip }
 *  汽水：一次解析同时拿歌词与多档音质；其他平台只取歌词（复用入库同款歌词链路） */
app.get("/songinfo", async c => {
  const q = new URL(c.req.url).searchParams;
  const source = (q.get("source") || "").trim();
  const id = (q.get("id") || "").trim();
  const title = (q.get("title") || "").trim();
  const artist = (q.get("artist") || "").trim();
  if (!id) return fail(c, "参数错误", 400);
  if (source === "qishui") {
    const p = await parseQishui(id).catch(() => null);
    if (!p) return ok(c, { lyric: "", tiers: [], vip: false });
    const tiers = (p.audio || [])
      .filter(a => a.url)
      .map(a => ({
        label: String(a.quality_cn || a.quality || "音频"),
        bitrate: Number(a.bitrate || 0),
        size: Number(a.size || 0),
        url: String(a.url),
        need_vip: !!a.need_vip,
      }));
    return ok(c, { lyric: p.lyric || "", tiers, vip: p.vip_only === true });
  }
  const lyric = await fetchLyric(source, id, title, artist).catch(() => "");
  return ok(c, { lyric: lyric || "", tiers: [], vip: false });
});

/** 下载代理：GET /download?u=直链&name=文件名 → 强制 attachment（绕防盗链 + 中文文件名 + 自动补扩展名） */
app.get("/download", async c => {
  const url = c.req.query("u") || "";
  const name = (c.req.query("name") || "").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 120) || "download";
  if (!/^https?:\/\//i.test(url)) return fail(c, "参数错误", 400);
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
  });
  if (!resp.ok) return fail(c, `下载失败 HTTP ${resp.status}`, 502);
  const ct = (resp.headers.get("Content-Type") || "application/octet-stream").split(";")[0].trim();
  // 文件名没带扩展名时按 Content-Type 补
  const finalName = /\.[a-z0-9]{2,5}$/i.test(name)
    ? name
    : `${name}.${({ "audio/mp4": "m4a", "audio/aac": "aac", "audio/mpeg": "mp3", "audio/flac": "flac", "audio/wav": "wav", "audio/ogg": "ogg", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "text/plain": "lrc" } as Record<string, string>)[ct] || "bin"}`;
  return new Response(resp.body, {
    headers: {
      "Content-Type": ct,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(finalName)}`,
      "Cache-Control": "no-store",
    },
  });
});

/** ApiKey 列表 */
app.get("/keys", async c => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, api_key, enabled, calls, last_used, created_at FROM api_keys ORDER BY id DESC"
  ).all<{ id: number; name: string; api_key: string; enabled: number; calls: number; last_used: string; created_at: string }>();
  return ok(c, {
    list: (results || []).map(r => ({ ...r, enabled: !!r.enabled })),
    total: (results || []).length,
  });
});

/** 新建 ApiKey：POST /keys { name } → 返回完整 key（仅此一次展示由前端提示，DB 明文可回看） */
app.post("/keys", async c => {
  const body = await c.req.json().catch(() => null);
  const name = String(body?.name ?? "").trim().slice(0, 50);
  if (!name) return fail(c, "请填写项目备注（如：博客 jxe.me）", 400);
  const key = `mk_${crypto.randomUUID().replace(/-/g, "")}`;
  const r = await c.env.DB.prepare("INSERT INTO api_keys (name, api_key) VALUES (?, ?)").bind(name, key).run();
  return ok(c, { id: r.meta.last_row_id, name, api_key: key }, "已创建，请复制保存 Key");
});

/** 启停 ApiKey：POST /keys/toggle { id, enabled } */
app.post("/keys/toggle", async c => {
  const body = await c.req.json().catch(() => null);
  const id = Number(body?.id ?? 0);
  if (!id) return fail(c, "参数错误", 400);
  const enabled = body?.enabled === false ? 0 : 1;
  const r = await c.env.DB.prepare("UPDATE api_keys SET enabled = ? WHERE id = ?").bind(enabled, id).run();
  if (!r.meta.changes) return fail(c, "Key 不存在", 404);
  return ok(c, { id, enabled: enabled === 1 });
});

/** 删除 ApiKey：POST /keys/delete { id } */
app.post("/keys/delete", async c => {
  const body = await c.req.json().catch(() => null);
  const id = Number(body?.id ?? 0);
  if (!id) return fail(c, "参数错误", 400);
  const r = await c.env.DB.prepare("DELETE FROM api_keys WHERE id = ?").bind(id).run();
  if (!r.meta.changes) return fail(c, "Key 不存在", 404);
  return ok(c, { id }, "已删除");
});

/** 读取设置 */
app.get("/settings", async c => {
  return ok(c, { r2_domain: await getSetting(c.env.DB, "r2_domain") });
});

/** 保存设置：POST /settings { r2_domain } */
app.post("/settings", async c => {
  const body = await c.req.json().catch(() => null);
  const r2 = String(body?.r2_domain ?? "").trim().slice(0, 200);
  if (r2 && !/^https:\/\//i.test(r2)) return fail(c, "R2 域名需为 https:// 开头", 400);
  await setSetting(c.env.DB, "r2_domain", r2.replace(/\/$/, ""));
  return ok(c, { r2_domain: r2 }, "设置已保存");
});

/** 修改管理密码：POST /password { old_password, new_password }（改后所有旧 cookie 失效） */
app.post("/password", async c => {
  const body = await c.req.json().catch(() => null);
  const oldPwd = String(body?.old_password ?? "");
  const newPwd = String(body?.new_password ?? "");
  if (newPwd.length < 6) return fail(c, "新密码至少 6 位", 400);
  if (!(await verifyAdminPassword(c.env.DB, c.env.ADMIN_PASSWORD, oldPwd))) {
    return fail(c, "原密码错误", 401);
  }
  const secret = await setAdminPassword(c.env.DB, newPwd);
  setAdminCookie(c, await createAdminToken(secret));
  return ok(c, null, "密码已修改");
});

export default app;
