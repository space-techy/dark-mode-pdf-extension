import { api, loadSettings, saveSettings, allThemes } from '../shared/themes.js';

const VIEWER = api.runtime.getURL('viewer/viewer.html');
const $ = (id) => document.getElementById(id);

async function init() {
  const settings = await loadSettings();

  const draw = () => {
    $('swatches').replaceChildren(...allThemes(settings).map((theme) => {
      const b = document.createElement('button');
      b.className = 'swatch' + (theme.id === settings.themeId ? ' active' : '');
      b.title = theme.name;
      b.innerHTML = '<span class="chip">Aa</span><span class="name"></span>';
      b.querySelector('.chip').style.cssText = `background:${theme.bg};color:${theme.fg}`;
      b.querySelector('.name').textContent = theme.name;
      b.addEventListener('click', () => {
        settings.themeId = theme.id;
        saveSettings({ themeId: theme.id });
        draw();
      });
      return b;
    }));
  };
  draw();

  $('autoOpen').checked = settings.autoOpen;
  $('autoOpen').addEventListener('change', (e) => saveSettings({ autoOpen: e.target.checked }));
  $('keepImages').checked = !settings.recolorImages;
  $('keepImages').addEventListener('change', (e) => saveSettings({ recolorImages: !e.target.checked }));

  $('openLocal').addEventListener('click', () => {
    api.tabs.create({ url: VIEWER });
    window.close();
  });

  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? '';
  const isPdf = /^(https?|file):/i.test(url) && (/\.pdf([?#].*)?$/i.test(url) || /\.pdf$/i.test(tab?.title ?? ''));
  if (isPdf && !url.startsWith(VIEWER)) {
    $('openTab').hidden = false;
    $('openTab').addEventListener('click', () => {
      api.tabs.update(tab.id, { url: `${VIEWER}?file=${encodeURIComponent(url)}` });
      window.close();
    });
  }
}

init();
