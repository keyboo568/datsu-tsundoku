// マインドマップ（markmap 形式の HTML）を、オフラインでも動くように部品を同梱して表示する。
// 中身はアプリ本体から切り離した枠（sandbox iframe）で動かすので、トークンなどには触れない。
import d3Src from '../node_modules/d3/dist/d3.min.js?raw';
import viewSrc from '../node_modules/markmap-view/dist/browser/index.js?raw';
import libSrc from '../node_modules/markmap-lib/dist/browser/index.iife.js?raw';

const inline = (src) => `<script>${src.replace(/<\/script/gi, '<\\/script')}</script>`;
const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16));

/** markmap の HTML から Markdown 部分を取り出す。markmap でなければ null */
export function extractMarkdown(html) {
  const m = /<script type="text\/template">([\s\S]*?)<\/script>/i.exec(html);
  return m ? m[1].trim() : null;
}

function markmapDoc(md) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%;background:#fff;font-family:"Noto Sans JP",sans-serif}#mm{width:100%;height:100%;display:block}</style>
<script>
addEventListener('error', (e) => parent.postMessage({ mindmapError: String(e.message || e.error) }, '*'));
</script>
${inline(d3Src)}${inline(viewSrc)}${inline(libSrc)}
</head><body><svg id="mm"></svg>
<script>
const { Transformer, Markmap, deriveOptions } = window.markmap;
const { root, frontmatter } = new Transformer().transform(${safeJson(md)});
Markmap.create('#mm', deriveOptions((frontmatter && frontmatter.markmap) || {}), root);
</script></body></html>`;
}

/** container の中にマインドマップを出す */
export function showMindmap(container, html) {
  const md = extractMarkdown(html);
  const frame = document.createElement('iframe');
  frame.className = 'mindmap-frame';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.srcdoc = md ? markmapDoc(md) : html;
  container.replaceChildren(frame);
}

// 枠の中で起きたエラーは、ここで受けて画面に出す
addEventListener('message', (e) => {
  if (!e.data?.mindmapError) return;
  const frame = [...document.querySelectorAll('.mindmap-frame')].find((f) => f.contentWindow === e.source);
  if (!frame) return;
  const note = document.createElement('div');
  note.className = 'mindmap-error';
  note.textContent = 'マインドマップの表示でエラー：' + e.data.mindmapError;
  frame.after(note);
});
