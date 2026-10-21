// 状態（既読・お気に入り・再生位置など）を登録フォルダ直下の「_脱ツンドク.json」と合わせる。
// 本ごとに updated が新しいほうを残す。
import { dbx, downloadText } from './dropbox.js';
import { allStates, replaceStates, kvSet, onStateChange } from './store.js';
import { SYNC_FILE } from './library.js';
import { syncAllMemos } from './memo.js';

const rootOf = (key) => key.slice(0, key.lastIndexOf('/'));
const titleOf = (key) => key.slice(key.lastIndexOf('/') + 1);
const newer = (a, b) => (a?.updated || 0) > (b?.updated || 0);

async function syncStates(folders) {
  const merged = { ...allStates() };
  let pulled = false;
  for (const root of folders) {
    const path = root + '/' + SYNC_FILE;
    const text = await downloadText(path);
    let remote = {};
    try {
      remote = (text && JSON.parse(text).books) || {};
    } catch {}
    for (const [title, rs] of Object.entries(remote)) {
      const key = root + '/' + title;
      if (!merged[key] || newer(rs, merged[key])) {
        merged[key] = rs;
        pulled = true;
      }
    }
    const out = {};
    let push = false;
    for (const [key, ls] of Object.entries(merged)) {
      if (rootOf(key) !== root) continue;
      out[titleOf(key)] = ls;
      if (!remote[titleOf(key)] || newer(ls, remote[titleOf(key)])) push = true;
    }
    if (push) await dbx.uploadText(path, JSON.stringify({ app: 'datsu-tsundoku', version: 1, books: out }, null, 1));
  }
  if (pulled) {
    // 同期中に手元で変わった分は手元を優先
    const now = allStates();
    for (const key of Object.keys(now)) if (newer(now[key], merged[key])) merged[key] = now[key];
    replaceStates(merged);
  }
  await kvSet('state-dirty', false);
}

let ctx = { folders: [], books: [] };
let running = null;
let pushTimer = null;

export function setSyncContext(folders, books) {
  ctx = { folders, books };
}

/** 状態とメモをまとめて同期する。同時に 2 本は走らせない */
export function syncNow() {
  if (!navigator.onLine || !ctx.folders.length) return Promise.resolve(false);
  if (running) return running;
  clearTimeout(pushTimer);
  running = (async () => {
    try {
      await syncStates(ctx.folders);
      await syncAllMemos(ctx.books);
      return true;
    } finally {
      running = null;
    }
  })();
  return running;
}

// 状態が変わったら少し待ってから送る（再生位置は頻繁に変わるので間引く）
onStateChange((key) => {
  if (key === null) return; // 同期で取り込んだだけの変更は送り返さない
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow().catch(() => {}), 30_000);
});
addEventListener('online', () => syncNow().catch(() => {}));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') syncNow().catch(() => {});
});
