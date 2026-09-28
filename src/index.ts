/**
 * music-api —— 中央音乐解析服务
 *
 * 公开读取：/track/:id、/playlist.json、/media/*（<audio>/<img> 直接用）
 * 消费方写操作：/api/*（X-Api-Key 鉴权，一项目一 Key）
 * 站主后台：/admin.html（cookie 鉴权，/admin/api/*）
 */
import { Hono } from "hono";
import type { HonoEnv } from "./types";
import { ensureSchema } from "./db";
import { serveMedia } from "./media";
import { requireApiKey } from "./auth";
import consumer from "./routes/consumer";
import publicRoutes from "./routes/public";
import admin from "./routes/admin";

const app = new Hono<HonoEnv>();

/** 首次请求幂等建表 */
app.use("*", async (c, next) => {
  await ensureSchema(c.env.DB);
  await next();
});

/** 公开读取端点允许跨域（媒体元素本就不受 CORS 限制；JSON 便于浏览器直接 fetch） */
app.use("*", async (c, next) => {
  const p = new URL(c.req.url).pathname;
  if (p.startsWith("/track/") || p === "/playlist.json" || p.startsWith("/media/")) {
    c.header("Access-Control-Allow-Origin", "*");
  }
  await next();
});

// 公开读取
app.route("/", publicRoutes);
app.get("/media/*", serveMedia);

// 消费方写操作（X-Api-Key）
app.use("/api/*", requireApiKey);
app.route("/api", consumer);

// 站主后台 API（cookie；登录/状态路由在 admin 内不受守卫）
app.route("/admin/api", admin);

// 后台页面入口
app.get("/admin", c => c.redirect("/admin.html", 302));

// 服务信息
app.get("/", c =>
  c.json({
    name: "music-api",
    version: "0.1.0",
    endpoints: {
      public: ["GET /track/:id", "GET /playlist.json?tag=", "GET /media/*"],
      consumer: [
        "GET /api/search?kw=",
        "GET /api/resolve?source=&id=",
        "POST /api/ingest",
        "POST /api/ingest/upload",
        "POST /api/ingest/url",
        "GET /api/library",
        "POST /api/library/tag|fill|edit|toggle|delete",
      ],
      admin: "/admin.html",
    },
  })
);

app.notFound(c => c.json({ code: 404, message: "Not Found", data: null }, 404));

export default app;
