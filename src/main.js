import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { isMock, hasAppKey, isLoggedIn, startLogin, handleRedirect, logout, dbx, downloadText } from './dropbox.js';
import {
  kvGet, kvSet, loadState, bookState, updateBook, seedBook, allStates, flushState,
  getThumb, setThumb, downloads, downloadBook, localFile, removeDownload, touchDownload, purgeOldDownloads, daysLeft,
  remainingBytes, DownloadStopped,
} from './store.js';
import { cachedLibrary, scanLibrary, listSubfolders, trackLabel } from './library.js';
import { setSyncContext, syncNow } from './sync.js';
import { getMemo, saveMemo, allMemos, fmtTime } from './memo.js';
import {
  initPlayer, playerState, onPlayer, loadAudio, toggle, skip, seek, setSpeed, selectTrack, tracksOf, savedPosition, SPEEDS, setArtwork, probeDurations,
} from './player.js';
import { openPdf, closePdf, renderCover, PdfViewer } from './pdf.js';
import { showMindmap } from './mindmap.js';

const VERSION = 'v1.05';
const NO_CATEGORY = '__none';
const STATUS = { unread: '未読', reading: '読書中', done: '既読' };
const TABS = [
  ['shelf', '本棚'],
  ['memo', 'メモ'],
];
// 本棚の段（上から）
const RACK_ROWS = [
  ['reading', '読書中'],
  ['unread', '未読'],
  ['fav', '★ お気に入り'],
  ['reread', '↻ 再読'],
  ['done', '既読'],
];

const ui = {
  screen: 'library', // library | settings | picker | login | setup
  tab: 'shelf',
  books: [],
  folders: [],
  downloads: {},
  progress: {}, // ダウンロード中：key → { done, total }
  reader: null, // { book, view, el, pdf, pdfLoading }
  category: '', // 本棚の絞り込み（'' = すべて、NO_CATEGORY = 未分類）
  pickerPath: '',
  sheetBookKey: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mb = (bytes) => (bytes / 1024 / 1024 >= 1000 ? (bytes / 1024 ** 3).toFixed(1) + 'GB' : Math.round(bytes / 1024 / 1024) + 'MB');
const findBook = (key) => ui.books.find((b) => b.key === key);
const st = (book) => bookState(book.key) || {};
const isDownloaded = (key) => ui.downloads[key] && ui.downloads[key].complete !== false;
const pointText = (p) => p.text || p.name.replace(/\.txt$/i, '').replace(/^🟥/, '');

/** 使われているカテゴリの一覧（カテゴリは本に付けた名前から集める。どの本にも付いていなければ消える） */
const categories = () =>
  [...new Set(ui.books.map((b) => st(b).category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));

/** モバイル通信につながっているか。判定できない端末（PC など）は false */
function onCellular() {
  const type = navigator.connection?.type;
  return !!type && type !== 'wifi' && type !== 'ethernet';
}

// ---------- 小物：トースト・シート ----------

let toastTimer;
function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = esc(msg) + (action ? ` <button class="link" data-act="toast-action">${esc(action.label)}</button>` : '');
  el.onclick = (e) => e.target.dataset.act === 'toast-action' && (action.run(), el.classList.remove('show'));
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 12000 : 3500);
}

function openSheet(html, onMount) {
  const el = $('#sheet');
  const body = el.classList.contains('open') && el.querySelector('.sheet-body');
  if (body) {
    // 開いたままの書き換え（ダウンロードの進み具合など）はアニメーションさせない
    body.style.animation = 'none';
    body.innerHTML = html;
  } else {
    el.innerHTML = `<div class="sheet-backdrop" data-act="close-sheet"></div><div class="sheet-body">${html}</div>`;
    el.classList.add('open');
  }
  onMount?.(el.querySelector('.sheet-body'));
}
function closeSheet() {
  $('#sheet').classList.remove('open');
  $('#sheet').innerHTML = '';
  ui.sheetBookKey = null;
}

// ---------- 表紙 ----------

const thumbUrls = new Map();
const hue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

function coverHtml(book) {
  const url = thumbUrls.get(book.key);
  if (url) return `<img class="cover-img" src="${url}" alt="">`;
  return `<div class="cover-fallback" style="--h:${hue(book.title)}"><span>${esc(book.title)}</span></div>`;
}

async function loadThumbs() {
  for (const b of ui.books) {
    if (thumbUrls.has(b.key)) continue;
    const blob = await getThumb(b.key);
    if (blob) thumbUrls.set(b.key, URL.createObjectURL(blob));
  }
  renderView();
  for (const b of ui.books) {
    if (thumbUrls.has(b.key)) continue;
    const blob = await makeThumb(b).catch(() => null);
    if (!blob) continue;
    await setThumb(b.key, blob);
    thumbUrls.set(b.key, URL.createObjectURL(blob));
    document.querySelectorAll(`[data-cover="${CSS.escape(b.key)}"]`).forEach((el) => (el.innerHTML = coverHtml(b)));
  }
}

async function rangeOk(url) {
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    return r.status === 206;
  } catch {
    return false;
  }
}

async function makeThumb(book) {
  if (book.cover && navigator.onLine) {
    if (isMock) return (await dbx.download(book.cover.path)).blob();
    const t = await dbx.thumbnail(book.cover.path);
    if (t) return t;
  }
  if (!book.pdf) return null;
  const local = await localFile(book.key, book.pdf.path);
  let source = local;
  if (!source && navigator.onLine) {
    if (!isMock) {
      const t = await dbx.thumbnail(book.pdf.path);
      if (t) return t;
    }
    const url = await dbx.tempLink(book.pdf.path);
    if (await rangeOk(url)) source = url; // 部分取得できないなら丸ごと落とすことになるので諦める
  }
  if (!source) return null;
  const doc = await openPdf(source);
  try {
    return await renderCover(doc);
  } finally {
    closePdf(doc);
  }
}

// ---------- 本棚 ----------

function progressOf(book) {
  const s = st(book);
  const kind = book.full.length ? 'full' : 'summary';
  const tracks = tracksOf(book, kind);
  const p = s.audio?.[kind];
  if (!p || !tracks.length) return null;
  const d = tracks.map((t) => s.durations?.[t.path]);
  if (d.some((x) => !x)) return null;
  const total = d.reduce((a, b) => a + b, 0);
  if (p.finished) return 1;
  return Math.min(1, (d.slice(0, p.i).reduce((a, b) => a + b, 0) + (p.t || 0)) / total);
}

const recency = (book) => Math.max(st(book).lastOpened || 0, st(book).lastPlayed || 0);

function booksForTab(tab) {
  let list = ui.books;
  if (ui.category === NO_CATEGORY) list = list.filter((b) => !st(b).category);
  else if (ui.category) list = list.filter((b) => st(b).category === ui.category);
  if (tab === 'fav') list = list.filter((b) => st(b).fav);
  else if (tab === 'reread') list = list.filter((b) => st(b).reread);
  else if (tab in STATUS) list = list.filter((b) => (st(b).status || 'unread') === tab);
  return [...list].sort((a, b) => recency(b) - recency(a) || a.title.localeCompare(b.title, 'ja', { numeric: true }));
}

function renderTabs() {
  $('#tabs').innerHTML = TABS.map(
    ([id, label]) => `<button class="tab ${ui.tab === id ? 'on' : ''}" data-act="tab" data-tab="${id}">${label}</button>`,
  ).join('');
}

// 本は表紙を正面に向けて立てかける（面陳）。段で状態がわかるので、状態バッジは ★ と ↻ の段でだけ出す
function cardHtml(book, row) {
  const s = st(book);
  const status = s.status || 'unread';
  const dl = isDownloaded(book.key);
  const prog = ui.progress[book.key];
  const p = progressOf(book);
  return `<button class="card" data-act="book" data-key="${esc(book.key)}" aria-label="${esc(book.title)}">
    <div class="cover" data-cover="${esc(book.key)}">${coverHtml(book)}</div>
    <span class="flags">${s.fav && row !== 'fav' ? '<span class="badge fav">★</span>' : ''}${s.reread && row !== 'reread' ? '<span class="badge reread">↻</span>' : ''}</span>
    ${(row === 'fav' || row === 'reread') && status !== 'unread' ? `<span class="badge status ${status}">${STATUS[status]}</span>` : ''}
    <span class="badge dl ${dl ? 'on' : ''}">${prog ? Math.floor((prog.done / prog.total) * 100) + '%' : dl ? '✓' : '⤓'}</span>
    ${p !== null ? `<span class="bar"><i style="width:${(p * 100).toFixed(1)}%"></i></span>` : ''}
  </button>`;
}

function renderLibrary() {
  if (!ui.books.length) {
    $('#view').innerHTML = `<div class="empty">本が見つかりません。<br>登録フォルダの中に「1冊＝1フォルダ」で PDF や音声を置いてください。<br><button class="btn" data-act="settings">設定を開く</button></div>`;
    return;
  }
  // 書き直しても各段の横スクロール位置は保つ（ダウンロード中は何度も書き直すため）
  const scrolls = {};
  document.querySelectorAll('.rack-books').forEach((el) => (scrolls[el.dataset.row] = el.scrollLeft));
  $('#view').innerHTML = `${categoryBarHtml()}<div class="rack">${RACK_ROWS.map(([id, label]) => {
    const list = booksForTab(id);
    return `<section class="rack-row">
      <div class="rack-books" data-row="${id}">${list.length ? list.map((b) => cardHtml(b, id)).join('') : '<p class="rack-empty">まだありません</p>'}</div>
      <div class="rack-board"><span class="plate">${label}<small>${list.length}</small></span></div>
    </section>`;
  }).join('')}</div>`;
  document.querySelectorAll('.rack-books').forEach((el) => (el.scrollLeft = scrolls[el.dataset.row] || 0));
}

/** 本棚の上のカテゴリ絞り込み。カテゴリが 1 つもなければ出さない */
function categoryBarHtml() {
  const cats = categories();
  if (!cats.length) {
    ui.category = '';
    return '';
  }
  if (ui.category && ui.category !== NO_CATEGORY && !cats.includes(ui.category)) ui.category = '';
  const items = [['', 'すべて'], ...cats.map((c) => [c, c])];
  if (ui.books.some((b) => !st(b).category)) items.push([NO_CATEGORY, '未分類']);
  return `<div class="cat-bar">${items
    .map(([v, l]) => `<button class="chip ${ui.category === v ? 'on' : ''}" data-act="cat-filter" data-cat="${esc(v)}">${esc(l)}</button>`)
    .join('')}</div>`;
}

// ---------- メモ一覧（1 冊に 1 枚） ----------

async function renderMemoList() {
  const memos = (await allMemos()).filter((m) => findBook(m.key));
  const pointsOnly = ui.books.filter((b) => b.points.length && !memos.some((m) => m.key === b.key));
  if (ui.screen !== 'library' || ui.tab !== 'memo') return;
  const cards = [...memos.map((m) => memoCardHtml(findBook(m.key), m.text)), ...pointsOnly.map((b) => memoCardHtml(b, ''))];
  $('#view').innerHTML = `<div class="memo-list">
    ${cards.length ? cards.join('') : '<div class="empty">メモはまだありません。<br>本を開いて ✎ から書けます。</div>'}
  </div>`;
}

function memoCardHtml(book, text) {
  return `<button class="memo" data-act="memo-open" data-key="${esc(book.key)}">
    <div class="memo-head"><b>${esc(book.title)}</b></div>
    ${book.points.map((p) => `<div class="memo-point">${esc(pointText(p))}</div>`).join('')}
    ${text ? `<div class="memo-text">${esc(text)}</div>` : ''}
  </button>`;
}

// ---------- 本の詳細シート ----------

function renderBookSheet(book) {
  ui.sheetBookKey = book.key;
  const s = st(book);
  const dl = isDownloaded(book.key) && ui.downloads[book.key];
  const prog = ui.progress[book.key];
  const pdfLocal = book.pdf && ui.downloads[book.key]?.files[book.pdf.path];
  const parts = [
    book.summary.length && `概要版 ${book.summary.length}本`,
    book.full.length && `網羅版 ${book.full.length}本`,
    book.pdf && 'PDF',
    book.mindmap && 'マインドマップ',
  ].filter(Boolean);
  const dlHtml = prog
    ? `<div class="dl-progress"><span>ダウンロード中 ${mb(prog.done)} / ${mb(prog.total)}</span><span class="bar big"><i style="width:${((prog.done / prog.total) * 100).toFixed(1)}%"></i></span></div>`
    : dl
      ? `<div class="dl-done">ダウンロード済み・あと${daysLeft(dl)}日で端末から削除 <button class="link danger" data-act="remove-dl" data-key="${esc(book.key)}">今すぐ削除</button></div>`
      : `<div class="dl-done muted">まだダウンロードしていません（本をタップするとダウンロードします）</div>`;
  const pdfHtml = book.pdf
    ? `<div class="dl-done muted">PDF：${pdfLocal ? 'ダウンロード済み' : `読む画面で PDF タブを押したときにダウンロード（${mb(book.pdf.size || 0)}）`}</div>`
    : '';
  const canOpen = dl || navigator.onLine;
  const cats = categories();
  const catHtml = `<label class="cat-row">カテゴリ
    <select data-act="set-category" data-key="${esc(book.key)}">
      <option value="">なし</option>
      ${cats.map((c) => `<option ${s.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      <option value="__new">＋ 新しいカテゴリ…</option>
    </select></label>`;
  openSheet(`
    <div class="book-sheet">
      <div class="cover small" data-cover="${esc(book.key)}">${coverHtml(book)}</div>
      <div class="book-info">
        <h2>${esc(book.title)}</h2>
        <p class="muted">${parts.join(' ・ ') || '中身がありません'}</p>
        <div class="flag-row">
          <button class="fav-toggle ${s.fav ? 'on' : ''}" data-act="fav" data-key="${esc(book.key)}">${s.fav ? '★ お気に入り' : '☆ お気に入り'}</button>
          <button class="fav-toggle reread ${s.reread ? 'on' : ''}" data-act="reread" data-key="${esc(book.key)}">↻ 再読${s.reread ? '中' : 'する'}</button>
        </div>
      </div>
    </div>
    <div class="seg">${Object.entries(STATUS).map(([k, v]) => `<button class="${(s.status || 'unread') === k ? 'on' : ''}" data-act="status" data-key="${esc(book.key)}" data-status="${k}">${v}</button>`).join('')}</div>
    ${catHtml}
    ${dlHtml}
    ${pdfHtml}
    <button class="btn primary" data-act="open-book" data-key="${esc(book.key)}" ${canOpen ? '' : 'disabled'}>${canOpen ? '開く' : 'オフライン中（ダウンロードしていません）'}</button>
  `);
}

/** モバイル通信なら容量を見せて確認する。Wi-Fi なら聞かない。
 *  戻り値：null＝やめる / { cellularOk }＝進める（cellularOk が false なら Wi-Fi が切れたら止める） */
function askNetwork(bytes, what = '') {
  if (!onCellular()) return { cellularOk: false };
  return confirm(`モバイル通信で${what}${mb(bytes)}ダウンロードします。いいですか？`) ? { cellularOk: true } : null;
}

// 本をタップしたら、未ダウンロードの分（PDF 以外）を自動でダウンロードする
async function autoDownload(book) {
  if (ui.progress[book.key] || isDownloaded(book.key) || !navigator.onLine) return;
  const bytes = await remainingBytes(book);
  if (!bytes) return;
  const ok = askNetwork(bytes);
  if (!ok) return;
  const { cellularOk } = ok;
  ui.progress[book.key] = { done: 0, total: 1 };
  let last = 0;
  try {
    await downloadBook(
      book,
      (done, total) => {
        ui.progress[book.key] = { done, total: total || 1 };
        if (Date.now() - last > 400) {
          last = Date.now();
          refresh();
        }
      },
      () => !cellularOk && onCellular(), // Wi-Fi が切れてモバイル通信になったら止める
    );
    toast(`「${book.title}」をダウンロードしました`);
  } catch (e) {
    if (e instanceof DownloadStopped) toast('Wi-Fi が切れたので止めました。続きは Wi-Fi につないでから');
    else toast('ダウンロードに失敗しました：' + e.message);
  }
  delete ui.progress[book.key];
  ui.downloads = await downloads();
  refresh();
}

// ---------- 読む・聴く画面 ----------

async function openReader(book, { view, page } = {}) {
  closeSheet();
  if (ui.reader && ui.reader.book.key !== book.key && !closeReader()) return;
  const s = st(book);
  if ((s.status || 'unread') === 'unread') updateBook(book.key, { status: 'reading' });
  updateBook(book.key, { lastOpened: Date.now() });
  touchDownload(book.key);
  probeDurations(book);
  getThumb(book.key).then(setArtwork);
  if (!ui.reader) {
    const el = $('#reader');
    el.innerHTML = readerHtml(book);
    el.classList.add('open');
    ui.reader = { book, el, view: null, pdf: null, pdfLoading: null };
    mountPlayerPanel(book);
  }
  const v = view || ui.reader.view || s.view || (book.mindmap ? 'mindmap' : 'pdf');
  await switchView(v);
  if (page && ui.reader.pdf) ui.reader.pdf.goTo(page);
}

function readerHtml(book) {
  const views = [book.mindmap && ['mindmap', 'マインドマップ'], ['memo', 'メモ'], book.pdf && ['pdf', 'PDF']].filter(Boolean);
  return `
    <header class="reader-top">
      <button class="icon" data-act="close-reader" aria-label="戻る">←</button>
      <h1>${esc(book.title)}</h1>
      <button class="icon fav-mini ${st(book).fav ? 'on' : ''}" data-act="fav" data-key="${esc(book.key)}" aria-label="お気に入り">${st(book).fav ? '★' : '☆'}</button>
    </header>
    <div class="seg view-seg">${views.map(([k, v]) => `<button data-act="view" data-view="${k}">${v}</button>`).join('')}</div>
    <div class="reader-body">
      <div class="pane" data-pane="mindmap"></div>
      <div class="pane" data-pane="memo">
        <div class="memo-pane">
          ${book.points.map((p) => `<div class="memo-point">${esc(pointText(p))}</div>`).join('')}
          <textarea class="memo-input memo-edit" placeholder="この本について覚えておきたいこと" disabled>読み込み中…</textarea>
          <div class="memo-bar"><span class="memo-state">保存済み</span><button class="btn primary memo-save" data-act="memo-save" disabled>保存</button></div>
        </div>
      </div>
      <div class="pane" data-pane="pdf"><div class="pdf-host"></div>
        <div class="pdf-tools"><button data-act="zoom" data-d="-0.5">－</button><button class="page-ind" data-act="goto-page">- / -</button><button data-act="zoom" data-d="0.5">＋</button></div>
      </div>
    </div>
    <div class="player"></div>`;
}

// ---------- メモのタブ（1 冊に 1 枚。保存はボタンで。未保存はタブと保存欄でひと目でわかるように） ----------

const memoDirty = (r = ui.reader) => !!r?.memoLoaded && r.el.querySelector('.memo-edit').value !== r.memoSaved;

function updateMemoState() {
  const r = ui.reader;
  if (!r?.memoLoaded) return;
  const dirty = memoDirty(r);
  r.el.querySelector('[data-view="memo"]').classList.toggle('dirty', dirty);
  const state = r.el.querySelector('.memo-state');
  state.textContent = dirty ? '● 保存していない変更があります' : '✓ 保存済み';
  state.classList.toggle('dirty', dirty);
  r.el.querySelector('.memo-save').disabled = !dirty;
}

async function loadMemoPane(r) {
  const ta = r.el.querySelector('.memo-edit');
  r.memoSaved = (await getMemo(r.book.key)).replace(/\r\n?/g, '\n'); // 古いキャッシュの CRLF もそろえる
  ta.value = r.memoSaved;
  ta.disabled = false;
  r.memoLoaded = true;
  ta.addEventListener('input', updateMemoState);
  updateMemoState();
}

async function saveMemoPane() {
  const r = ui.reader;
  if (!memoDirty(r)) return;
  const text = r.el.querySelector('.memo-edit').value;
  await saveMemo(r.book, text);
  r.memoSaved = text;
  updateMemoState();
  toast(navigator.onLine ? 'メモを保存しました' : 'メモを端末に保存しました（つながったら Dropbox へ送ります）');
}

async function switchView(v) {
  const r = ui.reader;
  const { book, el } = r;
  if (v === 'mindmap' && !book.mindmap) v = book.pdf ? 'pdf' : 'memo';
  if (v === 'pdf' && !book.pdf) v = book.mindmap ? 'mindmap' : 'memo';
  r.view = v;
  if (v === 'memo' && !r.memoLoaded) loadMemoPane(r);
  if (st(book).view !== v) updateBook(book.key, { view: v });
  el.querySelectorAll('[data-act="view"]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  el.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === v));
  if (v === 'mindmap' && book.mindmap && !r.mindmapShown) {
    r.mindmapShown = true;
    const pane = el.querySelector('[data-pane="mindmap"]');
    pane.innerHTML = '<div class="loading">読み込み中…</div>';
    try {
      const local = await localFile(book.key, book.mindmap.path);
      const html = local ? await local.text() : await downloadText(book.mindmap.path);
      showMindmap(pane, html || '');
    } catch (e) {
      r.mindmapShown = false;
      pane.innerHTML = `<div class="empty">マインドマップを開けませんでした<br><small>${esc(e.message)}</small></div>`;
    }
  }
  if (v === 'pdf' && book.pdf && !r.pdf && !r.pdfLoading) {
    const host = el.querySelector('.pdf-host');
    host.innerHTML = '<div class="loading">PDF を読み込み中…</div>';
    r.pdfLoading = (async () => {
      try {
        const local = (await localFile(book.key, book.pdf.path)) || (await downloadPdf(r, host));
        if (!local) return;
        const doc = await openPdf(local);
        if (ui.reader !== r) return closePdf(doc);
        host.innerHTML = '';
        r.pdf = new PdfViewer(host, doc, {
          startPage: st(book).pdfPage || 1,
          onPage: (n) => {
            el.querySelector('.page-ind').textContent = `${n} / ${doc.numPages}`;
            if (st(book).pdfPage !== n) updateBook(book.key, { pdfPage: n });
          },
        });
        await r.pdf.ready;
      } catch (e) {
        host.innerHTML = `<div class="empty">PDF を開けませんでした<br><small>${esc(e.message)}</small></div>`;
      } finally {
        r.pdfLoading = null;
      }
    })();
    await r.pdfLoading;
  }
}

/** PDF タブを押したときに PDF をダウンロードする。落とせたら File、やめた・落とせなかったら null */
async function downloadPdf(r, host) {
  const { book } = r;
  const again = 'もう一度 PDF タブを押すとダウンロードします';
  if (!navigator.onLine) {
    host.innerHTML = `<div class="empty">PDF はまだダウンロードしていないので、オフラインでは開けません</div>`;
    return null;
  }
  const ok = askNetwork(book.pdf.size || 0, 'PDF を');
  if (!ok) {
    host.innerHTML = `<div class="empty">PDF はまだダウンロードしていません<br><small>${again}</small></div>`;
    return null;
  }
  host.innerHTML = `<div class="loading">PDF をダウンロード中… <b class="pdf-dl">0%</b><span class="bar big"><i></i></span></div>`;
  try {
    await downloadBook(
      book,
      (done, total) => {
        const pct = ((done / (total || 1)) * 100).toFixed(0) + '%';
        host.querySelector('.pdf-dl').textContent = pct;
        host.querySelector('.bar i').style.width = pct;
      },
      () => !ok.cellularOk && onCellular(),
      [book.pdf],
    );
  } catch (e) {
    host.innerHTML = `<div class="empty">${e instanceof DownloadStopped ? 'Wi-Fi が切れたので PDF のダウンロードを止めました' : 'PDF をダウンロードできませんでした：' + esc(e.message)}<br><small>${again}</small></div>`;
    return null;
  }
  ui.downloads = await downloads();
  return localFile(book.key, book.pdf.path);
}

/** 読む画面を閉じる。保存していないメモがあって、閉じるのをやめたら false */
function closeReader() {
  const r = ui.reader;
  if (!r) return true;
  if (memoDirty(r) && !confirm('メモを保存していません。保存せずに閉じますか？')) {
    switchView('memo');
    return false;
  }
  r.pdf?.destroy();
  r.el.classList.remove('open');
  r.el.innerHTML = '';
  ui.reader = null;
  refresh();
  return true;
}

// ---------- プレーヤー（読む画面の下・本棚のミニプレーヤー） ----------

function defaultKind(book) {
  const k = st(book).kind;
  if (k && tracksOf(book, k).length) return k;
  return book.full.length ? 'full' : 'summary';
}

function mountPlayerPanel(book) {
  const el = ui.reader.el.querySelector('.player');
  if (!book.summary.length && !book.full.length) {
    el.remove();
    return;
  }
  ui.reader.kind = playerState().book?.key === book.key ? playerState().kind : defaultKind(book);
  el.innerHTML = `
    <div class="seg kind-seg">
      ${book.summary.length ? '<button data-act="kind" data-kind="summary">概要版</button>' : ''}
      ${book.full.length ? `<button data-act="kind" data-kind="full">網羅版${book.full.length > 1 ? `（${book.full.length}本）` : ''}</button>` : ''}
    </div>
    <select class="track-select" data-act="track"></select>
    <div class="seekrow"><span class="t-cur">0:00</span><input type="range" class="seek" min="0" max="1" step="1" value="0"><span class="t-dur">0:00</span></div>
    <div class="controls">
      <select class="speed" data-act="speed">${SPEEDS.map((s) => `<option value="${s}">${s.toFixed(1)}x</option>`).join('')}</select>
      <button class="ctl" data-act="skip" data-d="-15">⟲<small>15</small></button>
      <button class="ctl play" data-act="play">▶</button>
      <button class="ctl" data-act="skip" data-d="15">⟳<small>15</small></button>
      <span class="ctl-spacer"></span>
    </div>`;
  const seekEl = el.querySelector('.seek');
  seekEl.addEventListener('input', () => (seekEl.dataset.dragging = '1'));
  seekEl.addEventListener('change', async () => {
    delete seekEl.dataset.dragging;
    const ps = playerState();
    if (ps.book?.key === book.key && ps.kind === ui.reader.kind) seek(+seekEl.value);
    else await loadAudio(book, ui.reader.kind, { i: +el.querySelector('.track-select').value || 0, t: +seekEl.value });
  });
  updatePlayerPanel();
}

function updatePlayerPanel() {
  const r = ui.reader;
  if (!r) return;
  const el = r.el.querySelector('.player');
  if (!el || !el.innerHTML) return;
  const { book, kind } = r;
  const ps = playerState();
  const active = ps.book?.key === book.key && ps.kind === kind;
  const tracks = tracksOf(book, kind);
  const pos = active ? { i: ps.i, t: ps.t } : savedPosition(book, kind);
  const dur = active ? ps.d : st(book).durations?.[tracks[pos.i]?.path] || 0;
  el.querySelectorAll('[data-act="kind"]').forEach((b) => b.classList.toggle('on', b.dataset.kind === kind));
  const sel = el.querySelector('.track-select');
  const opts = tracks.map((t, i) => `<option value="${i}">${i + 1}. ${esc(trackLabel(t, book.title))}</option>`).join('');
  if (sel.dataset.kind !== kind) {
    sel.innerHTML = opts;
    sel.dataset.kind = kind;
  }
  sel.value = pos.i;
  sel.hidden = tracks.length < 2;
  const seekEl = el.querySelector('.seek');
  if (!seekEl.dataset.dragging) {
    seekEl.max = Math.max(1, Math.floor(dur));
    seekEl.value = Math.floor(pos.t);
  }
  el.querySelector('.t-cur').textContent = fmtTime(seekEl.dataset.dragging ? +seekEl.value : pos.t);
  el.querySelector('.t-dur').textContent = dur ? fmtTime(dur) : '--:--';
  el.querySelector('.play').textContent = active && ps.playing ? '❚❚' : '▶';
  el.querySelector('.speed').value = String(ps.speed);
}

function renderMini() {
  const ps = playerState();
  const el = $('#mini');
  if (!ps.book || ui.reader) {
    el.classList.remove('show');
    return;
  }
  el.classList.add('show');
  el.innerHTML = `<button class="mini-info" data-act="open-book" data-key="${esc(ps.book.key)}">
      <b>${esc(ps.book.title)}</b><small>${ps.kind === 'summary' ? '概要版' : '網羅版 ' + (ps.i + 1)} ・ ${fmtTime(ps.t)} / ${fmtTime(ps.d)}</small>
    </button>
    <button class="ctl" data-act="mini-skip" data-d="-15">⟲</button>
    <button class="ctl play" data-act="mini-play">${ps.playing ? '❚❚' : '▶'}</button>`;
}

onPlayer((ev) => {
  if (ev?.error) toast(ev.error);
  if (ev === 'finished') {
    const ps = playerState();
    if (ps.book && st(ps.book).status !== 'done') toast(`「${ps.book.title}」を最後まで聴きました`, { label: '既読にする', run: () => updateBook(ps.book.key, { status: 'done' }) });
  }
  updatePlayerPanel();
  renderMini();
});

// ---------- 設定・フォルダ登録 ----------

async function renderSettings() {
  const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
  const dls = Object.entries(ui.downloads);
  $('#view').innerHTML = `<div class="settings">
    <section><h3>登録フォルダ</h3>
      ${ui.folders.map((f) => `<div class="row-item"><span>${esc(f || '（Dropbox 全体）')}</span><button class="link danger" data-act="remove-folder" data-path="${esc(f)}">外す</button></div>`).join('') || '<p class="muted">まだありません</p>'}
      <button class="btn ghost" data-act="picker">＋ フォルダを追加</button>
    </section>
    <section><h3>ダウンロード済み（${dls.length}冊）</h3>
      <p class="muted">最後に開いてから 2 週間で端末から自動で消えます（Dropbox 側は消えません）。${est ? `端末で使用中 ${mb(est.usage || 0)}` : ''}</p>
      ${dls.map(([k, d]) => `<div class="row-item"><span>${esc(findBook(k)?.title || k)}<small class="muted"> ・ ${d.complete === false ? '途中まで' : `あと${daysLeft(d)}日`}</small></span><button class="link danger" data-act="remove-dl" data-key="${esc(k)}">削除</button></div>`).join('')}
    </section>
    <section><h3>カテゴリ</h3>
      <p class="muted">本の詳細でカテゴリを付けると、ここに出ます。</p>
      ${categories().map((c) => `<div class="row-item"><span>${esc(c)}<small class="muted"> ・ ${ui.books.filter((b) => st(b).category === c).length}冊</small></span><span><button class="link" data-act="rename-category" data-cat="${esc(c)}">名前を変える</button><button class="link danger" data-act="remove-category" data-cat="${esc(c)}">外す</button></span></div>`).join('')}
    </section>
    <section><h3>同期</h3>
      <p class="muted">状態・再生位置・カテゴリは各登録フォルダの「_脱ツンドク.json」、メモは本のフォルダの「⑥メモ_書名.md」に保存します。</p>
      <button class="btn ghost" data-act="sync">今すぐ同期</button>
    </section>
    <section><h3>アカウント</h3>
      ${isMock ? '<p class="muted">試験モード（PC のフォルダを読むだけ。書き込みはこのブラウザの中だけ）</p>' : '<button class="btn ghost danger" data-act="logout">Dropbox からログアウト</button>'}
    </section>
    <p class="muted center">脱ツンドク ${VERSION}</p>
  </div>`;
}

async function renderPicker() {
  const path = ui.pickerPath;
  const crumbs = path.split('/').filter(Boolean);
  $('#view').innerHTML = `<div class="picker"><p class="muted">読み込むフォルダを選んでください（中の「1フォルダ＝1冊」を本として並べます）</p>
    <div class="crumbs"><button class="link" data-act="pick-go" data-path="">Dropbox</button>${crumbs.map((c, i) => ` / <button class="link" data-act="pick-go" data-path="${esc('/' + crumbs.slice(0, i + 1).join('/'))}">${esc(c)}</button>`).join('')}</div>
    <div class="folder-list"><div class="loading">読み込み中…</div></div>
    <div class="row sticky">${ui.folders.length ? '<button class="btn ghost" data-act="settings">やめる</button>' : ''}<button class="btn primary" data-act="pick-this">このフォルダを登録</button></div>
  </div>`;
  try {
    const subs = await listSubfolders(path);
    if (ui.screen !== 'picker' || ui.pickerPath !== path) return;
    $('.folder-list').innerHTML = subs.map((f) => `<button class="folder" data-act="pick-go" data-path="${esc(f.path)}">📁 ${esc(f.name)}</button>`).join('') || '<p class="muted">サブフォルダはありません</p>';
  } catch (e) {
    $('.folder-list').innerHTML = `<p class="muted">読み込めませんでした：${esc(e.message)}</p>`;
  }
}

// ---------- 画面の切り替え ----------

function renderView() {
  const s = ui.screen;
  document.body.dataset.screen = s;
  $('#tabs').hidden = s !== 'library';
  $('#title-back').hidden = s === 'library' || s === 'login' || s === 'setup' || (s === 'picker' && !ui.folders.length);
  if (s === 'library') {
    renderTabs();
    if (ui.tab === 'memo') renderMemoList();
    else renderLibrary();
  } else if (s === 'settings') renderSettings();
  else if (s === 'picker') renderPicker();
  else if (s === 'login') {
    $('#view').innerHTML = `<div class="welcome"><h2>脱ツンドク</h2><p>Dropbox の PDF と音声で、積ん読を崩す本棚です。</p>
      <button class="btn primary" data-act="login">Dropbox でログイン</button>
      <p class="muted small">ログイン情報はこの端末の中にだけ保存されます。</p></div>`;
  } else if (s === 'setup') {
    $('#view').innerHTML = `<div class="welcome"><h2>設定が足りません</h2><p>.env に VITE_DROPBOX_APP_KEY を書いてからビルドしてください。</p></div>`;
  }
  renderMini();
}

function refresh() {
  if (ui.screen === 'library') {
    renderTabs();
    if (ui.tab !== 'memo') renderLibrary();
    else renderMemoList();
  }
  if (ui.sheetBookKey) {
    const b = findBook(ui.sheetBookKey);
    if (b) renderBookSheet(b);
  }
  if (ui.reader) {
    const fav = ui.reader.el.querySelector('.fav-mini');
    const on = !!st(ui.reader.book).fav;
    fav.classList.toggle('on', on);
    fav.textContent = on ? '★' : '☆';
  }
}

function go(screen) {
  ui.screen = screen;
  renderView();
  window.scrollTo(0, 0);
}

// ---------- 操作 ----------

const actions = {
  'close-sheet': closeSheet,
  tab: (el) => {
    ui.tab = el.dataset.tab;
    renderView();
  },
  book: (el) => {
    const b = findBook(el.dataset.key);
    renderBookSheet(b);
    autoDownload(b);
  },
  reread: (el) => {
    const b = findBook(el.dataset.key);
    updateBook(b.key, { reread: !st(b).reread });
    refresh();
  },
  'open-book': (el) => {
    const b = findBook(el.dataset.key);
    if (b) openReader(b);
  },
  fav: (el) => {
    const b = findBook(el.dataset.key);
    updateBook(b.key, { fav: !st(b).fav });
    refresh();
  },
  status: (el) => {
    updateBook(el.dataset.key, { status: el.dataset.status });
    refresh();
  },
  'remove-dl': async (el) => {
    if (!confirm('端末からこの本のダウンロードを削除します（Dropbox 側は消えません）')) return;
    await removeDownload(el.dataset.key);
    ui.downloads = await downloads();
    refresh();
    if (ui.screen === 'settings') renderSettings();
  },
  'close-reader': closeReader,
  view: (el) => switchView(el.dataset.view),
  zoom: (el) => ui.reader?.pdf?.setZoom(ui.reader.pdf.zoom + +el.dataset.d),
  'goto-page': () => {
    const pdf = ui.reader?.pdf;
    if (!pdf) return;
    const n = parseInt(prompt(`ページ番号（1〜${pdf.doc.numPages}）`, pdf.page), 10);
    if (n) pdf.goTo(n);
  },
  kind: (el) => {
    const r = ui.reader;
    const ps = playerState();
    r.kind = el.dataset.kind;
    if (ps.book?.key === r.book.key && ps.kind !== r.kind) loadAudio(r.book, r.kind, { autoplay: ps.playing });
    updatePlayerPanel();
  },
  play: () => {
    const r = ui.reader;
    const ps = playerState();
    if (ps.book?.key === r.book.key && ps.kind === r.kind) toggle();
    else loadAudio(r.book, r.kind, { autoplay: true }).catch((e) => toast(e.message));
  },
  skip: (el) => {
    const r = ui.reader;
    const ps = playerState();
    if (ps.book?.key === r.book.key && ps.kind === r.kind) skip(+el.dataset.d);
  },
  'mini-play': () => toggle(),
  'mini-skip': (el) => skip(+el.dataset.d),
  'memo-save': () => saveMemoPane(),
  'memo-open': (el) => {
    const b = findBook(el.dataset.key);
    if (b) openReader(b, { view: 'memo' });
  },
  'cat-filter': (el) => {
    ui.category = el.dataset.cat;
    kvSet('category-filter', ui.category);
    renderLibrary();
  },
  'rename-category': (el) => {
    const from = el.dataset.cat;
    const to = prompt('新しいカテゴリ名', from)?.trim();
    if (!to || to === from) return;
    for (const b of ui.books) if (st(b).category === from) updateBook(b.key, { category: to });
    if (ui.category === from) ui.category = to;
    renderSettings();
  },
  'remove-category': (el) => {
    const cat = el.dataset.cat;
    if (!confirm(`「${cat}」を外します（本は消えず、未分類になります）`)) return;
    for (const b of ui.books) if (st(b).category === cat) updateBook(b.key, { category: null });
    renderSettings();
  },
  settings: () => go('settings'),
  back: () => go('library'),
  picker: () => {
    ui.pickerPath = '';
    go('picker');
  },
  'pick-go': (el) => {
    ui.pickerPath = el.dataset.path;
    renderPicker();
  },
  'pick-cancel': () => go(ui.folders.length ? 'settings' : 'picker'),
  'pick-this': async () => {
    if (!ui.folders.includes(ui.pickerPath)) ui.folders = [...ui.folders, ui.pickerPath];
    await kvSet('folders', ui.folders);
    go('library');
    reloadLibrary();
  },
  'remove-folder': async (el) => {
    if (!confirm('このフォルダを本棚から外します（Dropbox のファイルはそのまま）')) return;
    ui.folders = ui.folders.filter((f) => f !== el.dataset.path);
    await kvSet('folders', ui.folders);
    await reloadLibrary();
    renderSettings();
  },
  sync: async () => {
    toast('同期しています…');
    try {
      await reloadLibrary();
      toast('同期しました');
    } catch (e) {
      toast('同期できませんでした：' + e.message);
    }
  },
  login: () => startLogin(),
  logout: async () => {
    if (!confirm('Dropbox からログアウトしますか？（ダウンロード済みの本は残ります）')) return;
    await logout();
    go('login');
  },
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.tagName === 'SELECT') return;
  const fn = actions[el.dataset.act];
  if (fn) fn(el, ev);
});
document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset.act === 'speed') setSpeed(+el.value);
  if (el.dataset.act === 'track') {
    const r = ui.reader;
    const ps = playerState();
    if (ps.book?.key === r.book.key && ps.kind === r.kind) selectTrack(+el.value);
    else loadAudio(r.book, r.kind, { i: +el.value, t: 0 });
  }
  if (el.dataset.act === 'set-category') {
    let cat = el.value;
    if (cat === '__new') {
      cat = prompt('カテゴリ名（例：不動産、ビジネス、歴史）')?.trim();
      if (!cat) return refresh(); // やめたら選択を元に戻す
    }
    updateBook(el.dataset.key, { category: cat || null });
    refresh();
  }
});
addEventListener('online', () => refresh());
addEventListener('offline', () => refresh());
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushState());
addEventListener('beforeunload', (e) => memoDirty() && e.preventDefault());

// ---------- 読み込み・起動 ----------

function applyBooks(books) {
  ui.books = books;
  for (const b of books) seedBook(b.key, { status: b.imported.done ? 'done' : 'unread', fav: b.imported.fav });
  setSyncContext(ui.folders, books);
}

async function reloadLibrary() {
  const { books, errors } = await scanLibrary(ui.folders);
  applyBooks(books);
  if (errors.length) toast('読み込めないフォルダがありました：' + errors.map((e) => e.root).join(', '));
  try {
    await syncNow();
  } catch (e) {
    toast('同期できませんでした：' + e.message);
  }
  if (ui.screen === 'library') renderView();
  loadThumbs();
}

function askResume() {
  let best = null;
  for (const [key, s] of Object.entries(allStates())) {
    if (s.lastPlayed && (!best || s.lastPlayed > best.s.lastPlayed)) best = { key, s };
  }
  const book = best && findBook(best.key);
  if (!book) return;
  const kind = best.s.kind && tracksOf(book, best.s.kind).length ? best.s.kind : defaultKind(book);
  const pos = savedPosition(book, kind);
  const label = (kind === 'summary' ? '概要版' : '網羅版 ' + (pos.i + 1)) + ' ' + fmtTime(pos.t);
  openSheet(
    `<h3>前回の続きから再生しますか？</h3>
    <p><b>${esc(book.title)}</b><br><span class="muted">${esc(label)}</span></p>
    <div class="row"><button class="btn ghost" data-act="close-sheet">しない</button><button class="btn primary" data-act="resume">再生する</button></div>`,
    (body) => {
      body.querySelector('[data-act="resume"]').onclick = async () => {
        closeSheet();
        await openReader(book);
        ui.reader.kind = kind;
        loadAudio(book, kind, { autoplay: true }).catch((e) => toast(e.message));
      };
    },
  );
}

async function boot() {
  $('#title-back').onclick = () => go('library');
  $('#settings-btn').onclick = () => go('settings');
  if (isMock) document.body.classList.add('mock');
  try {
    await handleRedirect();
  } catch (e) {
    toast('ログインに失敗しました：' + e.message);
  }
  await loadState();
  await initPlayer();
  if (!hasAppKey()) return go('setup');
  if (!(await isLoggedIn())) return go('login');
  ui.folders = (await kvGet('folders')) || [];
  ui.category = (await kvGet('category-filter')) || '';
  if (!ui.folders.length) {
    ui.pickerPath = '';
    return go('picker');
  }
  const purged = await purgeOldDownloads();
  if (purged) toast(`2 週間開いていない ${purged} 冊を端末から削除しました`);
  ui.downloads = await downloads();
  applyBooks(await cachedLibrary());
  go('library');
  loadThumbs();
  askResume();
  if (navigator.onLine) reloadLibrary().catch((e) => toast('読み込めませんでした：' + e.message));
}

const updateSW = registerSW({
  onNeedRefresh() {
    toast('新しい版があります', { label: '更新する', run: () => updateSW(true) });
  },
});

boot();
