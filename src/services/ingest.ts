/** 入库链路：聚合解析下载音频 + 封面 + 歌词（五平台统一） */
import { UA, type MusicSource } from "../platforms/types";
import { getOuterUrl, getLyricSafe, searchNetease } from "../platforms/netease";
import { getQQSongDetail, qqCoverUrl, searchQQ } from "../platforms/qq";
import { fetchBuffer, parseQishui, type ParsedQishui } from "../platforms/qishui";

export const TRIAL_MIN_BYTES = 1.5 * 1024 * 1024; // 小于 1.5MB 视为试听片段
export const MAX_AUDIO_BYTES = 60 * 1024 * 1024; // 上传/转存上限 60MB

export const AUDIO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  wav: "audio/wav",
  ogg: "audio/ogg",
};

/** 音频魔数判断（防把 HTML 错误页当音频入库） */
export function audioExt(buf: ArrayBuffer): string {
  const u = new Uint8Array(buf.slice(0, 16));
  if (u[0] === 0x49 && u[1] === 0x44 && u[2] === 0x33) return "mp3"; // ID3
  if (u[0] === 0xff && (u[1] & 0xe0) === 0xe0) return "mp3"; // MPEG frame
  if (u.length >= 8 && String.fromCharCode(u[4], u[5], u[6], u[7]) === "ftyp") return "m4a";
  const head4 = String.fromCharCode(u[0], u[1], u[2], u[3]);
  if (head4 === "fLaC") return "flac";
  if (head4 === "RIFF") return "wav";
  if (head4 === "OggS") return "ogg";
  return "";
}

export function looksLikeImage(buf: ArrayBuffer): string {
  const u = new Uint8Array(buf.slice(0, 16));
  if (u[0] === 0xff && u[1] === 0xd8) return "jpg";
  if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e) return "png";
  if (u.length >= 12 && String.fromCharCode(u[8], u[9], u[10], u[11]) === "WEBP") return "webp";
  if (u[0] === 0x47 && u[1] === 0x49 && u[2] === 0x46) return "gif";
  return "";
}

export function newKey(kind: "audio" | "cover", ext: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `music/${kind}-${ts}${rand}.${ext}`;
}

export interface ResolvedAudio {
  buf: ArrayBuffer;
  via: string;
}

type Cand = { label: string; make: () => Promise<Response | null> };

function directFetch(url: string, referer?: string): () => Promise<Response | null> {
  return async () => {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, ...(referer ? { Referer: referer } : {}) },
      });
      return res.ok ? res : null;
    } catch {
      return null;
    }
  };
}

function meting(server: string, id: string): () => Promise<Response | null> {
  return directFetch(`https://api.injahow.cn/meting/?server=${server}&type=url&id=${id}`);
}

/**
 * 聚合解析 + 下载音频：
 *  - 网易云：outer 302 → meting(netease) → meting(tencent) → 跨平台 QQ 同名
 *  - QQ：meting(tencent) → 跨平台网易/QQ 同名
 *  - 酷狗：qijieya meting → 跨平台
 *  - 酷我：跨平台网易/QQ 同名
 *  - 汽水：官方 best 直链（VIP 仅试听片段，会被 <1.5MB 过滤换源）→ 跨平台
 * <1.5MB 的试听片段跳过换源；全失败返回 null（不入库）。
 */
export async function resolveAudio(
  songId: string,
  source: MusicSource,
  title: string,
  artist: string,
  qishuiParsed?: ParsedQishui | null
): Promise<ResolvedAudio | null> {
  const cands: Cand[] = [];

  const addCrossCandidates = async (t: string, a: string) => {
    const neHits = await searchNetease(`${t} ${a}`, 1);
    if (neHits[0]) {
      const outer = await getOuterUrl(neHits[0].songId);
      if (outer) cands.push({ label: "cross-netease-outer", make: directFetch(outer, "https://music.163.com/") });
      cands.push({ label: "cross-netease-meting", make: meting("netease", neHits[0].songId) });
    }
    const qqHits = await searchQQ(`${t} ${a}`, 1);
    if (qqHits[0]) cands.push({ label: "cross-qq", make: meting("tencent", qqHits[0].songId) });
  };

  if (source === "netease") {
    const outer = await getOuterUrl(songId);
    if (outer) cands.push({ label: "netease-outer", make: directFetch(outer, "https://music.163.com/") });
    cands.push({ label: "meting-netease", make: meting("netease", songId) });
    cands.push({ label: "meting-tencent", make: meting("tencent", songId) });
    const qqHits = await searchQQ(`${title} ${artist}`, 1);
    if (qqHits[0]) cands.push({ label: "cross-qq", make: meting("tencent", qqHits[0].songId) });
  } else if (source === "qq") {
    cands.push({ label: "meting-tencent", make: meting("tencent", songId) });
    await addCrossCandidates(title, artist);
  } else if (source === "kugou") {
    cands.push({
      label: "kugou-qijieya",
      make: directFetch(`https://api.qijieya.cn/meting/?server=kugou&type=url&id=${encodeURIComponent(songId)}`),
    });
    await addCrossCandidates(title, artist);
  } else if (source === "qishui") {
    // 汽水：用已解析的 best 直链；title/artist 以解析结果为准（搜索页数据可能不全）
    const p = qishuiParsed ?? (await parseQishui(songId).catch(() => null));
    if (p?.best?.url) {
      const bestUrl = String(p.best.url);
      const backupUrl = String(p.best.url_backup || "");
      cands.push({ label: "qishui-direct", make: directFetch(bestUrl) });
      if (backupUrl) cands.push({ label: "qishui-backup", make: directFetch(backupUrl) });
    }
    await addCrossCandidates(p?.title || title, p?.artist || artist);
  } else {
    // 酷我：无公开解析通道，跨平台到网易云、QQ 同名搜索
    await addCrossCandidates(title, artist);
  }

  for (const cand of cands) {
    try {
      const res = await cand.make();
      if (!res) continue;
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("text/html")) continue; // 上游错误提示页
      const len = Number(res.headers.get("content-length") || 0);
      if (len && len > MAX_AUDIO_BYTES) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength < TRIAL_MIN_BYTES) continue; // 试听片段：换源
      if (buf.byteLength > MAX_AUDIO_BYTES) continue;
      if (!audioExt(buf)) continue;
      return { buf, via: cand.label };
    } catch {
      continue;
    }
  }
  return null;
}

/** 下载封面图片（126.net 有 Referer 防盗链，QQ gtimg 不需要） */
async function fetchImage(url: string): Promise<{ buf: ArrayBuffer; ext: string } | null> {
  try {
    const referer = url.includes("126.net")
      ? "https://music.163.com/"
      : url.includes("gtimg")
        ? "https://y.qq.com/"
        : undefined;
    const res = await fetch(url, { headers: { "User-Agent": UA, ...(referer ? { Referer: referer } : {}) } });
    if (!res.ok || !res.body) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 1024 || buf.byteLength > 5 * 1024 * 1024) return null;
    const ext = looksLikeImage(buf);
    return ext ? { buf, ext } : null;
  } catch {
    return null;
  }
}

/** 汽水封面下载：官方多镜像 URL + p3/p6/p9/p11 图床兜底 */
async function fetchQishuiCover(parsed: ParsedQishui | null): Promise<{ buf: ArrayBuffer; ext: string } | null> {
  if (!parsed) return null;
  try {
    const buf = await fetchBuffer(parsed.cover_urls.length ? parsed.cover_urls : parsed.cover);
    if (buf.byteLength < 1024 || buf.byteLength > 5 * 1024 * 1024) return null;
    const ext = looksLikeImage(buf);
    return ext ? { buf, ext } : null;
  } catch {
    return null;
  }
}

/** 封面下载：优先给定 URL；失败或为空时按来源兜底——
 *  网易→meting pic；QQ→单曲详情拿 albummid 拼 gtimg；酷狗→qijieya pic；
 *  酷我→120 小图升 500 大图；汽水→官方多镜像；最终跨平台网易同名封面 */
export async function downloadCover(
  coverUrl: string,
  source?: string,
  songId?: string,
  title?: string,
  artist?: string,
  qishuiParsed?: ParsedQishui | null
): Promise<{ buf: ArrayBuffer; ext: string } | null> {
  if (coverUrl) {
    const hit = await fetchImage(coverUrl);
    if (hit) return hit;
  }
  if (source === "netease" && songId) {
    return fetchImage(`https://api.injahow.cn/meting/?server=netease&type=pic&id=${encodeURIComponent(songId)}`);
  }
  if (source === "qq" && songId) {
    const d = await getQQSongDetail(songId);
    return d?.albummid ? fetchImage(qqCoverUrl(d.albummid)) : null;
  }
  if (source === "kugou" && songId) {
    const hit = await fetchImage(`https://api.qijieya.cn/meting/?server=kugou&type=pic&id=${encodeURIComponent(songId)}`);
    if (hit) return hit;
    if (title) {
      const neHits = await searchNetease(`${title} ${artist || ""}`.trim(), 1);
      if (neHits[0]?.cover) return fetchImage(neHits[0].cover);
    }
    return null;
  }
  if (source === "qishui") {
    const hit = await fetchQishuiCover(qishuiParsed ?? null);
    if (hit) return hit;
  }
  if (source === "kuwo") {
    // 搜索结果给的是 120 小图，优先换 500 大图入库
    if (coverUrl && coverUrl.includes("/120/")) {
      const big = await fetchImage(coverUrl.replace(/\/120\//, "/500/"));
      if (big) return big;
    }
    if (title) {
      const neHits = await searchNetease(`${title} ${artist || ""}`.trim(), 1);
      if (neHits[0]?.cover) return fetchImage(neHits[0].cover);
    }
  }
  // 最终兜底：有歌名就跨平台搜网易同名封面（upload/url 等无来源封面场景）
  if (title) {
    const neHits = await searchNetease(`${title} ${artist || ""}`.trim(), 1);
    if (neHits[0]?.cover) return fetchImage(neHits[0].cover);
  }
  return null;
}

/** meting 取 LRC 原文：QQ→injahow(tencent)；酷狗→qijieya(kugou) */
async function metingLrc(server: string, id: string): Promise<string> {
  try {
    const base = server === "kugou" ? "https://api.qijieya.cn/meting/" : "https://api.injahow.cn/meting/";
    const res = await fetch(`${base}?server=${server}&type=lrc&id=${encodeURIComponent(id)}`, {
      headers: { "User-Agent": UA },
    });
    if (!res.ok) return "";
    const text = (await res.text()).trim();
    return text && !text.startsWith("<") && text.includes("[") ? text : "";
  } catch {
    return "";
  }
}

/** 歌词链路：网易直接取；QQ→meting；酷狗→qijieya；汽水→解析自带 KRC 转 LRC；其余跨平台网易同名 */
export async function fetchLyric(
  source: string,
  songId: string,
  title: string,
  artist: string,
  qishuiParsed?: ParsedQishui | null
): Promise<string> {
  if (source === "netease") return getLyricSafe(songId);
  if (source === "qq") return metingLrc("tencent", songId);
  if (source === "kugou") return metingLrc("kugou", songId);
  if (source === "qishui") {
    if (qishuiParsed?.lyric) return qishuiParsed.lyric;
    const neHits = await searchNetease(`${title} ${artist}`, 1);
    return neHits[0] ? getLyricSafe(neHits[0].songId) : "";
  }
  // kuwo / upload / url 等：跨平台网易同名
  const neHits = await searchNetease(`${title} ${artist}`, 1);
  return neHits[0] ? getLyricSafe(neHits[0].songId) : "";
}

/** 试听地址解析：返回可直接给 <audio> 播放的 URL + VIP 标识；
 *  汽水 VIP 歌曲只会播出试听片段 */
export async function resolvePreviewUrl(
  source: MusicSource,
  id: string,
  title: string,
  artist: string
): Promise<{ url: string | null; vip?: boolean }> {
  if (source === "netease") {
    const outer = await getOuterUrl(id);
    return { url: outer || `https://api.injahow.cn/meting/?server=netease&type=url&id=${encodeURIComponent(id)}` };
  }
  if (source === "qq") {
    return { url: `https://api.injahow.cn/meting/?server=tencent&type=url&id=${encodeURIComponent(id)}` };
  }
  if (source === "kugou") {
    return { url: `https://api.qijieya.cn/meting/?server=kugou&type=url&id=${encodeURIComponent(id)}` };
  }
  if (source === "qishui") {
    const p = await parseQishui(id).catch(() => null);
    if (p?.best?.url) return { url: String(p.best.url), vip: p.vip_only === true };
    // 解析失败则跨平台兜底
  }
  // 酷我 / 汽水兜底：按「歌名 歌手」到网易云找同名音源
  if (!title) return { url: null };
  const neHits = await searchNetease(`${title} ${artist}`.trim(), 1);
  if (!neHits[0]) return { url: null };
  const outer = await getOuterUrl(neHits[0].songId);
  return { url: outer || `https://api.injahow.cn/meting/?server=netease&type=url&id=${encodeURIComponent(neHits[0].songId)}` };
}
