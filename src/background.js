const api = globalThis.browser ?? globalThis.chrome;
const VIEWER = api.runtime.getURL('viewer/viewer.html');
const REDIRECT_RULE = 1;
const bypassed = new Set();

const viewerUrl = (url) => `${VIEWER}?file=${encodeURIComponent(url)}`;
const isViewer = (url) => url?.startsWith(VIEWER);
const looksLikePdf = (url) => /^(https?|file):\/\/[^?#]+\.pdf([?#].*)?$/i.test(url ?? '');

async function autoOpen() {
  const { autoOpen = true } = await api.storage.local.get('autoOpen');
  return autoOpen;
}

async function syncRedirectRule() {
  const dnr = api.declarativeNetRequest;
  if (!dnr?.updateDynamicRules) return;
  const enabled = await autoOpen();
  await dnr.updateDynamicRules({
    removeRuleIds: [REDIRECT_RULE],
    addRules: enabled ? [{
      id: REDIRECT_RULE,
      priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: `${VIEWER}?file=\\0` } },
      condition: {
        regexFilter: '^https?://[^?#]+\\.pdf(\\?[^#]*)?$',
        isUrlFilterCaseSensitive: false,
        resourceTypes: ['main_frame'],
        requestMethods: ['get'],
      },
    }] : [],
  }).catch((err) => console.warn('Lumen: redirect rule unavailable', err));
}

async function bypass(url) {
  bypassed.add(url);
  const dnr = api.declarativeNetRequest;
  if (!dnr?.updateSessionRules) return;
  const rules = await dnr.getSessionRules();
  const id = rules.reduce((max, r) => Math.max(max, r.id), 100) + 1;
  await dnr.updateSessionRules({
    addRules: [{ id, priority: 2, action: { type: 'allow' }, condition: { urlFilter: `|${url}|`, resourceTypes: ['main_frame'] } }],
  }).catch(() => {});
}

function openInViewer(tabId, url) {
  if (!url || isViewer(url) || bypassed.has(url)) return;
  api.tabs.update(tabId, { url: viewerUrl(url) });
}

// PDFs whose URL doesn't end in .pdf are detected by their Content-Type.
api.webRequest?.onHeadersReceived.addListener(async (details) => {
  if (details.method !== 'GET' || details.statusCode !== 200 || details.tabId < 0) return;
  const header = (name) => details.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
  if (!/^application\/(x-)?pdf/i.test(header('content-type'))) return;
  if (/^\s*attachment/i.test(header('content-disposition'))) return;
  if (await autoOpen()) openInViewer(details.tabId, details.url);
}, { urls: ['<all_urls>'], types: ['main_frame'] }, ['responseHeaders']);

// Local files and browsers without redirect support (e.g. Safari).
api.tabs.onUpdated.addListener(async (tabId, change) => {
  if (!change.url || !looksLikePdf(change.url) || isViewer(change.url)) return;
  const isFile = change.url.startsWith('file:');
  if (!isFile && api.declarativeNetRequest?.updateDynamicRules) return;
  if (await autoOpen()) openInViewer(tabId, change.url);
});

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'bypass') return;
  bypass(message.url).then(() => sendResponse(true));
  return true;
});

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'autoOpen' in changes) syncRedirectRule();
});

api.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'lumen-open-link' && info.linkUrl) {
    api.tabs.create({ url: viewerUrl(info.linkUrl), index: tab ? tab.index + 1 : undefined });
  }
});

api.runtime.onInstalled.addListener(async () => {
  syncRedirectRule();
  if (!api.contextMenus) return;
  await api.contextMenus.removeAll();
  api.contextMenus.create({
    id: 'lumen-open-link',
    title: 'Open PDF in Lumen',
    contexts: ['link'],
    targetUrlPatterns: ['*://*/*.pdf', '*://*/*.PDF', '*://*/*.pdf?*'],
  });
});

api.runtime.onStartup?.addListener(syncRedirectRule);
