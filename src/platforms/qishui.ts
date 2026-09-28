/** 汽水音乐：解析 / 搜索 / 热歌榜（移植自 parser.mjs，去 node:dns + Buffer） */
import { UA, type SearchHit } from "./types";

const API = "https://beta-luna.douyin.com/luna/h5/seo_track";
const SEARCH_API = "https://api.qishui.com/luna/search/track";

const ID_PATTERNS = [
  /(?:song_id|track_id|songId|trackId|mid)=(\d{12,20})/i,
  /\/(?:qishui\/)?(?:song|track|music)\/(\d{12,20})/i,
  /(\d{18,20})/,
];

export function extractId(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("输入为空：请粘贴汽水音乐的歌曲链接或歌曲 ID");
  for (const re of ID_PATTERNS) {
    const m = raw.match(re);
    if (m) return m[1];
  }
  if (/^v1[0-9a-z]{20,}$/i.test(raw)) {
    throw new Error(`识别到的是音视频 ID（${raw}），本工具需要歌曲页链接或 19 位歌曲数字 ID`);
  }
  throw new Error(`无法从输入中提取歌曲 ID：${raw.slice(0, 120)}`);
}

async function getJson(url: string) {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!res.ok) throw new Error(`接口返回 HTTP ${res.status}`);
  return res.json();
}

function buildCover(urlCover: { uri?: string; urls?: string[]; template_prefix?: string } | undefined, size: number) {
  if (!urlCover?.uri || !urlCover?.urls?.length) return null;
  const tpl = urlCover.template_prefix ?? "tplv-b829550vbb";
  return urlCover.urls.map(base => `${base}${urlCover.uri}~${tpl}-resize:${size}:${size}.image`);
}

function lrcStamp(ms: number) {
  const total = Math.max(0, Math.floor(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function krcToLrc(content: string, type: string): string {
  if (!content) return "";
  if (type !== "krc") return content;
  const lines: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const m = line.match(/^\[(\d+),\d+\](.*)$/);
    if (!m) continue;
    const text = m[2].replace(/<[^>]*>/g, "").trim();
    if (text) lines.push(`[${lrcStamp(+m[1])}]${text}`);
  }
  return lines.join("\n");
}

const QUALITY_ORDER: Record<string, number> = { lossless: 4, hi_res: 4, highest: 3, spatial: 2, higher: 2, medium: 1 };

function normalizeAudio(trackPlayer: Record<string, unknown> | undefined, labelInfo: Record<string, unknown> | undefined) {
  if (!trackPlayer?.video_model) return [];
  let model: { video_list?: Array<Record<string, unknown>>; video_duration?: number };
  try {
    model = JSON.parse(trackPlayer.video_model as string);
  } catch {
    return [];
  }
  const playMap = (labelInfo?.quality_map as Record<string, { play_detail?: { need_vip?: boolean } }>) ?? {};
  return (model.video_list ?? [])
    .map((v): Record<string, unknown> => {
      const meta = (v.video_meta as Record<string, unknown>) ?? {};
      return {
        quality: meta.quality ?? "unknown",
        quality_cn:
          ({ lossless: "无损音质", hi_res: "Hi-Res 超清", spatial: "环绕音效", highest: "极高音质", higher: "高清音质", medium: "标准音质" } as Record<string, string>)[meta.quality as string] ?? (meta.quality as string) ?? "未知",
        codec: meta.codec_type ?? "",
        container: meta.vtype ?? "",
        bitrate: meta.bitrate ?? 0,
        size: meta.size ?? 0,
        sample_rate: meta.audio_sample_rate ?? "",
        url: decodeURIComponent((v.main_url as string) ?? (v.backup_url as string) ?? ""),
        url_backup: decodeURIComponent((v.backup_url as string) ?? ""),
        need_vip: playMap[meta.quality as string]?.play_detail?.need_vip ?? false,
      };
    })
    .sort(
      (a, b) =>
        (QUALITY_ORDER[(b.quality as string) ?? ""] ?? 0) - (QUALITY_ORDER[(a.quality as string) ?? ""] ?? 0) ||
        Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0)
    );
}

export interface ParsedQishui {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration_ms: number;
  duration_s: number;
  cover: string;
  cover_urls: string[];
  lyric: string;
  audio: Array<Record<string, unknown>>;
  best: Record<string, unknown> | null;
  is_preview: boolean;
  vip_only: boolean;
}

export async function parseQishui(input: string): Promise<ParsedQishui> {
  const id = extractId(input);
  const data = (await getJson(`${API}?track_id=${encodeURIComponent(id)}`)) as Record<string, unknown>;
  if (!(data?.seo_track as Record<string, unknown>)?.track) {
    throw new Error(`未找到歌曲 ${id}（可能已下架或 ID 不对）`);
  }
  const track = ((data.seo_track as Record<string, unknown>).track as Record<string, unknown>) ?? {};
  const album = (track.album as Record<string, unknown>) ?? {};
  const lyric = (data.lyric as Record<string, unknown>) ?? {};
  const trackPlayer = (data.track_player as Record<string, unknown>) ?? {};
  const labelInfo = (track.label_info as Record<string, unknown>) ?? {};

  const audioList = normalizeAudio(trackPlayer, labelInfo);
  const fullDurationMs = Number(track.duration ?? 0);
  const modelDurationS = trackPlayer.video_model
    ? JSON.parse(trackPlayer.video_model as string).video_duration ?? 0
    : 0;
  const isPreview = Number(modelDurationS) > 0 && Number(modelDurationS) * 1000 < fullDurationMs - 1000;
  const coverList = buildCover(album.url_cover as { uri?: string; urls?: string[]; template_prefix?: string }, 1080) ?? [];

  return {
    id: String(track.id ?? id),
    title: String(track.name ?? ""),
    artist: (Array.isArray(track.artists) ? track.artists : [])
      .map((a: Record<string, unknown>) => String(a.name ?? a.simple_display_name ?? ""))
      .filter(Boolean)
      .join(" / ") || "未知歌手",
    album: String(album.name ?? ""),
    duration_ms: fullDurationMs,
    duration_s: Math.round(fullDurationMs / 1000),
    cover: coverList[0] ?? "",
    cover_urls: coverList,
    lyric: krcToLrc(String(lyric.content ?? ""), String(lyric.type ?? "")),
    audio: audioList,
    best: (audioList.find((a: Record<string, unknown>) => !a.need_vip && a.url) ?? audioList[0] ?? null) as Record<string, unknown> | null,
    is_preview: isPreview,
    vip_only: labelInfo.only_vip_playable === true,
  };
}

export async function searchQishui(kw: string, count = 20, cursor = 0): Promise<SearchHit[]> {
  const q = String(kw ?? "").trim();
  if (!q) throw new Error("搜索关键词不能为空");
  const url = new URL(SEARCH_API);
  Object.entries({ q, count, cursor, aid: "386088", app_name: "luna", device_platform: "android", os: "android" }).forEach(
    ([k, v]) => url.searchParams.set(k, String(v))
  );
  const data = (await getJson(url.toString()).catch(() => null)) as Record<string, unknown> | null;
  const group = (Array.isArray(data?.result_groups) ? (data.result_groups as Array<Record<string, unknown>>) : []).find(
    (g: Record<string, unknown>) => g.id === "tracks"
  );
  const items = (Array.isArray(group?.data) ? (group.data as Array<Record<string, unknown>>) : [])
    .map((entry): SearchHit | null => {
      const t = ((entry?.entity as Record<string, unknown>)?.track as Record<string, unknown>) || {};
      if (!t?.id) return null;
      return {
        source: "qishui",
        songId: String(t.id),
        title: String(t.name ?? ""),
        artist: (Array.isArray(t.artists) ? t.artists : [])
          .map((a: Record<string, unknown>) => String(a.name ?? ""))
          .filter(Boolean)
          .join(" / ") || "未知歌手",
        album: String((t.album as Record<string, unknown>)?.name ?? ""),
        cover: buildCover((t.album as Record<string, unknown>)?.url_cover as { uri?: string; urls?: string[] }, 300)?.[0] ?? "",
        vip: false,
        duration: Math.round(Number(t.duration ?? 0) / 1000),
      };
    })
    .filter((s): s is SearchHit => s !== null);

  if (items.length) return items;
  // 搜索网关无结果或失效时，退回官方热歌榜并按关键词过滤
  const hot = await hotSongs();
  const matched = hot.filter(
    (s: SearchHit) => s.title.includes(q) || s.artist.includes(q)
  );
  return matched.length ? matched : hot;
}

/** 官方首页热歌榜 */
export async function hotSongs(): Promise<SearchHit[]> {
  const data = (await getJson("https://music.douyin.com/api/home/hot-content")) as Record<string, unknown>;
  return (Array.isArray((data?.data as Record<string, unknown>)?.hotSongs) ? ((data.data as Record<string, unknown>).hotSongs as Array<Record<string, unknown>>) : [])
    .map((s): SearchHit | null => {
      const id = String(s.songId ?? "");
      if (!id) return null;
      return {
        source: "qishui",
        songId: id,
        title: String(s.title ?? ""),
        artist: String(s.artist ?? ""),
        album: "",
        cover: String(s.coverUrl ?? ""),
        vip: false,
        duration: 0,
      };
    })
    .filter((s): s is SearchHit => s !== null);
}

// 同一张图在 p3/p6/p9/p11 等多个图床上有镜像，某个节点不通时换下一个
function douyinPicFallbacks(url: string): string[] {
  const m = url.match(/^https:\/\/(p\d+)-(luna-)?(douyinpic\.com)(\/.*)$/);
  if (!m) return [];
  return [11, 9, 26]
    .filter(n => !url.includes(`p${n}-`))
    .map(n => `https://p${n}-${m[2] ?? ""}${m[3]}${m[4]}`);
}

/** 下载汽水资源（音频/封面），多镜像兜底 */
export async function fetchBuffer(urls: string | string[]): Promise<ArrayBuffer> {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  const candidates = [...list, ...list.flatMap(douyinPicFallbacks)];
  let lastError: Error | null = null;
  for (const target of candidates) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(target, { headers: { "user-agent": UA } });
        if (!res.ok) {
          lastError = new Error(`资源下载失败 HTTP ${res.status}`);
          continue;
        }
        return await res.arrayBuffer();
      } catch (err) {
        lastError = new Error(`资源下载失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  throw lastError ?? new Error("资源下载失败");
}
