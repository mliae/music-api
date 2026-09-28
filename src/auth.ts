/**
 * 双层鉴权：
 * 1. 消费方 ApiKey（X-Api-Key 请求头）—— 项目级授权，可启停，统计调用量
 * 2. 站主管理密码（HMAC-SHA256 签名 cookie）—— 后台 /admin，与博客同款无状态会话
 */
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { fail } from "./respond";
import type { HonoEnv } from "./types";

export const ADMIN_COOKIE = "music_api_admin";
const MAX_AGE_SEC = 7 * 24 * 3600;

const encoder = new TextEncoder();

function b64url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(input: string): Uint8Array {
  const pad = input.length % 4 ? 4 - (input.length % 4) : 0;
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 常量时间字符串比较，防时序侧信道 */
export function safeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function sign(payloadB64: string, secret: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payloadB64));
  return b64url(sig);
}

export async function createAdminToken(secret: string): Promise<string> {
  const payload = { exp: Date.now() + MAX_AGE_SEC * 1000 };
  const payloadB64 = b64url(encoder.encode(JSON.stringify(payload)));
  const sigB64 = await sign(payloadB64, secret);
  return `${payloadB64}.${sigB64}`;
}

export async function verifyAdminToken(token: string | undefined, secret: string): Promise<boolean> {
  if (!token || !secret) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let exp = 0;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))) as { exp?: number };
    exp = Number(payload.exp) || 0;
  } catch {
    return false;
  }
  if (!exp || exp < Date.now()) return false;
  const expected = await sign(payloadB64, secret);
  return safeEqual(expected, sigB64);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 当前生效的签名密钥：D1 有哈希用哈希，否则回退环境变量 ADMIN_PASSWORD */
export async function getAdminSecret(db: D1Database, envPassword: string): Promise<string> {
  const row = await db
    .prepare("SELECT password_hash FROM admin_auth WHERE id = 1")
    .first<{ password_hash: string }>();
  return row?.password_hash || envPassword;
}

export async function verifyAdminPassword(
  db: D1Database,
  envPassword: string,
  input: string
): Promise<boolean> {
  if (!input) return false;
  const row = await db
    .prepare("SELECT password_hash FROM admin_auth WHERE id = 1")
    .first<{ password_hash: string }>();
  if (row?.password_hash) return safeEqual(await sha256Hex(input), row.password_hash);
  return !!envPassword && safeEqual(input, envPassword);
}

/** 是否已设置管理密码：D1 有哈希或环境变量有值；皆无则后台走「设置初始密码」 */
export async function hasAdminPassword(db: D1Database, envPassword: string): Promise<boolean> {
  if (envPassword) return true;
  const row = await db
    .prepare("SELECT password_hash FROM admin_auth WHERE id = 1")
    .first<{ password_hash: string }>();
  return !!row?.password_hash;
}

export async function setAdminPassword(db: D1Database, newPassword: string): Promise<string> {
  const hash = await sha256Hex(newPassword);
  await db
    .prepare(
      `INSERT INTO admin_auth (id, password_hash, updated_at)
       VALUES (1, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at`
    )
    .bind(hash)
    .run();
  return hash;
}

export async function isAdmin(c: Context<HonoEnv>): Promise<boolean> {
  const secret = await getAdminSecret(c.env.DB, c.env.ADMIN_PASSWORD);
  return verifyAdminToken(getCookie(c, ADMIN_COOKIE), secret);
}

export function setAdminCookie(c: Context<HonoEnv>, token: string): void {
  setCookie(c, ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    path: "/",
    maxAge: MAX_AGE_SEC,
  });
}

export function clearAdminCookie(c: Context<HonoEnv>): void {
  deleteCookie(c, ADMIN_COOKIE, { path: "/" });
}

/** 后台路由守卫（cookie） */
export async function requireAdmin(c: Context<HonoEnv>, next: Next) {
  if (!(await isAdmin(c))) return fail(c, "未授权，请先登录", 401);
  await next();
}

/** 消费方路由守卫（X-Api-Key 请求头），通过后异步累计调用量 */
export async function requireApiKey(c: Context<HonoEnv>, next: Next) {
  const key = (c.req.header("X-Api-Key") || "").trim();
  if (!key) return fail(c, "缺少 X-Api-Key 请求头", 401);
  const row = await c.env.DB.prepare("SELECT id, enabled FROM api_keys WHERE api_key = ?")
    .bind(key)
    .first<{ id: number; enabled: number }>();
  if (!row) return fail(c, "ApiKey 无效", 401);
  if (!row.enabled) return fail(c, "ApiKey 已停用", 403);
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      "UPDATE api_keys SET calls = calls + 1, last_used = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    )
      .bind(row.id)
      .run()
  );
  await next();
}
