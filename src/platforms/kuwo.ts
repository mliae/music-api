/** 酷我音乐：r.s 返回单引号 JSON；songId 取 MUSICRID 数字，封面常缺失 */
import { UA, type SearchHit } from "./types";

export async function searchKuwo(kw: string, limit = 10): Promise<SearchHit[]> {
  try {
    const res = await fetch(
      `https://search.kuwo.cn/r.s?all=${encodeURIComponent(kw)}&ft=music&rformat=json&encoding=utf8&rn=${limit}&pn=0`,
      { headers: { "User-Agent": UA, Referer: "https://www.kuwo.cn/" } }
    );
    const text = (await res.text()).trim();
    if (!text || text.startsWith("<")) return [];
    const data = JSON.parse(text.replace(/'/g, '"')) as {
      abslist?: Array<Record<string, string>>;
    };
    return (data.abslist || [])
      .map((s): SearchHit | null => {
        const rid = String(s.MUSICRID ?? "");
        const m = /_(\d+)$/.exec(rid);
        const name = String(s.SONGNAME ?? "").replace(/&nbsp;/g, " ").trim();
        if (!m || !name) return null;
        const pic = String(s.web_albumpic_short ?? "");
        return {
          source: "kuwo",
          songId: m[1],
          title: name,
          artist: String(s.ARTIST ?? "").replace(/&nbsp;/g, " ").trim() || "未知歌手",
          album: String(s.ALBUM ?? "").replace(/&nbsp;/g, " ").trim(),
          cover: pic ? `https://img4.kuwo.cn/star/albumcover/${pic}` : "",
          vip: Number(s.PAY ?? 0) > 0,
          duration: Number(s.DURATION ?? 0),
        };
      })
      .filter((s): s is SearchHit => s !== null);
  } catch {
    return [];
  }
}
