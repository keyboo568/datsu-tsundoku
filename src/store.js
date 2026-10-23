// 端末内の保存：設定・本ごとの状態・ダウンロード（OPFS）・表紙画像。
import { get, set, del, createStore } from 'idb-keyval';
import { dbx } from './dropbox.js';

const kv = createStore('datsu-kv', 'kv');
const thumbs = createStore('datsu-thumbs', 'thumbs');

export const kvGet = (k) => get(k, kv);
export const kvSet = (k, v) => set(k, v, kv);
export const kvDel = (k) => del(k, kv);

// ---------- 本ごとの状態 ----------
// { status: 'unread'|'reading'|'done', fav, lastOpened, lastPlayed, kind: 'summary'|'full',
//   audio: { summary: {i, t}, full: {i, t} }, durations: {path: 秒}, pdfPage, view: 'mindmap'|'pdf', updated }

let state = {};
const subscribers = new Set();
let saveTimer = null;

export async function loadState() {
  state = (await kvGet('state')) || {};
}

export const allStates = () => state;

export function bookState(key) {
  return state[key] || null;
}

/** 状態を更新する。updated を進めるので、次の同期で Dropbox 側にも反映される */
export function updateBook(key, patch) {
  const cur = state[key] || {};
  state[key] = { ...cur, ...patch, updated: Date.now() };
  scheduleSave();
  kvSet('state-dirty', true);
  subscribers.forEach((fn) => fn(key));
}

/** まだ状態がない本に初期値を入れる。updated=0 なので、他の端末で付けた状態があればそちらが勝つ */
export function seedBook(key, initial) {
  if (state[key]) return;
  state[key] = { ...initial, updated: 0 };
  scheduleSave();
}

/** 同期で取り込んだ状態をそのまま入れる（updated は進めない） */
export function replaceStates(next) {
  state = next;
  scheduleSave();
  subscribers.forEach((fn) => fn(null));
}

export function onStateChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => kvSet('state', state), 300);
}

export const flushState = () => kvSet('state', state);

// ---------- 表紙 ----------

export const getThumb = (key) => get(key, thumbs);
export const setThumb = (key, blob) => set(key, blob, thumbs);

// ---------- ダウンロード（端末のアプリ専用領域 OPFS に保存） ----------

const KEEP_DAYS = 14;

const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
};

async function booksDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('books', { create: true });
}

/** 本をタップしたときに自動で落とすもの。PDF は大きいので含めず、PDF タブを開いたときに別に落とす */
export const coreFiles = (book) => [book.mindmap, ...book.summary, ...book.full].filter(Boolean);

export async function downloads() {
  return (await kvGet('downloads')) || {};
}

/** まだ端末にない分のバイト数（ダウンロード前の確認用） */
export async function remainingBytes(book, files = coreFiles(book)) {
  const prev = (await downloads())[book.key];
  return files.filter((f) => prev?.files[f.path]?.rev !== f.rev).reduce((s, f) => s + (f.size || 0), 0);
}

export class DownloadStopped extends Error {}

/** その本の記録を読み直してから書き換える（本体と PDF のダウンロードが同時に走っても消し合わないように） */
async function patchDownload(key, fn) {
  const all = await downloads();
  all[key] = fn(all[key] || { files: {}, downloadedAt: Date.now(), lastOpened: Date.now(), complete: false });
  await kvSet('downloads', all);
}

/** ファイルをダウンロードする（省略時は本体＝PDF 以外）。onProgress(受信バイト, 合計バイト)。
 *  shouldStop() が true を返したら途中で止める（済んだファイルは残すので、次は続きから） */
export async function downloadBook(book, onProgress, shouldStop = () => false, files = coreFiles(book)) {
  if (navigator.storage.persist) navigator.storage.persist();
  const isCore = files.every((f) => f !== book.pdf);
  const prev = (await downloads())[book.key];
  const dir = await (await booksDir()).getDirectoryHandle('b' + hash(book.key), { create: true });
  const total = files.reduce((s, f) => s + (f.size || 0), 0);
  let done = 0;
  for (const f of files) {
    const old = prev?.files[f.path];
    if (old && old.rev === f.rev) {
      done += f.size || 0;
      onProgress?.(done, total);
      continue;
    }
    const name = 'f_' + hash(f.path);
    const res = await dbx.download(f.path);
    const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
    const reader = res.body.getReader();
    for (;;) {
      if (shouldStop()) {
        await reader.cancel();
        await writable.abort();
        throw new DownloadStopped();
      }
      const { done: end, value } = await reader.read();
      if (end) break;
      await writable.write(value);
      done += value.byteLength;
      onProgress?.(done, total);
    }
    await writable.close();
    await patchDownload(book.key, (m) => ({ ...m, downloadedAt: Date.now(), files: { ...m.files, [f.path]: { name, rev: f.rev } } }));
  }
  if (isCore) await patchDownload(book.key, (m) => ({ ...m, complete: true }));
}

/** ダウンロード済みのファイルを File で返す。なければ null */
export async function localFile(key, path) {
  const meta = (await downloads())[key];
  const f = meta?.files[path];
  if (!f) return null;
  try {
    const dir = await (await booksDir()).getDirectoryHandle('b' + hash(key));
    return await (await dir.getFileHandle(f.name)).getFile();
  } catch {
    return null;
  }
}

export async function removeDownload(key) {
  const all = await downloads();
  delete all[key];
  await kvSet('downloads', all);
  try {
    await (await booksDir()).removeEntry('b' + hash(key), { recursive: true });
  } catch {}
}

export async function touchDownload(key) {
  const all = await downloads();
  if (!all[key]) return;
  all[key].lastOpened = Date.now();
  await kvSet('downloads', all);
}

/** 最後に開いてから 2 週間たったダウンロードを端末から消す。消した冊数を返す */
export async function purgeOldDownloads(exceptKey) {
  const all = await downloads();
  const limit = Date.now() - KEEP_DAYS * 86400_000;
  let n = 0;
  for (const [key, meta] of Object.entries(all)) {
    if (key !== exceptKey && (meta.lastOpened || meta.downloadedAt) < limit) {
      await removeDownload(key);
      n++;
    }
  }
  return n;
}

export const daysLeft = (meta) =>
  Math.max(0, Math.ceil(((meta.lastOpened || meta.downloadedAt) + KEEP_DAYS * 86400_000 - Date.now()) / 86400_000));
