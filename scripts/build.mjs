import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const zip = process.argv.includes('--zip');

const LIBS = {
  'pdf.mjs': 'node_modules/pdfjs-dist/legacy/build/pdf.min.mjs',
  'pdf.worker.mjs': 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  'cmaps': 'node_modules/pdfjs-dist/cmaps',
  'standard_fonts': 'node_modules/pdfjs-dist/standard_fonts',
  'pdf-lib.esm.min.js': 'node_modules/pdf-lib/dist/pdf-lib.esm.min.js',
};

const icons = Object.fromEntries([16, 32, 48, 128].map((s) => [s, `icons/icon-${s}.png`]));

const base = {
  manifest_version: 3,
  name: 'Lumen PDF – Dark Mode & Eye-Comfort Reader',
  short_name: 'Lumen PDF',
  version: pkg.version,
  description: pkg.description,
  icons,
  action: { default_popup: 'popup/popup.html', default_icon: icons, default_title: 'Lumen PDF' },
  permissions: ['storage', 'contextMenus', 'declarativeNetRequestWithHostAccess', 'webRequest'],
  host_permissions: ['<all_urls>'],
  web_accessible_resources: [{ resources: ['viewer/viewer.html'], matches: ['<all_urls>'] }],
};

const targets = {
  chrome: {
    ...base,
    minimum_chrome_version: '111',
    background: { service_worker: 'background.js' },
  },
  firefox: {
    ...base,
    background: { scripts: ['background.js'] },
    browser_specific_settings: { gecko: { id: 'lumen-pdf@lumen-reader', strict_min_version: '115.0' } },
  },
  safari: {
    ...base,
    permissions: ['storage', 'contextMenus', 'tabs'],
    background: { service_worker: 'background.js' },
  },
};

for (const [name, manifest] of Object.entries(targets)) {
  const out = path.join(root, 'dist', name);
  await rm(out, { recursive: true, force: true });
  await mkdir(path.join(out, 'lib'), { recursive: true });
  await cp(path.join(root, 'src'), out, { recursive: true, filter: (f) => !f.endsWith('.svg') });
  for (const [dest, src] of Object.entries(LIBS)) {
    await cp(path.join(root, src), path.join(out, 'lib', dest), { recursive: true });
  }
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (zip) execFileSync('zip', ['-qr', `../lumen-pdf-${name}-${pkg.version}.zip`, '.'], { cwd: out });
  console.log(`✓ dist/${name}`);
}
