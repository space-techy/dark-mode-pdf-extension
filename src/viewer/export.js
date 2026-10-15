import { isDark } from '../shared/themes.js';
import { themeParams, findImageRects, protectedRects, subtractRects, paintThemed } from './recolor.js';

const fmt = (n) => (Math.round(n * 1000) / 1000).toString();
const rectOps = (rects) => rects.map(([x0, y0, x1, y1]) => `${fmt(x0)} ${fmt(y0)} ${fmt(x1 - x0)} ${fmt(y1 - y0)} re`).join('\n');

/**
 * Re-colours the original PDF with blend-mode overlays. Text stays vector and
 * selectable, images are cut out of the overlay so they keep their colours.
 */
async function exportVector(pdf, pdfjs, theme, options, onProgress) {
  const { PDFDocument, PDFName } = await import('../lib/pdf-lib.esm.min.js');
  const doc = await PDFDocument.load(await pdf.getData(), { updateMetadata: false });
  const ctx = doc.context;
  const { dark, base, k } = themeParams(theme);
  const mul = base.map((b, i) => (b < 1 ? Math.min(1, k[i] / (1 - b)) : 0));
  const gs = (BM, extra = {}) => ctx.register(ctx.obj({ Type: 'ExtGState', BM, ...extra }));
  const states = {
    diff: gs('Difference'),
    hue: gs('Hue'),
    mul: gs('Multiply'),
    screen: gs('Screen'),
    dim: gs('Normal', { ca: 1 - options.imageBrightness }),
  };

  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const leaf = page.node;
    const box = page.getMediaBox();
    const outer = [box.x, box.y, box.x + box.width, box.y + box.height];

    const jsPage = await pdf.getPage(i + 1);
    const rects = protectedRects(findImageRects(await jsPage.getOperatorList(), pdfjs.OPS), outer, options);
    jsPage.cleanup();

    let original = null;
    if (dark) {
      try {
        const embedded = await doc.embedPage(page, { left: outer[0], bottom: outer[1], right: outer[2], top: outer[3] }, [1, 0, 0, 1, 0, 0]);
        await embedded.embed();
        // As one isolated group, so blend modes set inside the page can't override "Hue".
        ctx.lookup(embedded.ref).dict.set(PDFName.of('Group'), ctx.obj({ S: 'Transparency', I: true }));
        original = leaf.newXObject('LumenSrc', embedded.ref);
      } catch {
        // Unsupported content stream encodings: fall back to a plain inversion.
      }
    }

    const name = (key) => leaf.newExtGState('Lumen', states[key]);
    const region = rectOps(subtractRects(outer, rects));
    const ops = [];
    if (dark) {
      ops.push(`q /${name('diff')} gs 1 g ${region} f Q`);
      if (original) ops.push(`q /${name('hue')} gs /${original} Do Q`);
    }
    if (mul.some((m) => m < 1)) ops.push(`q /${name('mul')} gs ${mul.map(fmt).join(' ')} rg ${region} f Q`);
    if (base.some((b) => b > 0)) ops.push(`q /${name('screen')} gs ${base.map(fmt).join(' ')} rg ${region} f Q`);
    if (rects.length && options.imageBrightness < 1) ops.push(`q /${name('dim')} gs 0 g ${rectOps(rects)} f Q`);

    const contents = leaf.normalizedEntries().Contents?.asArray() ?? [];
    const pre = ctx.register(ctx.flateStream(`q 1 g ${rectOps([outer])} f Q q\n`));
    const post = ctx.register(ctx.flateStream(`\nQ\n${ops.join('\n')}\n`));
    leaf.set(PDFName.of('Contents'), ctx.obj([pre, ...contents, post]));

    onProgress((i + 1) / pages.length);
  }
  return doc.save();
}

/** Renders every page with the on-screen pipeline and stores the result as images. */
async function exportRaster(pdf, pdfjs, theme, options, onProgress) {
  const { PDFDocument } = await import('../lib/pdf-lib.esm.min.js');
  const doc = await PDFDocument.create();
  const dpi = options.quality === 'high' ? 220 : 150;

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const size = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: dpi / 72 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const c2d = canvas.getContext('2d', { willReadFrequently: true });
    const task = page.render({ canvasContext: c2d, viewport });
    await task.promise;

    if (theme.id !== 'original') {
      const opList = task._internalRenderTask?.operatorList ?? (await page.getOperatorList());
      const rects = protectedRects(findImageRects(opList, pdfjs.OPS), page.view, options).map((r) => {
        const [x0, y0, x1, y1] = viewport.convertToViewportRectangle(r);
        return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
      });
      paintThemed(c2d, c2d.getImageData(0, 0, canvas.width, canvas.height), theme, rects, options.imageBrightness);
    }

    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
    const image = await doc.embedJpg(await blob.arrayBuffer());
    doc.addPage([size.width, size.height]).drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
    canvas.width = canvas.height = 0;
    page.cleanup();
    onProgress(i / pdf.numPages);
  }
  return doc.save();
}

export async function exportThemedPdf({ pdf, pdfjs, theme, format, options, onProgress = () => {} }) {
  if (format === 'vector') {
    try {
      return { bytes: await exportVector(pdf, pdfjs, theme, options, onProgress), format };
    } catch (err) {
      console.warn('Vector export failed, using image export instead.', err);
    }
  }
  return { bytes: await exportRaster(pdf, pdfjs, theme, options, onProgress), format: 'image' };
}

export function themedFileName(name, theme) {
  const stem = name.replace(/\.pdf$/i, '') || 'document';
  const tag = theme.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${stem}-${tag || (isDark(theme) ? 'dark' : 'light')}.pdf`;
}
