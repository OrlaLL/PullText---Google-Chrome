import { createZip } from './lib/zip.js';

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------
const PROFILES = {
  desktop: {
    key: 'desktop',
    label: 'Desktop',
    width: 1920,
    height: 1080,
    mobile: false
  },
  mobile: {
    key: 'mobile',
    label: 'Mobile',
    width: 480,
    height: 900,
    mobile: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
  }
};

const MAX_PART_HEIGHT = 25000; // altura máxima de cada PNG (limite seguro de canvas)
const MAX_TOTAL_HEIGHT = 150000; // proteção contra páginas de rolagem infinita
const TILE_DELAY_MS = 180; // espera após cada rolagem antes de capturar
const DEBUGGER_VERSION = '1.3';

// ---------------------------------------------------------------------------
// Estado (exibido no popup e no ícone)
// ---------------------------------------------------------------------------
let state = { running: false, step: '', progress: 0, error: null, done: null };

function setState(patch) {
  state = { ...state, ...patch };
  chrome.runtime.sendMessage({ type: 'pulltext:state', state }).catch(() => {});
  if (state.running) {
    chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
    chrome.action.setBadgeText({ text: `${Math.round(state.progress)}%` });
  } else if (state.error) {
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    chrome.action.setBadgeText({ text: '!' });
  } else if (state.done) {
    chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
    chrome.action.setBadgeText({ text: 'OK' });
    setTimeout(() => {
      if (!state.running) chrome.action.setBadgeText({ text: '' });
    }, 6000);
  }
}

const step = (text, progress) => setState({ step: text, progress });

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'pulltext:getState') {
    sendResponse(state);
    return;
  }
  if (msg?.type === 'pulltext:start') {
    startCapture(msg.tabId);
    sendResponse({ ok: true });
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'run-capture' && tab?.id != null) startCapture(tab.id);
});

async function startCapture(tabId) {
  if (state.running) return;
  setState({ running: true, error: null, done: null, step: 'Iniciando…', progress: 1 });
  try {
    const tab = await chrome.tabs.get(tabId);
    const pkg = await buildPackage(tab);
    step('Iniciando download…', 98);
    await downloadZip(pkg.bytes, pkg.filename);
    setState({
      running: false,
      step: 'Concluído',
      progress: 100,
      done: { filename: pkg.filename, files: pkg.fileNames, warnings: pkg.warnings }
    });
  } catch (err) {
    console.error('[PullText]', err);
    setState({ running: false, step: '', progress: 0, error: friendlyError(err) });
  }
}

function friendlyError(err) {
  const msg = String(err?.message || err);
  if (/Another debugger|already attached/i.test(msg))
    return 'O DevTools (F12) está aberto nesta aba. Feche-o e tente novamente.';
  if (/chrome:\/\/|chrome-extension:|Cannot access|cannot be scripted|webstore/i.test(msg))
    return 'Esta página é protegida pelo Chrome e não pode ser capturada. Abra um site comum (http/https).';
  if (/Detached|canceled|not attached/i.test(msg))
    return 'A captura foi interrompida (a barra de depuração foi fechada ou a aba mudou de página).';
  if (/No tab with id/i.test(msg)) return 'A aba foi fechada durante a captura.';
  return msg;
}

// ---------------------------------------------------------------------------
// Fluxo principal
// ---------------------------------------------------------------------------
async function buildPackage(tab) {
  let url;
  try {
    url = new URL(tab.url || '');
  } catch {
    throw new Error('Não foi possível ler o endereço da aba. Clique no ícone do PullText com a página aberta.');
  }
  if (!['http:', 'https:', 'file:'].includes(url.protocol)) {
    throw new Error('chrome:// — página interna');
  }
  if (url.hostname === 'chromewebstore.google.com' || (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'))) {
    throw new Error('webstore');
  }

  const capturedAt = new Date();
  const domain = url.hostname || 'arquivo-local';
  const target = { tabId: tab.id };
  const warnings = [];

  step('Preparando a página…', 3);
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/extractor.js'] });
  const [{ result: originalScroll }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => [window.scrollX, window.scrollY]
  });

  let extracted;
  const shots = {};

  await chrome.debugger.attach(target, DEBUGGER_VERSION);
  try {
    await send(target, 'Page.enable');
    await send(target, 'Emulation.setScrollbarsHidden', { hidden: true }).catch(() => {});

    // ---- Desktop ----
    step('Ajustando layout desktop (1920px)…', 6);
    await applyProfile(target, PROFILES.desktop);
    step('Carregando conteúdo da página (desktop)…', 10);
    await preparePage(target);

    step('Extraindo texto e meta tags…', 22);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.__pullText.extract()
    });
    extracted = result;

    shots.desktop = await captureProfile(target, PROFILES.desktop, 28, 60, warnings);

    // ---- Mobile ----
    step('Ajustando layout mobile (480px)…', 62);
    await applyProfile(target, PROFILES.mobile);
    step('Carregando conteúdo da página (mobile)…', 65);
    await preparePage(target);
    shots.mobile = await captureProfile(target, PROFILES.mobile, 70, 92, warnings);
  } finally {
    await evaluate(target, RESTORE_JS).catch(() => {});
    await chrome.debugger.detach(target).catch(() => {});
    chrome.scripting
      .executeScript({
        target: { tabId: tab.id },
        func: (x, y) => window.scrollTo({ left: x, top: y, behavior: 'instant' }),
        args: originalScroll || [0, 0]
      })
      .catch(() => {});
  }

  step('Montando o arquivo ZIP…', 94);
  const files = [];
  const addImages = (list, base) => {
    if (list.length === 1) files.push({ name: `${base}.png`, data: list[0] });
    else list.forEach((data, i) => files.push({ name: `${base}-parte-${i + 1}.png`, data }));
  };
  addImages(shots.desktop, 'desktop-1920px');
  addImages(shots.mobile, 'mobile-480px');

  const frontMatter = [
    '---',
    `title: ${JSON.stringify(extracted.title || '')}`,
    `url: ${url.href}`,
    `captured_at: ${capturedAt.toISOString()}`,
    '---',
    ''
  ].join('\n');
  files.push({ name: 'conteudo.md', data: frontMatter + '\n' + extracted.markdown + '\n' });
  const meta = extracted.meta;
  const orderedMeta = {
    url: meta.url,
    title: meta.title,
    lang: meta.lang,
    charset: meta.charset,
    summary: meta.summary,
    meta_tags: meta.meta_tags,
    links: meta.links,
    json_ld: meta.json_ld
  };
  files.push({ name: 'meta-tags.json', data: JSON.stringify(orderedMeta, null, 2) + '\n' });
  files.push({ name: 'info.txt', data: buildInfo({ url, domain, title: extracted.title, capturedAt, files, warnings }) });

  const bytes = createZip(files, capturedAt);
  const safeDomain = domain.replace(/[^a-z0-9.\-]/gi, '_');
  return { bytes, filename: `${safeDomain}.zip`, fileNames: files.map((f) => f.name), warnings };
}

function buildInfo({ url, domain, title, capturedAt, files, warnings }) {
  const p = (n) => String(n).padStart(2, '0');
  const d = capturedAt;
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const offset = `UTC${sign}${p(Math.floor(Math.abs(offsetMin) / 60))}:${p(Math.abs(offsetMin) % 60)}`;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const lines = [
    'PullText — informações da captura',
    '==================================',
    '',
    `Domínio:      ${domain}`,
    `URL:          ${url.href}`,
    `Título:       ${title || '(sem título)'}`,
    `Data:         ${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`,
    `Hora:         ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
    `Fuso horário: ${tz} (${offset})`,
    `ISO 8601:     ${d.toISOString()}`,
    '',
    'Arquivos neste ZIP:',
    ...files.map((f) => `  - ${f.name}`),
    '  - info.txt'
  ];
  if (warnings.length) lines.push('', 'Avisos:', ...warnings.map((w) => `  - ${w}`));
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// DevTools Protocol
// ---------------------------------------------------------------------------
function send(target, method, params = {}) {
  return chrome.debugger.sendCommand(target, method, params);
}

async function evaluate(target, expression) {
  const r = await send(target, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('Erro ao executar script na página: ' + (d.exception?.description || d.text));
  }
  return r.result?.value;
}

async function applyProfile(target, p) {
  await evaluate(target, RESTORE_JS).catch(() => {});
  await send(target, 'Emulation.setDeviceMetricsOverride', {
    width: p.width,
    height: p.height,
    deviceScaleFactor: 1,
    mobile: p.mobile,
    screenWidth: p.width,
    screenHeight: p.height
  });
  await send(target, 'Emulation.setTouchEmulationEnabled', { enabled: p.mobile, maxTouchPoints: p.mobile ? 5 : 0 }).catch(() => {});
  if (p.userAgent) {
    await send(target, 'Emulation.setUserAgentOverride', { userAgent: p.userAgent, platform: 'Linux armv8l' }).catch(() => {});
  }
  await evaluate(target, 'new Promise(r => setTimeout(r, 600))');
}

// Rola a página toda para disparar lazy-load, espera imagens e fontes.
const PREPARE_JS = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const se = document.scrollingElement || document.documentElement;
  const stepPx = Math.max(300, Math.floor(window.innerHeight * 0.85));
  const t0 = Date.now();
  let y = 0;
  while (Date.now() - t0 < 25000 && y < ${MAX_TOTAL_HEIGHT}) {
    y += stepPx;
    window.scrollTo({ top: y, left: 0, behavior: 'instant' });
    await sleep(110);
    if (y + window.innerHeight >= se.scrollHeight) break;
  }
  await sleep(400);
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  try { await Promise.race([document.fonts.ready, sleep(3000)]); } catch (e) {}
  const pending = [...document.images].filter((i) => !i.complete);
  await Promise.race([
    Promise.all(pending.map((i) => new Promise((r) => { i.addEventListener('load', r, { once: true }); i.addEventListener('error', r, { once: true }); }))),
    sleep(6000)
  ]);
  await sleep(400);
  return true;
})()`;

async function preparePage(target) {
  await evaluate(target, PREPARE_JS);
}

// Elementos "sticky" passam a "relative" (mesma posição natural, sem repetir).
const PREP_CAPTURE_JS = `(() => {
  window.__ptRestore = window.__ptRestore || [];
  for (const el of document.querySelectorAll('body *')) {
    const pos = getComputedStyle(el).position;
    if (pos === 'sticky' || pos === '-webkit-sticky') {
      window.__ptRestore.push([el, 'position', el.style.getPropertyValue('position'), el.style.getPropertyPriority('position')]);
      el.style.setProperty('position', 'relative', 'important');
    }
  }
  return true;
})()`;

// Após o primeiro trecho, esconde elementos "fixed" (cabeçalhos, chats, banners)
// para que não se repitam em cada parte da imagem.
const HIDE_FIXED_JS = `(() => {
  window.__ptRestore = window.__ptRestore || [];
  for (const el of document.querySelectorAll('body *')) {
    if (getComputedStyle(el).position === 'fixed') {
      window.__ptRestore.push([el, 'visibility', el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
      el.style.setProperty('visibility', 'hidden', 'important');
    }
  }
  return true;
})()`;

const RESTORE_JS = `(() => {
  const list = window.__ptRestore || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const [el, prop, value, prio] = list[i];
    if (value) el.style.setProperty(prop, value, prio); else el.style.removeProperty(prop);
  }
  window.__ptRestore = [];
  return true;
})()`;

// Altura real capturável: rola até o fim e mede.
const MEASURE_JS = `(async () => {
  window.scrollTo({ top: 1e9, left: 0, behavior: 'instant' });
  await new Promise((r) => setTimeout(r, 120));
  const h = Math.ceil(window.scrollY + window.innerHeight);
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  await new Promise((r) => setTimeout(r, 120));
  return { h, iw: window.innerWidth, ih: window.innerHeight };
})()`;

const scrollJs = (y) => `(async () => {
  window.scrollTo({ top: ${y}, left: 0, behavior: 'instant' });
  await Promise.race([
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    new Promise((r) => setTimeout(r, 100))
  ]);
  await new Promise((r) => setTimeout(r, ${TILE_DELAY_MS}));
  return window.scrollY;
})()`;

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Captura a página inteira no perfil atual rolando a tela e "costurando" os
 * trechos numa imagem só. Retorna uma lista de PNGs (normalmente 1; mais de 1
 * só para páginas com mais de MAX_PART_HEIGHT px de altura).
 */
async function captureProfile(target, p, pStart, pEnd, warnings) {
  await evaluate(target, PREP_CAPTURE_JS);
  const m = await evaluate(target, MEASURE_JS);
  // Em sites sem <meta viewport> o celular renderiza com zoom reduzido:
  // 1px CSS != 1px da imagem. "scale" converte CSS -> pixels da imagem.
  const scale = m.iw > 0 ? p.width / m.iw : 1;
  let total = Math.ceil(m.h * scale);
  if (total > MAX_TOTAL_HEIGHT) {
    warnings.push(`${p.label}: página muito longa (${total}px); captura limitada a ${MAX_TOTAL_HEIGHT}px.`);
    total = MAX_TOTAL_HEIGHT;
  }
  const vh = p.height;
  const tilesTotal = Math.ceil(total / vh);
  let tileCount = 0;
  let firstTile = true;
  let gap = false;
  const parts = [];

  for (let partStart = 0; partStart < total; partStart += MAX_PART_HEIGHT) {
    const partH = Math.min(MAX_PART_HEIGHT, total - partStart);
    const canvas = new OffscreenCanvas(p.width, partH);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, p.width, partH);

    for (let y = partStart; y < partStart + partH; y += vh) {
      tileCount++;
      step(`Capturando ${p.label.toLowerCase()} (${p.width}px) — trecho ${tileCount} de ${tilesTotal}…`,
        pStart + ((pEnd - pStart) * tileCount) / tilesTotal);

      const sy = Math.round((await evaluate(target, scrollJs(y / scale))) * scale);
      const shot = await send(target, 'Page.captureScreenshot', { format: 'png', fromSurface: true });
      if (firstTile) {
        firstTile = false;
        await evaluate(target, HIDE_FIXED_JS);
      }

      const bmp = await createImageBitmap(new Blob([b64ToBytes(shot.data)], { type: 'image/png' }));
      const ratio = bmp.width / p.width;
      const srcY = Math.max(0, y - sy);
      const drawH = Math.min(vh - srcY, partStart + partH - y, Math.floor(bmp.height / ratio) - srcY);
      if (drawH > 0) {
        ctx.drawImage(bmp, 0, srcY * ratio, bmp.width, drawH * ratio, 0, y - partStart, p.width, drawH);
      } else {
        gap = true;
      }
      bmp.close();
    }

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    parts.push(new Uint8Array(await blob.arrayBuffer()));
  }

  await evaluate(target, RESTORE_JS);
  await evaluate(target, `window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); true`);
  if (parts.length > 1) warnings.push(`${p.label}: página com ${total}px de altura foi dividida em ${parts.length} imagens.`);
  if (gap) warnings.push(`${p.label}: a página usa uma área de rolagem interna; parte do conteúdo pode não aparecer na imagem.`);
  return parts;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------
async function downloadZip(bytes, filename) {
  const url = 'data:application/zip;base64,' + bytesToB64(bytes);
  await chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
}

