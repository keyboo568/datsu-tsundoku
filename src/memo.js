// メモ：本のフォルダの「⑥メモ_書名.md」に保存する。オフラインで書いた分は操作として溜め、つながったら反映する。
import { dbx, downloadText } from './dropbox.js';
import { kvGet, kvSet } from './store.js';
import { MEMO_PREFIX } from './library.js';

// 端末内：{ [bookKey]: { entries: [...], ops: [...], rev } }
let memos = null;
const load = async () => (memos ??= (await kvGet('memos')) || {});
const save = () => kvSet('memos', memos);

export const memoPath = (book) => (book.folder || book.root) + '/' + MEMO_PREFIX + book.title + '.md';

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const hash = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
};
const pad = (n) => String(n).padStart(2, '0');

export const fmtTime = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return (h ? h + ':' + pad(m) : m) + ':' + pad(sec % 60);
};
export const fmtDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** メモの位置表示（例：網羅版 2 12:34 ｜ p.45） */
export function placeLabel(e) {
  const parts = [];
  if (e.kind) parts.push((e.kind === 'summary' ? '概要版' : '網羅版 ' + ((e.i || 0) + 1)) + ' ' + fmtTime(e.t));
  if (e.page) parts.push('p.' + e.page);
  return parts.join(' ｜ ');
}

// ---------- Markdown との変換 ----------

function serialize(book, entries) {
  let out = `# ${book.title} メモ\n`;
  for (const e of [...entries].sort((a, b) => a.at - b.at)) {
    const place = placeLabel(e);
    const meta = [`id:${e.id}`, `at:${e.at}`];
    if (e.kind) meta.push(`kind:${e.kind}`, `i:${e.i || 0}`, `t:${Math.floor(e.t || 0)}`);
    if (e.page) meta.push(`page:${e.page}`);
    out += `\n## ${e.at ? fmtDate(e.at) : 'メモ'}${place ? ' ｜ ' + place : ''}\n<!-- ${meta.join(' ')} -->\n${e.text.trim()}\n`;
  }
  return out;
}

function parse(md) {
  if (!md) return [];
  const entries = [];
  const sections = md.split(/^## /m).slice(1);
  for (const sec of sections) {
    const nl = sec.indexOf('\n');
    const heading = nl < 0 ? sec : sec.slice(0, nl);
    let body = nl < 0 ? '' : sec.slice(nl + 1);
    const m = /^<!--([^>]*)-->\n?/.exec(body);
    const meta = {};
    if (m) {
      for (const kv of m[1].trim().split(/\s+/)) {
        const [k, v] = kv.split(':');
        meta[k] = v;
      }
      body = body.slice(m[0].length);
    }
    const dm = /(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)/.exec(heading);
    entries.push({
      id: meta.id || 'h' + hash(heading + body),
      at: +meta.at || (dm ? new Date(+dm[1], dm[2] - 1, +dm[3], +dm[4], +dm[5]).getTime() : 0),
      kind: meta.kind || null,
      i: +meta.i || 0,
      t: +meta.t || 0,
      page: +meta.page || null,
      text: body.trim(),
    });
  }
  // 見出しのない書き方をされていたら、全文を 1 つのメモとして見せる
  if (!entries.length && md.trim()) {
    const text = md.replace(/^# .*\n?/, '').trim();
    if (text) entries.push({ id: 'h' + hash(text), at: 0, kind: null, i: 0, t: 0, page: null, text });
  }
  return entries;
}

function applyOps(entries, ops) {
  let list = [...entries];
  for (const op of ops) {
    if (op.type === 'add') list = [...list.filter((e) => e.id !== op.entry.id), op.entry];
    else if (op.type === 'edit') list = list.map((e) => (e.id === op.id ? { ...e, text: op.text } : e));
    else if (op.type === 'del') list = list.filter((e) => e.id !== op.id);
  }
  return list;
}

// ---------- 読み書き ----------

export async function bookMemos(key) {
  await load();
  return memos[key]?.entries || [];
}

/** 全部の本のメモ（新しい順） */
export async function allMemos() {
  await load();
  const out = [];
  for (const [key, m] of Object.entries(memos)) for (const e of m.entries) out.push({ ...e, key });
  return out.sort((a, b) => b.at - a.at);
}

export const hasPendingMemos = async () => Object.values(await load()).some((m) => m.ops.length);

async function pushOp(book, op) {
  await load();
  const m = (memos[book.key] ??= { entries: [], ops: [], rev: null });
  m.ops.push(op);
  m.entries = applyOps(m.entries, [op]);
  await save();
  syncBookMemos(book).catch(() => {}); // オフラインなら次の同期で
}

export function addMemo(book, { text, kind, i, t, page }) {
  return pushOp(book, { type: 'add', entry: { id: newId(), at: Date.now(), kind: kind || null, i: i || 0, t: t || 0, page: page || null, text } });
}
export const editMemo = (book, id, text) => pushOp(book, { type: 'edit', id, text });
export const deleteMemo = (book, id) => pushOp(book, { type: 'del', id });

let running = Promise.resolve();
/** 1 冊ぶんのメモを Dropbox と合わせる。Dropbox 側を読んでから溜めた操作を当てて書き戻す */
export function syncBookMemos(book) {
  running = running.catch(() => {}).then(async () => {
    await load();
    const m = (memos[book.key] ??= { entries: [], ops: [], rev: null });
    const remoteRev = book.memoFile?.rev || null;
    if (!m.ops.length && m.rev === remoteRev && m.rev !== null) return;
    if (!m.ops.length && !remoteRev) return;
    const remote = parse(await downloadText(memoPath(book)));
    const merged = applyOps(remote, m.ops);
    if (m.ops.length) await dbx.uploadText(memoPath(book), serialize(book, merged));
    memos[book.key] = { entries: merged, ops: [], rev: m.ops.length ? 'local' : remoteRev };
    await save();
  });
  return running;
}

export async function syncAllMemos(books) {
  for (const b of books) await syncBookMemos(b);
}
