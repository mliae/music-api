/** QQ 音乐：搜索（client_search_cp + smartbox 兜底）、单曲详情、gtimg 封面 */
import { UA, type SearchHit } from "./types";

export function qqCoverUrl(albummid: string): string {
  return albummid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albummid}.jpg` : "";
}

/** QQ 单曲详情（公开接口）：补 albummid→封面、VIP、时长 */
export async function getQQSongDetail(
  mid: string
): Promise<{ albummid: string; vip: boolean; duration: number } | null> {
  try {
    const res = await fetch(
      `https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid=${encodeURIComponent(mid)}&format=json`,
      { headers: { "User-Agent": UA, Referer: "https://y.qq.com/" } }
    );
    const data = (await res.json()) as {
      data?: Array<{ album?: { mid?: string }; pay?: { payplay?: number }; interval?: number }>;
    };
    const s = data.data?.[0];
    if (!s) return null;
    return {
      albummid: s.album?.mid || "",
      vip: s.pay?.payplay === 1,
      duration: Number(s.interval ?? 0),
    };
  } catch {
    return null;
  }
}

/** QQ 音乐搜索：pay.payplay=1 为 VIP；主源不可用（CF 出口被拦等）时回退 smartbox 联想 */
export async function searchQQ(kw: string, limit = 10): Promise<SearchHit[]> {
  const primary = await searchQQPrimary(kw, limit);
  if (primary.length) return primary;
  return searchQQFallback(kw, limit);
}

async function searchQQPrimary(kw: string, limit: number): Promise<SearchHit[]> {
  try {
    const res = await fetch(
      `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(kw)}&format=json&n=${limit}&p=1&cr=1&t=0`,
      { headers: { "User-Agent": UA, Referer: "https://y.qq.com/" } }
    );
    const data = (await res.json()) as {
      data?: { song?: { list?: Array<Record<string, unknown>> } };
    };
    return (data.data?.song?.list || [])
      .map((s): SearchHit | null => {
        const songmid = String(s.songmid ?? s.songid ?? "");
        const songname = String(s.songname ?? "");
        if (!songmid || !songname) return null;
        const singers = Array.isArray(s.singer) ? (s.singer as Array<{ name?: string }>) : [];
        const albummid = String(s.albummid ?? "");
        const pay = s.pay as { payplay?: number } | undefined;
        return {
          source: "qq" as const,
          songId: songmid,
          title: songname,
          artist: singers.map(a => a.name).filter(Boolean).join(" / ") || "未知歌手",
          album: String(s.albumname ?? ""),
          cover: qqCoverUrl(albummid),
          vip: pay?.payplay === 1,
          duration: Number(s.interval ?? 0),
        };
      })
      .filter((s): s is SearchHit => s !== null);
  } catch {
    return [];
  }
}

/** smartbox 联想搜索（仅 mid/歌名/歌手）→ 逐个补详情拿封面/VIP/时长 */
async function searchQQFallback(kw: string, limit: number): Promise<SearchHit[]> {
  try {
    const res = await fetch(
      `https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key=${encodeURIComponent(kw)}&format=json`,
      { headers: { "User-Agent": UA, Referer: "https://y.qq.com/" } }
    );
    const data = (await res.json()) as {
      data?: { song?: { itemlist?: Array<{ mid?: string; name?: string; singer?: string }> } };
    };
    const list = (data.data?.song?.itemlist || []).filter(s => s.mid && s.name).slice(0, limit);
    if (!list.length) return [];
    const details = await Promise.all(list.map(s => getQQSongDetail(s.mid as string)));
    return list
      .map((s, i): SearchHit | null => {
        const d = details[i];
        return {
          source: "qq",
          songId: String(s.mid),
          title: String(s.name),
          artist: s.singer || "未知歌手",
          album: "",
          cover: qqCoverUrl(d?.albummid || ""),
          vip: d?.vip ?? false,
          duration: d?.duration ?? 0,
        };
      })
      .filter((s): s is SearchHit => s !== null);
  } catch {
    return [];
  }
}
