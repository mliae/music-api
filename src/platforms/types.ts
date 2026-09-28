/** 平台共享类型与常量 */

export type MusicSource = "netease" | "qq" | "kugou" | "kuwo" | "qishui";

export const SOURCES: readonly MusicSource[] = ["netease", "qq", "kugou", "kuwo", "qishui"];

export interface SearchHit {
  source: MusicSource;
  songId: string;
  title: string;
  artist: string;
  album: string;
  cover: string;
  vip: boolean;
  duration: number; // 秒
}

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** http 资源升级为 https（HTTPS 页面混合内容会被浏览器拦截） */
export function toHttps(url: string): string {
  return url ? url.replace(/^http:\/\//i, "https://") : "";
}
