// バックグラウンドダウンロード（Background Fetch）の受け口。Service Worker に読み込ませる。
// 落とし終わったファイルは Cache Storage の「受け箱」に置き、アプリが開いたときに端末の保存場所（OPFS）へ移す。
// 受け箱の鍵：<scope>__bgfetch/<id>/<元の URL>。最後に <scope>__bgfetch/<id>/__done に結果を書く。
const INBOX = 'datsu-bgfetch-inbox';
const inboxKey = (id, name) => new URL('__bgfetch/' + encodeURIComponent(id) + '/' + encodeURIComponent(name), self.registration.scope).href;

async function stash(event, result) {
  const reg = event.registration;
  const cache = await caches.open(INBOX);
  let saved = 0;
  let total = 0;
  try {
    const records = await reg.matchAll();
    total = records.length;
    for (const rec of records) {
      try {
        const res = await rec.responseReady;
        if (!res.ok) continue; // 失敗・中身を読めない応答は置かない（次に開いたとき続きから落とし直す）
        await cache.put(inboxKey(reg.id, rec.request.url), res);
        saved++;
      } catch {}
    }
  } catch {}
  const done = { result, failureReason: reg.failureReason || '', saved, total, at: Date.now() };
  await cache.put(inboxKey(reg.id, '__done'), new Response(JSON.stringify(done)));
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  clients.forEach((c) => c.postMessage({ type: 'bgfetch-done', id: reg.id }));
}

self.addEventListener('backgroundfetchsuccess', (event) => {
  event.waitUntil(
    (async () => {
      await stash(event, 'success');
      await event.updateUI({ title: 'ダウンロードしました' }).catch(() => {});
    })(),
  );
});

self.addEventListener('backgroundfetchfail', (event) => {
  event.waitUntil(
    (async () => {
      await stash(event, 'fail');
      await event.updateUI({ title: 'ダウンロードが途中で止まりました（アプリを開くと続きから）' }).catch(() => {});
    })(),
  );
});

self.addEventListener('backgroundfetchabort', (event) => {
  event.waitUntil(stash(event, 'abort'));
});

// 通知をタップしたらアプリを開く
self.addEventListener('backgroundfetchclick', (event) => {
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (wins.length) return wins[0].focus();
      return self.clients.openWindow(self.registration.scope);
    })(),
  );
});
