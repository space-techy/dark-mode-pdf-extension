export const api = globalThis.browser ?? globalThis.chrome;

export const PRESETS = [
  { id: 'original', name: 'Original', bg: '#ffffff', fg: '#000000' },
  { id: 'dark', name: 'Dark', bg: '#1c1c1e', fg: '#e3e3e6' },
  { id: 'oled', name: 'OLED Black', bg: '#000000', fg: '#cdcdcd' },
  { id: 'warm-night', name: 'Warm Night', bg: '#1f1a15', fg: '#ead6b8' },
  { id: 'ember', name: 'Ember', bg: '#170e0a', fg: '#e8a37b' },
  { id: 'slate', name: 'Slate', bg: '#252a34', fg: '#d5dae4' },
  { id: 'forest', name: 'Forest', bg: '#17211b', fg: '#cde0d0' },
  { id: 'ocean', name: 'Deep Ocean', bg: '#0b2230', fg: '#bcd3dc' },
  { id: 'sepia', name: 'Sepia', bg: '#f2e7cf', fg: '#4e3c2a' },
  { id: 'paper', name: 'Soft Paper', bg: '#f6f2e9', fg: '#2d2a25' },
  { id: 'sage', name: 'Sage', bg: '#dde8d2', fg: '#2a3826' },
  { id: 'contrast', name: 'High Contrast', bg: '#000000', fg: '#ffffff' },
];

export const DEFAULTS = {
  themeId: 'dark',
  custom: { bg: '#1d2026', fg: '#e8dcc6' },
  customThemes: [],
  autoOpen: true,
  recolorImages: false,
  imageBrightness: 0.9,
  scannedAsText: true,
};

export async function loadSettings() {
  const stored = await api.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

export function saveSettings(patch) {
  return api.storage.local.set(patch);
}

export function onSettingsChanged(cb) {
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const patch = {};
    for (const [k, v] of Object.entries(changes)) patch[k] = v.newValue;
    cb(patch);
  });
}

export function allThemes(settings) {
  return [...PRESETS, { id: 'custom', name: 'Custom', ...settings.custom }, ...(settings.customThemes ?? [])];
}

export function findTheme(settings, id = settings.themeId) {
  return allThemes(settings).find((t) => t.id === id) ?? PRESETS[1];
}

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.3 * r + 0.59 * g + 0.11 * b;
}

export const isOriginal = (theme) => theme.id === 'original';
export const isDark = (theme) => luminance(theme.bg) < luminance(theme.fg);

export function mix(a, b, t) {
  const x = hexToRgb(a), y = hexToRgb(b);
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
