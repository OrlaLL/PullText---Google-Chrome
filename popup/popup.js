const $ = (id) => document.getElementById(id);
let currentTab = null;

function render(state) {
  if (!state) return;
  $('run').disabled = state.running;
  $('run').textContent = state.running ? 'Capturando…' : 'Capturar e baixar ZIP';

  $('progress').hidden = !state.running;
  $('bar-fill').style.width = `${state.progress || 0}%`;
  $('step').textContent = state.step || '';

  $('error').hidden = !state.error;
  $('error').textContent = state.error || '';

  const done = $('done');
  done.hidden = !state.done || state.running;
  done.textContent = '';
  if (state.done && !state.running) {
    done.append('Download iniciado: ');
    const s = document.createElement('strong');
    s.textContent = state.done.filename;
    done.append(s);
    if (state.done.warnings?.length) {
      const ul = document.createElement('ul');
      for (const w of state.done.warnings) {
        const li = document.createElement('li');
        li.textContent = w;
        ul.append(li);
      }
      done.append(ul);
    }
  }
}

async function init() {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const u = new URL(currentTab?.url || '');
    $('domain').textContent = u.hostname || u.href;
    if (!['http:', 'https:', 'file:'].includes(u.protocol)) {
      $('run').disabled = true;
      $('error').hidden = false;
      $('error').textContent = 'Esta página é interna do Chrome e não pode ser capturada.';
      return;
    }
  } catch {
    $('domain').textContent = '';
  }
  render(await chrome.runtime.sendMessage({ type: 'pulltext:getState' }));
}

$('run').addEventListener('click', async () => {
  if (!currentTab) return;
  render({ running: true, step: 'Iniciando…', progress: 1 });
  await chrome.runtime.sendMessage({ type: 'pulltext:start', tabId: currentTab.id });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'pulltext:state') render(msg.state);
});

init();
