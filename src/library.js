// 登録フォルダを読み込んで「本」の一覧を作る。1 フォルダ＝1 冊。フォルダ直下の PDF / 音声 1 つも 1 冊として扱う。
import { dbx, downloadText } from './dropbox.js';
import { kvGet, kvSet } from './store.js';

export const MEMO_PREFIX = '⑥メモ_';
export const SYNC_FILE = '_脱ツンドク.json';

const AUDIO = /\.(m4a|mp3|aac|ogg|opus|wav|flac)$/i;
const IMAGE = /\.(jpe?g|png|webp)$/i;
const MARKERS = /【既読】|【未読】|【読書中】|★|☆/g;

const byName = (a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true });
const stripExt = (name) => name.replace(/\.[^.]+$/, '');
export const cleanTitle = (name) => name.replace(MARKERS, '').trim();

const pick = (files, re) => files.find((f) => re.test(f.name)) || files[0] || null;

/** 音声ファイル名から表示名を作る（例：①音声網羅1_書名_副題 → 網羅1：副題） */
export function trackLabel(file, title) {
  const s = stripExt(file.name).replace(/^[①-⑳]/, '').replace(/^音声/, '');
  const parts = s.split('_').filter((p) => p.trim() && p !== title);
  return parts.join('：') || s;
}

function makeBook(root, title, rawName, folder, files) {
  files.sort(byName);
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.name));
  const htmls = files.filter((f) => /\.html?$/i.test(f.name));
  const images = files.filter((f) => IMAGE.test(f.name));
  const audio = files.filter((f) => AUDIO.test(f.name));
  const summary = audio.filter((f) => /要約|概要|summary|digest/i.test(f.name));
  return {
    key: root + '/' + title,
    title,
    root,
    folder,
    pdf: pick(pdfs, /PDF/),
    mindmap: pick(htmls, /MP|マインドマップ|mindmap/i),
    cover: pick(images, /表紙|cover/i),
    summary,
    full: audio.filter((f) => !summary.includes(f)),
    points: files.filter((f) => /\.txt$/i.test(f.name) && /^🟥|要点/.test(f.name)),
    memoFile: files.find((f) => f.name.startsWith(MEMO_PREFIX) && /\.md$/i.test(f.name)) || null,
    imported: { done: /【既読】/.test(rawName), fav: /★/.test(rawName) },
  };
}

async function scanRoot(root) {
  const entries = await dbx.listFolder(root, { recursive: true });
  const rootLower = root.toLowerCase();
  const groups = new Map();
  const books = [];
  for (const e of entries) {
    const lower = e.path.toLowerCase();
    if (!lower.startsWith(rootLower + '/')) continue;
    const parts = e.path.slice(root.length + 1).split('/');
    if (parts.length === 1 && e.tag === 'folder') {
      if (!groups.has(parts[0])) groups.set(parts[0], []);
    } else if (parts.length === 2 && e.tag === 'file') {
      if (!groups.has(parts[0])) groups.set(parts[0], []);
      groups.get(parts[0]).push(e);
    } else if (parts.length === 1 && e.tag === 'file' && (/\.pdf$/i.test(e.name) || AUDIO.test(e.name))) {
      books.push(makeBook(root, cleanTitle(stripExt(e.name)), e.name, null, [e]));
    }
  }
  for (const [name, files] of groups) {
    if (!files.length) continue;
    books.push(makeBook(root, cleanTitle(name), name, root + '/' + name, files));
  }
  return books;
}

/** 要点 .txt の中身を読む（前回の結果は rev が同じなら使い回す） */
async function fillPoints(books, prevBooks) {
  const prev = new Map();
  for (const b of prevBooks) for (const p of b.points) prev.set(p.path, p);
  for (const b of books) {
    for (const p of b.points) {
      const old = prev.get(p.path);
      if (old && old.rev === p.rev && old.text !== undefined) p.text = old.text;
      else if ((p.size || 0) < 4096) p.text = ((await downloadText(p.path)) || '').trim();
      else p.text = '';
    }
  }
}

export const cachedLibrary = async () => (await kvGet('library')) || [];

/** 全登録フォルダを読み直す。読めなかったフォルダは前回の結果を残す */
export async function scanLibrary(folders) {
  const prev = await cachedLibrary();
  const books = [];
  const errors = [];
  for (const root of folders) {
    try {
      books.push(...(await scanRoot(root)));
    } catch (e) {
      errors.push({ root, error: e });
      books.push(...prev.filter((b) => b.root === root));
    }
  }
  await fillPoints(books, prev);
  books.sort((a, b) => a.title.localeCompare(b.title, 'ja', { numeric: true }));
  await kvSet('library', books);
  return { books, errors };
}

/** フォルダ選択画面用：サブフォルダだけを返す */
export async function listSubfolders(path) {
  const entries = await dbx.listFolder(path);
  return entries.filter((e) => e.tag === 'folder').sort(byName);
}
