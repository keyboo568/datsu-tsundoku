// 不動産実例：登録フォルダ直下の「〜実例一覧.csv」を読み、1 行＝1 物件のカードにする。
// CSV は小さいので本棚の読み込みと一緒に取りに行き、端末にも保存する（オフラインでも見られる）。
import { downloadText } from './dropbox.js';
import { kvGet, kvSet } from './store.js';

export const CASE_FILE = /実例一覧\.csv$/i;

/** CSV（RFC 4180。"" で囲んだ中の改行・カンマ・"" に対応）を { header, rows } にする */
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const records = [];
  let field = '';
  let record = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      field = '';
      record = [];
    } else field += c;
  }
  if (field || record.length) {
    record.push(field);
    records.push(record);
  }
  const header = (records.shift() || []).map((h) => h.trim());
  const rows = records
    .filter((r) => r.some((v) => v.trim()))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
  return { header, rows };
}

/** 本棚の読み込みのついでに呼ぶ。rev が変わった CSV だけ取り直す */
export async function refreshCases(caseFiles) {
  const prev = (await kvGet('cases')) || { files: {} };
  const files = {};
  for (const f of caseFiles) {
    const old = prev.files[f.path];
    if (old && old.rev === f.rev) {
      files[f.path] = old;
      continue;
    }
    try {
      const text = await downloadText(f.path);
      if (text !== null) files[f.path] = { rev: f.rev, ...parseCsv(text) };
    } catch {
      if (old) files[f.path] = old; // 読めなかったら前回の分を使う
    }
  }
  await kvSet('cases', { files });
}

/** すべての実例 { header（列の並び）, rows } */
export async function loadCases() {
  const { files } = (await kvGet('cases')) || { files: {} };
  const header = [];
  const rows = [];
  for (const f of Object.values(files)) {
    for (const h of f.header) if (!header.includes(h)) header.push(h);
    rows.push(...f.rows);
  }
  return { header, rows };
}

/** 取得年月から「2010年代」などを出す。西暦が読めなければ「不明」 */
export function decadeOf(row) {
  const m = /((?:19|20)\d)\d/.exec(row['取得年月'] || '');
  return m ? m[1] + '0年代' : '不明';
}
