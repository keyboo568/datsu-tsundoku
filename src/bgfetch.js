// Android の「バックグラウンドダウンロード」（Background Fetch）。アプリを裏に回しても閉じても、Chrome が最後まで落とす。
// 落とした中身は Service Worker（public/bgfetch-sw.js）が受け箱に置き、ここで端末の保存場所に移す。
// 使えない端末（PC・iPhone など）では startBg が null を返すので、呼び出し側が今までのダウンロードをする。
import { dbx } from './dropbox.js';
import { kvGet, kvSet, storeFile, markComplete, dlog } from './store.js';

const INBOX = 'datsu-bgfetch-inbox';
const LOST_AFTER = 5 * 60_000; // 結果も登録も見つからないまま 5 分たったら見失ったとみなす

const listeners = new Set();
/** 裏のダウンロードが終わった・止まったときに呼ばれる fn({ id, key, ok, job }) */
export const onBgDone = (fn) => listeners.add(fn);

async function registration() {
  if (!('serviceWorker' in navigator) || !('BackgroundFetchManager' in self)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg?.active && reg.backgroundFetch ? reg : null;
}

const inboxKey = (reg, id, name) => new URL('__bgfetch/' + encodeURIComponent(id) + '/' + encodeURIComponent(name), reg.scope).href;
const loadJobs = async () => (await kvGet('bg-jobs')) || {};

async function saveJob(id, job) {
  const jobs = await loadJobs();
  if (job) jobs[id] = job;
  else delete jobs[id];
  await kvSet('bg-jobs', jobs);
}

/** 裏で落としている本の key → { id, done, total }（アプリを開き直したときの進み具合の表示用） */
export async function runningBg(onProgress) {
  const reg = await registration();
  if (!reg) return {};
  const out = {};
  for (const [id, job] of Object.entries(await loadJobs())) {
    const r = await reg.backgroundFetch.get(id);
    if (!r || r.result) continue;
    out[job.key] = { id, done: r.downloaded, total: r.downloadTotal || job.total };
    r.addEventListener('progress', () => onProgress(job.key, r.downloaded, r.downloadTotal || job.total));
  }
  return out;
}

/**
 * 裏でダウンロードを始める。使えなければ null。
 * files：落とすファイル（Dropbox の list_folder の形）。core：本体（PDF 以外）なら true。
 * cellularOk：モバイル通信で落としてよいと言われたか（false なら、アプリを開いている間に Wi-Fi が切れたら止める）
 */
export async function startBg(book, files, { core, cellularOk, onProgress }) {
  const reg = await registration();
  if (!reg) return null;
  // 同じ本の同じ分をもう裏で落としていれば、それを使う（PDF タブを押し直したときなど）
  for (const [id, job] of Object.entries(await loadJobs())) {
    if (job.key !== book.key || job.core !== core) continue;
    const r = await reg.backgroundFetch.get(id);
    if (r && !r.result) {
      r.addEventListener('progress', () => onProgress?.(r.downloaded, r.downloadTotal || job.total));
      return { id, total: job.total };
    }
  }
  const id = 'dl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  // Background Fetch は「事前確認（CORS プリフライト）が要る通信」を通さないので、認証ヘッダーの要らない一時リンク（4 時間有効）で落とす
  const list = [];
  for (const f of files) list.push({ path: f.path, name: f.name, rev: f.rev, size: f.size || 0, url: new URL(await dbx.tempLink(f.path), location.href).href });
  const total = list.reduce((s, f) => s + f.size, 0);
  const job = { key: book.key, title: book.title, core, cellularOk, files: list, total, startedAt: Date.now() };
  await saveJob(id, job);
  let r;
  try {
    r = await reg.backgroundFetch.fetch(
      id,
      list.map((f) => f.url),
      {
        title: `「${book.title}」${core ? '' : 'の PDF '}をダウンロード中`,
        downloadTotal: total,
        icons: [{ src: import.meta.env.BASE_URL + 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
      },
    );
  } catch (e) {
    await saveJob(id, null);
    throw e;
  }
  r.addEventListener('progress', () => onProgress?.(r.downloaded, r.downloadTotal || total));
  return { id, total };
}

/** アプリを開いている間に Wi-Fi が切れたら、モバイル通信の許可がない裏のダウンロードを止める */
export async function abortBgOnCellular() {
  const reg = await registration();
  if (!reg) return;
  for (const [id, job] of Object.entries(await loadJobs())) {
    if (job.cellularOk) continue;
    const r = await reg.backgroundFetch.get(id);
    if (r && !r.result && (await r.abort())) dlog(`Wi-Fi が切れたので裏のダウンロードを止めた：「${job.title}」`);
  }
}

let collecting = null;
/** 受け箱に届いた分を端末に移す。何度呼んでもよい */
export function collectBg() {
  return (collecting ||= collect().finally(() => (collecting = null)));
}

async function collect() {
  const reg = await registration();
  if (!reg) return;
  const cache = await caches.open(INBOX);
  for (const [id, job] of Object.entries(await loadJobs())) {
    const marker = await cache.match(inboxKey(reg, id, '__done'));
    if (!marker) {
      const r = await reg.backgroundFetch.get(id);
      if (!r && Date.now() - job.startedAt > LOST_AFTER) {
        dlog(`裏のダウンロードを見失った：「${job.title}」`);
        await saveJob(id, null);
        listeners.forEach((fn) => fn({ id, key: job.key, ok: false, job }));
      }
      continue;
    }
    const done = await marker.json();
    let moved = 0;
    for (const f of job.files) {
      const k = inboxKey(reg, id, f.url);
      const res = await cache.match(k);
      if (!res) continue;
      try {
        await storeFile(job.key, f, res);
        moved++;
      } catch (e) {
        dlog(`保存できなかった：${f.name}（${e.message}）`);
      }
      await cache.delete(k);
    }
    await cache.delete(inboxKey(reg, id, '__done'));
    const ok = moved === job.files.length;
    // ジョブには始めた時点で足りなかった本体のファイルを全部入れてあるので、全部移せたら本体はそろった
    if (ok && job.core) await markComplete(job.key);
    dlog(
      `裏のダウンロード${{ success: '完了', fail: '失敗', abort: '中止' }[done.result] || done.result}：「${job.title}」 ${moved}/${job.files.length} 本を保存` +
        (done.failureReason ? `（${done.failureReason}）` : ''),
    );
    await saveJob(id, null);
    listeners.forEach((fn) => fn({ id, key: job.key, ok, job }));
  }
}
