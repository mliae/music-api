/**
 * /media/* —— R2 共享桶对象的流式输出（仅放行 music/ 前缀）。
 * 支持 HTTP Range（音频拖拽必需）、不可变长缓存、扩展名兜底 MIME。
 */
import type { Context } from "hono";
import { fail } from "./respond";
import type { HonoEnv } from "./types";

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  lrc: "text/plain; charset=utf-8",
};

function extMime(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? "application/octet-stream";
}

/** 从 URL 路径解析受保护的 R2 key（只放行 music/ 前缀，拒绝越权路径） */
function resolveKey(pathname: string): string | null {
  if (!pathname.startsWith("/media/")) return null;
  let key: string;
  try {
    key = decodeURIComponent(pathname.slice("/media/".length));
  } catch {
    return null;
  }
  if (!key || key.startsWith("/") || key.includes("..") || key.includes("\\")) return null;
  if (!key.startsWith("music/")) return null;
  return key;
}

const IMMUTABLE = "public, max-age=31536000, immutable";

export async function serveMedia(c: Context<HonoEnv>): Promise<Response> {
  const key = resolveKey(new URL(c.req.url).pathname);
  if (!key) return fail(c, "资源不存在", 404);

  const rangeHeader = c.req.header("range") ?? c.req.header("Range");
  const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;

  // 后缀范围 bytes=-N
  if (m && m[1] === "" && m[2] !== "") {
    const suffix = Number(m[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return new Response("Invalid Range", { status: 416, headers: { "Content-Range": "bytes */0" } });
    }
    const obj = await c.env.R2.get(key, { range: { suffix } });
    if (!obj) return fail(c, "资源不存在", 404);
    return rangeResponse(obj, key);
  }

  // 普通范围 bytes=start-end / bytes=start-
  if (m && m[1] !== "") {
    const start = Number(m[1]);
    const end = m[2] !== "" ? Number(m[2]) : undefined;
    if (!Number.isFinite(start) || start < 0 || (end !== undefined && (end < start || !Number.isFinite(end)))) {
      return new Response("Invalid Range", { status: 416, headers: { "Content-Range": "bytes */0" } });
    }
    const obj = await c.env.R2.get(
      key,
      end !== undefined ? { range: { offset: start, length: end - start + 1 } } : { range: { offset: start } }
    );
    if (!obj) return fail(c, "资源不存在", 404);
    return rangeResponse(obj, key);
  }

  // 无 Range：整对象 —— 先查 Cloudflare 边缘缓存
  const cache = (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(c.req.url, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const obj = await c.env.R2.get(key);
  if (!obj) return fail(c, "资源不存在", 404);
  const headers = baseHeaders(obj, key);
  headers.set("Content-Length", String(obj.size));
  const res = new Response(obj.body, { status: 200, headers });
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function baseHeaders(obj: R2ObjectBody | R2Object, key: string): Headers {
  const headers = new Headers();
  const ct = obj.httpMetadata?.contentType;
  headers.set("Content-Type", ct && ct !== "application/octet-stream" ? ct : extMime(key));
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", IMMUTABLE);
  headers.set("ETag", obj.httpEtag);
  if (obj.httpMetadata?.contentEncoding) headers.set("Content-Encoding", obj.httpMetadata.contentEncoding);
  return headers;
}

/** 206 响应（R2 范围读取后 obj.range 描述实际区间） */
function rangeResponse(obj: R2ObjectBody, key: string): Response {
  const size = obj.size;
  let start = 0;
  let end = size - 1;
  const r = obj.range as { suffix: number } | { offset?: number; length?: number } | undefined;
  if (r) {
    if ("suffix" in r) {
      start = Math.max(0, size - r.suffix);
      end = size - 1;
    } else {
      start = r.offset ?? 0;
      end = typeof r.length === "number" ? start + r.length - 1 : size - 1;
    }
  }
  end = Math.min(end, size - 1);
  const headers = baseHeaders(obj, key);
  headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(obj.body, { status: 206, headers });
}
