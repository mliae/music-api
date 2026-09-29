# music-api — 中央音乐解析服务

一个部署在 Cloudflare Workers 上的音乐解析与曲库中心：聚合搜索五平台歌曲、解析试听/下载入库到 R2，通过 ApiKey 授权给多个前端项目使用，并提供 Web 后台管理曲库。

> 同一个曲库可以同时供养多个站点：博客胶囊播放器、音乐单页等，都从这里的 `playlist.json` 拉歌单。

## 功能

- **五平台聚合搜索** — 网易云 / QQ / 酷狗 / 酷我 / 汽水，一次关键词返回全部结果
- **歌曲解析入库** — 解析真实音频地址，下载音频 + 封面 + 歌词转存到 R2，彻底摆脱源站限制；也支持本地上传、网络地址转存
- **多对多标签（歌单）** — 一首歌可属于多个标签，标签即歌单，可重命名、删除、复制歌单地址
- **ApiKey 授权** — 一项目一 Key，随时启用/停用，消费方凭 `X-Api-Key` 调用写接口
- **Web 后台** — 密码登录、曲库管理、标签管理、Key 管理、R2 自定义域名等设置

## 技术栈

| 组件 | 说明 |
| --- | --- |
| Cloudflare Workers | 计算层，框架 [Hono](https://hono.dev) |
| D1 (SQLite) | 存曲目、标签、ApiKey、设置 |
| R2 | 存音频 / 封面文件 |
| Workers Assets | 后台静态页 `public/admin.html` |

无 Node 运行时依赖（仅 hono），业务代码全部基于 Web 标准 API。

## 快速开始

```bash
npm install
npx wrangler login

# 本地开发（D1/R2 走本地模拟）
npm run dev

# 部署（D1 自动按名创建，首启自动建表）
npm run deploy
```

部署后访问 `https://<your-worker>.workers.dev/admin.html`，首次进入设置管理密码。

`wrangler.jsonc` 中 R2 桶默认复用已有的 `moments-storage`（`music/` 前缀），可改成自己的桶名。

## API

统一响应格式：`{ code, message, data }`。

### 公开读取（无需鉴权，已开 CORS）

| 端点 | 说明 |
| --- | --- |
| `GET /track/:id` | 曲目元数据（标题/歌手/封面/音频/内联歌词） |
| `GET /playlist.json?tag=` | 播放器歌单，纯数组 `{ id, name, artist, url, pic, lrc }`；`tag` 可选过滤 |
| `GET /media/*` | R2 音频/封面直出，供 `<audio>` / `<img>` 直接引用 |

### 消费方 API（Header: `X-Api-Key: mk_xxx`）

| 端点 | 说明 |
| --- | --- |
| `GET /api/search?kw=` | 五平台聚合搜索 |
| `GET /api/resolve?source=&id=` | 解析试听地址 |
| `POST /api/ingest` | 搜索结果入库（转存 R2） |
| `POST /api/ingest/upload` | 本地上传入库 |
| `POST /api/ingest/url` | 网络地址转存入库 |
| `GET /api/library` | 曲库列表（含标签） |
| `POST /api/library/tag` | 打标签（空标签 = 清空该曲全部标签） |
| `POST /api/library/fill` | 补全歌词/封面 |
| `POST /api/library/edit` | 编辑曲目信息 |
| `POST /api/library/toggle` | 启用/停用 |
| `POST /api/library/delete` | 删除（含 R2 文件） |
| `GET /api/tags` · `POST /api/tags/*` | 标签的增删改查与歌曲关联 |

### 后台

`/admin.html` — Cookie 会话鉴权，能力与消费方 API 相同，另含 Key 管理、R2 域名设置。

## 数据模型

```
tracks(id, title, artist, album, audio_key, cover_key, lyric, enabled, created_at, ...)
tags(id, name, created_at)
track_tags(track_id, tag)          -- 多对多，联合主键
api_keys(key, name, enabled, ...)  -- 消费方授权
settings(key, value)               -- r2_domain 等
```

首次请求由 `ensureSchema()` 幂等建表（逐条 `prepare().run()`，规避 D1 多语句 exec 的解析问题），`migrations/` 供 CLI 手动迁移，二者不冲突。

## 目录结构

```
src/
  index.ts          # 路由入口、CORS、ensureSchema
  db.ts             # 建表与设置读写
  auth.ts           # ApiKey / 后台 cookie 鉴权
  media.ts          # /media/* R2 输出
  types.ts
  routes/
    public.ts       # /track/:id、/playlist.json
    consumer.ts     # /api/*（搜索/解析/入库/曲库/标签）
    admin.ts        # /admin/api/*（登录、Key 管理）
  platforms/        # 五平台搜索与解析实现
  services/ingest.ts # 下载转存 R2、歌词补全等
public/admin.html   # 后台单页
migrations/         # D1 迁移
```

## License

仅供学习与个人使用，音乐版权归各平台及权利人所有。
