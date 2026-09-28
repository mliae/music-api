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
