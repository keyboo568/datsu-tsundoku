import { defineConfig, loadEnv } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'node:fs';
import path from 'node:path';

// 試験モード（npm run dev:mock）用：PC のフォルダを「読み取り専用の Dropbox もどき」として配信する。
// 書き込み系は一切持たない（アプリ側の書き込みはブラウザ内に保存して終わり）。
function mockDropbox(root) {
  const resolveSafe = (p) => {
    const abs = path.resolve(root, '.' + path.sep + (p || '').replace(/^\/+/, ''));
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('outside root');
    return abs;
  };
  return {
    name: 'mock-dropbox',
    configureServer(server) {
      server.middlewares.use('/__mock/list', (req, res) => {
        try {
          const url = new URL(req.url, 'http://x');
          const rel = url.searchParams.get('path') || '';
          const recursive = url.searchParams.get('recursive') === '1';
          const out = [];
          const walk = (dirRel) => {
            for (const d of fs.readdirSync(resolveSafe(dirRel), { withFileTypes: true })) {
              const childRel = dirRel + '/' + d.name;
              const st = fs.statSync(resolveSafe(childRel));
              out.push({
                '.tag': d.isDirectory() ? 'folder' : 'file',
                name: d.name,
                path_display: childRel,
                path_lower: childRel.toLowerCase(),
                size: d.isDirectory() ? undefined : st.size,
                rev: d.isDirectory() ? undefined : String(st.mtimeMs | 0),
              });
              if (recursive && d.isDirectory()) walk(childRel);
            }
          };
          walk(rel);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ entries: out }));
        } catch (e) {
          res.statusCode = 409;
          res.end(JSON.stringify({ error_summary: 'path/not_found/' }));
        }
      });
      server.middlewares.use('/__mock/file', (req, res) => {
        try {
          const url = new URL(req.url, 'http://x');
          const abs = resolveSafe(url.searchParams.get('path') || '');
          const size = fs.statSync(abs).size;
          res.setHeader('Accept-Ranges', 'bytes');
          const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
          if (m) {
            const start = +m[1];
            const end = m[2] ? Math.min(+m[2], size - 1) : size - 1;
            res.statusCode = 206;
            res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
            res.setHeader('Content-Length', end - start + 1);
            fs.createReadStream(abs, { start, end }).pipe(res);
          } else {
            res.setHeader('Content-Length', size);
            fs.createReadStream(abs).pipe(res);
          }
        } catch (e) {
          res.statusCode = 404;
          res.end();
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const isMock = mode === 'mock';
  if (isMock && !env.MOCK_ROOT) throw new Error('.env に MOCK_ROOT（試験モードで読むフォルダ）を書いてください');
  return {
    base: env.BASE_PATH || '/',
    // Dropbox に登録する戻り先 URL と合わせるため、ポートは固定
    server: { port: 5199, strictPort: true },
    define: { __MOCK__: JSON.stringify(isMock) },
    plugins: [
      isMock && mockDropbox(path.resolve(env.MOCK_ROOT)),
      VitePWA({
        registerType: 'prompt',
        includeAssets: ['icons/*.png'],
        manifest: {
          name: '脱ツンドク',
          short_name: '脱ツンドク',
          description: 'Dropbox の PDF と音声で積ん読を崩す本棚',
          lang: 'ja',
          display: 'standalone',
          background_color: '#f4efe6',
          theme_color: '#3b2f2a',
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,mjs,css,html,png,svg}'],
          maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
          navigateFallbackDenylist: [/^\/__mock\//],
        },
      }),
    ].filter(Boolean),
  };
});
