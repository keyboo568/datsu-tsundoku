// v1.08 で使っていた Android の「バックグラウンドダウンロード」（Background Fetch）の後片付け。
// 途中で止まったまま進まないことがあったので v1.09 でやめた。端末に残った分を止めて、受け箱と記録を消す。
import { kvGet, kvDel, dlog } from './store.js';

export async function clearBg() {
  const jobs = await kvGet('bg-jobs');
  const reg = 'BackgroundFetchManager' in self && (await navigator.serviceWorker?.getRegistration());
  if (reg?.backgroundFetch) {
    for (const id of await reg.backgroundFetch.getIds()) {
      const r = await reg.backgroundFetch.get(id);
      if (r && !r.result && (await r.abort())) dlog(`裏のダウンロードを止めた：「${jobs?.[id]?.title || id}」（この版から画面で落とします）`);
    }
  }
  if (jobs) await kvDel('bg-jobs');
  if (self.caches) await caches.delete('datsu-bgfetch-inbox');
}
