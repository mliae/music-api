/** 酷狗音乐：公开 songsearch 接口；songId 用 FileHash，入库/试听需解析通道 */
import { UA, type SearchHit } from "./types";

export async function searchKugou(kw: string, limit = 10): Promise<SearchHit[]> {
  try {
    const res = await fetch(
      `https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(kw)}&page=1&pagesize=${limit}`,
      { headers: { "User-Agent": UA } }
    );
    const data = (await res.json()) as {
      data?: { lists?: Array<Record<string, unknown>> };
    };
    return (data.data?.lists || [])
      .map((s): SearchHit | null => {
        const hash = String(s.FileHash ?? "");
        const name = String(s.SongName ?? "").replace(/<[^>]+>/g, "");
        if (!hash || !name) return null;
        const albumId = String(s.AlbumID ?? "");
        return {
          source: "kugou",
          songId: hash,
          title: name,
          artist: String(s.Singer ?? "").replace(/<[^>]+>/g, "") || "未知歌手",
          album: String(s.AlbumName ?? "").replace(/<[^>]+>/g, ""),
          cover:
            (String(s.Image ?? "").trim() || "").replace("{size}", "480").replace(/^http:/, "https:") ||
            (albumId ? `https://imge.kugou.com/stdmusic/300/${albumId}.jpg` : ""),
          vip: Number(s.Privilege ?? 0) < 10,
          duration: Number(s.Duration ?? 0),
        };
      })
      .filter((s): s is SearchHit => s !== null);
  } catch {
    return [];
  }
}
