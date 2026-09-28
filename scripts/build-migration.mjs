// 从博客导出的 tracks JSON 生成带原 id 的 INSERT 语句
import fs from "node:fs";

const raw = fs.readFileSync(process.argv[2], "utf8");
const start = raw.indexOf("[");
const data = JSON.parse(raw.slice(start));
const rows = data[0].results;
const esc = s => String(s ?? "").replace(/'/g, "''");
const stmts = rows.map(
  r =>
    `INSERT INTO tracks (id,title,artist,album,source,source_id,vip,audio_key,cover_key,lyric,duration,enabled,tag,created_at) VALUES (${r.id},'${esc(r.title)}','${esc(r.artist)}','${esc(r.album)}','${esc(r.source)}','${esc(r.source_id)}',${r.vip},'${esc(r.audio_key)}','${esc(r.cover_key)}','${esc(r.lyric)}',${r.duration},${r.enabled},'${esc(r.tag || "")}','${esc(r.created_at)}');`
);
fs.writeFileSync(process.argv[3], stmts.join("\n"), "utf8");
console.log("rows:", rows.length, "ids:", rows.map(r => r.id).join(","));
