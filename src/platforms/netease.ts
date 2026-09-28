/** 网易云音乐：搜索（官方 + netstart 镜像兜底）、outer 直链、封面、歌词 */
import { UA, toHttps, type SearchHit } from "./types";

/** 通过网易云 outer URL 302 重定向获取真实 CDN 播放地址 */
export async function getOuterUrl(id: string): Promise<string | null> {
  try {
    const res = await fetch(`https://music.163.com/song/media/outer/url?id=${id}.mp3`, {
      headers: { "User-Agent": UA, Referer: "https://music.163.com/" },
      redirect: "manual",
    });
    const location = res.headers.get("location") || res.headers.get("Location") || "";
    if (res.status === 302 && location && !location.endsWith("/404")) {
      return location.replace(/^http:/, "https:");
    }
  } catch {
    // 忽略，走降级
  }
  return null;
}

/** 获取 LRC 歌词原文 */
export async function getLyric(id: string): Promise<string> {
  const res = await fetch(
    `https://music.163.com/api/song/lyric?id=${id}&lv=1&kv=1&tv=-1`,
    { headers: { "User-Agent": UA, Referer: "https://music.163.com/" } }
  );
  const data = (await res.json()) as { lrc?: { lyric?: string }; nolyric?: boolean };
  if (data.nolyric) return "";
  return data.lrc?.lyric || "";
}

export async function getLyricSafe(id: string): Promise<string> {
  try {
    return await getLyric(id);
  } catch {
    return "";
  }
}

/** 网易云搜索：官方接口失败（被拦/风控）时自动切 netstart 镜像（Cloudflare 托管，稳定可达） */
export async function searchNetease(kw: string, limit = 10): Promise<SearchHit[]> {
  const official = await searchNeteaseOfficial(kw, limit);
  if (official.length) return official;
  return searchNeteaseMirror(kw, limit);
}

/** 批量取网易云封面：官方 song/detail 失败时切 netstart 镜像（CF→CF 稳定可达） */
async function fetchNeteaseCoverMap(ids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (!ids.length) return map;
  const detailUrls = [
    `https://music.163.com/api/song/detail?ids=${encodeURIComponent(JSON.stringify(ids))}`,
    `https://apis.netstart.cn/music/song/detail?ids=${encodeURIComponent(JSON.stringify(ids))}`,
  ];
  for (const u of detailUrls) {
    try {
      const dres = await fetch(u, { headers: { "User-Agent": UA, Referer: "https://music.163.com/" } });
      const ddata = (await dres.json()) as { songs?: Array<{ id?: number; album?: { picUrl?: string } }> };
      for (const s of ddata.songs || []) {
        if (s.id && s.album?.picUrl) map.set(s.id, toHttps(s.album.picUrl));
      }
      if (map.size) break;
    } catch {
      // 换下一个来源
    }
  }
  return map;
}

function mapNeteaseSongs(songs: Array<Record<string, unknown>>, coverMap: Map<number, string>): SearchHit[] {
  return songs
    .map((s): SearchHit | null => {
      const id = Number(s.id);
      const name = String(s.name ?? "");
      if (!id || !name) return null;
      const artists = Array.isArray(s.artists) ? (s.artists as Array<{ name?: string }>) : [];
      const album = (s.album as { name?: string } | undefined) || {};
      return {
        source: "netease" as const,
        songId: String(id),
        title: name,
        artist: artists.map(a => a.name).filter(Boolean).join(" / ") || "未知歌手",
        album: album.name || "",
        cover: coverMap.get(id) || "",
        vip: [1, 4, 16].includes(Number(s.fee ?? 0)),
        duration: Math.round(Number(s.duration ?? 0) / 1000),
      };
    })
    .filter((s): s is SearchHit => s !== null);
}

/** 官方接口：fee 0/8=免费，1/4/16=VIP */
async function searchNeteaseOfficial(kw: string, limit = 10): Promise<SearchHit[]> {
  try {
    const res = await fetch(
      `https://music.163.com/api/search/get?s=${encodeURIComponent(kw)}&type=1&limit=${limit}`,
      { headers: { "User-Agent": UA, Referer: "https://music.163.com/" } }
    );
    const data = (await res.json()) as {
      result?: { songs?: Array<Record<string, unknown>> };
    };
    const songs = (data.result?.songs || []).filter(s => Number(s.id) && s.name);
    if (!songs.length) return [];
    const coverMap = await fetchNeteaseCoverMap(songs.map(s => Number(s.id)));
    return mapNeteaseSongs(songs, coverMap);
  } catch {
    return [];
  }
}

/** netstart 镜像（NeteaseCloudMusicApi 部署）：官方接口被拦时的备用搜索 */
async function searchNeteaseMirror(kw: string, limit = 10): Promise<SearchHit[]> {
  try {
    const res = await fetch(
      `https://apis.netstart.cn/music/search?keywords=${encodeURIComponent(kw)}&limit=${limit}`,
      { headers: { "User-Agent": UA, Referer: "https://music.163.com/" } }
    );
    const data = (await res.json()) as {
      result?: { songs?: Array<Record<string, unknown>> };
    };
    const songs = (data.result?.songs || []).filter(s => Number(s.id) && s.name);
    if (!songs.length) return [];
    const coverMap = await fetchNeteaseCoverMap(songs.map(s => Number(s.id)));
    return mapNeteaseSongs(songs, coverMap);
  } catch {
    return [];
  }
}
