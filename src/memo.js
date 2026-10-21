// メモ：1 冊に 1 枚。本のフォルダの「⑥メモ_書名.md」の中身をそのまま 1 枚のメモとして読み書きする。
// オフラインで書き換えた分は手元に残し、つながったら Dropbox に送る。
import { dbx, downloadText } from './dropbox.js';
import { kvGet, kvSet } from './store.js';
import { MEMO_PREFIX } from './library.js';

// 端末内：{ [bookKey]: { text, base, rev, dirty, updated } }
//   base = 最後に Dropbox と合わせたときの中身（よそで書き換えられたかの判定に使う）
let memos = null;
const load = async () => (memos ??= (await kvGet('memos-v2')) || {});
const save = () => kvSet('memos-v2', memos);

export const memoPath = (book) => (book.folder || book.root) + '/' + MEMO_PREFIX + book.title + '.md';

export const fmtTime = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return (h ? h + ':' + pad(m) : m) + ':' + pad(sec % 60);
};

/** v1.02 までの形式（# 書名 メモ / ## 日時 ｜ 位置 / <!-- id:… -->）から、見出しと記録用の行を外して本文だけにする */
function fromLegacy(md) {
  md = md.replace(/\r\n?/g, '\n'); // 入力欄は LF になるので、Windows の改行（CRLF）もそろえておく
  if (!/<!-- id:/.test(md)) return md;
  return md
    .split(/\r?\n/)
    .filter((line) => !/^# .*メモ\s*$/.test(line) && !/^## (\d{4}-\d\d-\d\d \d\d:\d\d|メモ)/.test(line) && !/^<!--.*-->\s*$/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function getMemo(key) {
  await load();
  return memos[key]?.text || '';
}

/** 中身のあるメモ（最近書いた順） */
export async function allMemos() {
  await load();
  return Object.entries(memos)
    .filter(([, m]) => m.text.trim())
    .map(([key, m]) => ({ key, text: m.text, updated: m.updated || 0 }))
    .sort((a, b) => b.updated - a.updated);
}

export async function saveMemo(book, text) {
  await load();
  const m = (memos[book.key] ??= { text: '', base: null, rev: null });
  Object.assign(m, { text, dirty: true, updated: Date.now() });
  await save();
  syncBookMemo(book).catch(() => {}); // オフラインなら次の同期で
}

let running = Promise.resolve();
/** 1 冊ぶんのメモを Dropbox と合わせる */
export function syncBookMemo(book) {
  running = running.catch(() => {}).then(async () => {
    await load();
    const m = (memos[book.key] ??= { text: '', base: null, rev: null });
    const remoteRev = book.memoFile?.rev || null;
    if (!m.dirty) {
      if (!remoteRev || m.rev === remoteRev) return;
      const raw = (await downloadText(memoPath(book))) ?? '';
      const text = fromLegacy(raw);
      memos[book.key] = { text, base: raw, rev: remoteRev, updated: m.text === text ? m.updated : Date.now() };
      return save();
    }
    // 手元で書き換えた分を送る。その間に PC などで書き換えられていたら、消さずに下へ残す
    const remote = (await downloadText(memoPath(book))) ?? '';
    let text = m.text;
    if (remote !== m.base && remote.trim() && remote.trim() !== text.trim()) {
      text = `${text.trimEnd()}\n\n---（ほかの端末で書かれた内容）---\n${fromLegacy(remote).trim()}\n`;
    }
    await dbx.uploadText(memoPath(book), text);
    memos[book.key] = { text, base: text, rev: 'local', updated: m.updated };
    await save();
  });
  return running;
}

export async function syncAllMemos(books) {
  for (const b of books) await syncBookMemo(b);
}
