// PDF 表示（pdf.js）。100MB 超の自炊 PDF でも、必要なページの分だけ読み込んで描く。
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const CHUNK = 256 * 1024;

/** File（ダウンロード済み）か URL（ネット経由）から PDF を開く */
export async function openPdf(source) {
  if (source instanceof Blob) {
    const head = new Uint8Array(await source.slice(0, CHUNK).arrayBuffer());
    const transport = new pdfjs.PDFDataRangeTransport(source.size, head);
    transport.requestDataRange = (begin, end) => {
      source
        .slice(begin, end)
        .arrayBuffer()
        .then((buf) => transport.onDataRange(begin, new Uint8Array(buf)));
    };
    return pdfjs.getDocument({ range: transport, disableAutoFetch: true, disableStream: true, rangeChunkSize: CHUNK }).promise;
  }
  return pdfjs.getDocument({ url: source, disableAutoFetch: true, disableStream: true, rangeChunkSize: CHUNK }).promise;
}

/** 開いた PDF を閉じる（pdf.js v6 では閉じる口が loadingTask 側にある） */
export const closePdf = (doc) => doc.loadingTask.destroy();

/** 1 ページ目を表紙画像（JPEG）にする */
export async function renderCover(doc, width = 360) {
  const page = await doc.getPage(1);
  const vp0 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / vp0.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  return new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', 0.8));
}

/** 縦スクロールで読む PDF ビューア。見えているページの前後だけ描く */
export class PdfViewer {
  constructor(container, doc, { startPage = 1, onPage } = {}) {
    this.el = container;
    this.doc = doc;
    this.onPage = onPage;
    this.zoom = 1;
    this.page = startPage;
    this.rendered = new Map(); // ページ番号 → { task, canvas }
    this.el.classList.add('pdf-scroll');
    this.inner = document.createElement('div');
    this.inner.className = 'pdf-pages';
    this.el.append(this.inner);
    this.ready = this.setup(startPage);
  }

  async setup(startPage) {
    const first = await this.doc.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    this.ratio = vp.height / vp.width;
    this.slots = [];
    for (let n = 1; n <= this.doc.numPages; n++) {
      const slot = document.createElement('div');
      slot.className = 'pdf-page';
      slot.dataset.n = n;
      slot.innerHTML = `<span class="pdf-num">${n}</span>`;
      this.inner.append(slot);
      this.slots.push(slot);
    }
    this.layout();
    this.io = new IntersectionObserver((list) => this.onIntersect(list), { root: this.el, rootMargin: '120% 0px' });
    this.slots.forEach((s) => this.io.observe(s));
    this.el.addEventListener('scroll', () => this.trackPage(), { passive: true });
    this.goTo(startPage);
  }

  get pageWidth() {
    return this.el.clientWidth * this.zoom;
  }

  layout() {
    const w = this.pageWidth;
    this.inner.style.width = w + 'px';
    for (const s of this.slots) s.style.height = Math.round(w * (s.dataset.ratio || this.ratio)) + 'px';
  }

  onIntersect(list) {
    for (const e of list) {
      const n = +e.target.dataset.n;
      if (e.isIntersecting) this.renderPage(n);
    }
    // 離れたページは捨ててメモリを空ける
    for (const n of [...this.rendered.keys()]) if (Math.abs(n - this.page) > 5) this.unrender(n);
  }

  async renderPage(n) {
    if (this.rendered.has(n)) return;
    const entry = { task: null, canvas: null };
    this.rendered.set(n, entry);
    const page = await this.doc.getPage(n);
    if (this.rendered.get(n) !== entry) return;
    const slot = this.slots[n - 1];
    const base = page.getViewport({ scale: 1 });
    const ratio = base.height / base.width;
    if (Math.abs(ratio - this.ratio) > 0.01) {
      slot.dataset.ratio = ratio;
      slot.style.height = Math.round(this.pageWidth * ratio) + 'px';
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = Math.min((this.pageWidth * dpr) / base.width, 4096 / base.width);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    entry.canvas = canvas;
    entry.task = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp });
    try {
      await entry.task.promise;
      if (this.rendered.get(n) === entry) slot.append(canvas);
    } catch {}
  }

  unrender(n) {
    const entry = this.rendered.get(n);
    if (!entry) return;
    entry.task?.cancel();
    entry.canvas?.remove();
    if (entry.canvas) entry.canvas.width = entry.canvas.height = 0;
    this.rendered.delete(n);
  }

  trackPage() {
    const top = this.el.scrollTop + this.el.clientHeight / 3;
    let n = 1;
    for (const s of this.slots) {
      if (s.offsetTop <= top) n = +s.dataset.n;
      else break;
    }
    if (n !== this.page) {
      this.page = n;
      this.onPage?.(n);
    }
  }

  goTo(n) {
    n = Math.max(1, Math.min(this.doc.numPages, n));
    this.page = n;
    this.el.scrollTop = this.slots[n - 1].offsetTop - 8;
    this.onPage?.(n);
  }

  setZoom(z) {
    const n = this.page;
    this.zoom = Math.max(1, Math.min(3, z));
    for (const k of [...this.rendered.keys()]) this.unrender(k);
    this.layout();
    this.goTo(n);
    this.slots.forEach((s) => {
      this.io.unobserve(s);
      this.io.observe(s);
    });
  }

  destroy() {
    this.io?.disconnect();
    for (const k of [...this.rendered.keys()]) this.unrender(k);
    closePdf(this.doc);
  }
}
