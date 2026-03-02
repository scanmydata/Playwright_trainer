'use strict';
/* eslint-disable no-undef */

// ── Socket.io connection ────────────────────────────────────────────────────
const socket = io();

// ── DOM refs ─────────────────────────────────────────────────────────────────
const btnStart        = document.getElementById('btn-start');
const btnStop         = document.getElementById('btn-stop');
const btnWipe         = document.getElementById('btn-wipe');
const btnRefresh      = document.getElementById('btn-refresh');
const btnRun          = document.getElementById('btn-run');
const btnViewScript   = document.getElementById('btn-view-script');
const btnSaveConfirm  = document.getElementById('btn-save-confirm');
const btnSaveCancel   = document.getElementById('btn-save-cancel');
const btnAddParam     = document.getElementById('btn-add-param');
const btnViewClose    = document.getElementById('btn-view-close');
const btnImportChrome = document.getElementById('btn-import-chrome');
const btnOpenVnc      = document.getElementById('btn-open-vnc');
const chromeImportFile = document.getElementById('chrome-import-file');
const chromeImportFilename = document.getElementById('chrome-import-filename');

const startUrlInput   = document.getElementById('start-url');
const actionLog       = document.getElementById('action-log');
const serverLog       = document.getElementById('server-log');
const runLog          = document.getElementById('run-log');
const actionCount     = document.getElementById('action-count');
const statusBadge     = document.getElementById('status-badge');

const runScriptSelect = document.getElementById('run-script-name');
const runParamsTA     = document.getElementById('run-params');
const loopParamsTA    = document.getElementById('loop-params');

const modalSave       = document.getElementById('modal-save');
const modalView       = document.getElementById('modal-view');
const modalOverlay    = document.getElementById('modal-overlay');
const modalActionCount = document.getElementById('modal-action-count');
const scriptNameInput = document.getElementById('script-name');
const paramList       = document.getElementById('param-list');
const scriptsList     = document.getElementById('scripts-list');
const scriptSourceCode = document.getElementById('script-source-code');

const MAX_PARAM_NAME_LENGTH = 30;

// ── VNC URL ───────────────────────────────────────────────────────────────────
/**
 * Compute the noVNC viewer URL for the current environment.
 * - Local:       http://localhost:6080/vnc.html?...
 * - Codespaces:  the server returns the exact URL via /api/vnc-url (env vars),
 *                otherwise we derive it by replacing the port in the subdomain.
 */
let vncUrl = _deriveVncUrl(); // synchronous fallback, overridden by server below

function _deriveVncUrl() {
  const { protocol, hostname } = window.location;
  const params = 'autoconnect=1&resize=scale';
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return `${protocol}//${hostname}:6080/vnc.html?${params}`;
  }
  // Forwarded-port hostname: {name}-PORT.{domain} → replace PORT with 6080
  const dot = hostname.indexOf('.');
  if (dot === -1) return `${protocol}//${hostname}:6080/vnc.html?${params}`;
  const sub = hostname.slice(0, dot).replace(/-\d+$/, '-6080');
  return `${protocol}//${sub}${hostname.slice(dot)}/vnc.html?${params}`;
}

// Ask the server (it has access to Codespaces env vars for an exact URL)
fetch('/api/vnc-url')
  .then(response => response.json())
  .then(data => { if (data && data.url) vncUrl = data.url; })
  .catch(() => { /* keep derived URL */ });


let currentActions = [];
let paramCounter   = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtDate(d) {
  return new Date(d).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function appendLog(box, text, cls = '') {
  const el = document.createElement('div');
  el.className = 'log-entry ' + cls;
  el.textContent = text;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function actionLabel(action) {
  switch (action.type) {
    case 'goto':         return `🌐 goto → ${action.url}`;
    case 'click':        return `👆 click  ${action.selector}${action.text ? ` [${action.text.substring(0,40)}]` : ''}`;
    case 'fill':         return `✏️  fill   ${action.selector} = ${action.sensitive ? '****' : action.value}`;
    case 'selectOption': return `📋 select ${action.selector} = ${action.label || action.value}`;
    case 'check':        return `☑️  ${action.checked ? 'check' : 'uncheck'}  ${action.selector}`;
    case 'download':     return `⬇️  download → ${action.filename}`;
    default:             return `❔ ${action.type} ${JSON.stringify(action).substring(0,60)}`;
  }
}

function actionClass(type) {
  const map = {
    goto: 'log-action-goto',
    click: 'log-action-click',
    fill: 'log-action-fill',
    selectOption: 'log-action-selectOption',
    check: 'log-action-check',
    download: 'log-action-download',
  };
  return map[type] || '';
}

function setRecordingState(isRecording) {
  btnStart.disabled = isRecording;
  btnStop.disabled  = !isRecording;
  if (isRecording) {
    statusBadge.textContent = '● Recording';
    statusBadge.className   = 'badge badge-recording';
    btnWipe.disabled = true;
  } else {
    statusBadge.textContent = '● Idle';
    statusBadge.className   = 'badge badge-idle';
    // Enable wipe only when there are unsaved actions
    btnWipe.disabled = currentActions.length === 0;
  }
}

// ── Modal helpers ─────────────────────────────────────────────────────────────
function openModal(modal) {
  modal.hidden = false;
  modalOverlay.hidden = false;
}
function closeModal(modal) {
  modal.hidden = true;
  modalOverlay.hidden = true;
}

// ── Scripts API ───────────────────────────────────────────────────────────────
async function loadScripts() {
  const res  = await fetch('/api/scripts');
  const list = await res.json();

  // Update sidebar list
  scriptsList.innerHTML = '';
  if (list.length === 0) {
    scriptsList.innerHTML = '<div class="scripts-empty">No scripts yet. Record one!</div>';
  } else {
    list.forEach(s => {
      const item = document.createElement('div');
      item.className = 'script-item';
      item.innerHTML = `
        <span class="script-item-name" title="${s.file}">${s.name}</span>
        <span class="script-item-date">${fmtDate(s.created)}</span>
        <button class="btn btn-sm btn-danger" data-del="${s.name}" title="Delete">✕</button>
      `;
      item.querySelector('[data-del]').addEventListener('click', async () => {
        if (!confirm(`Delete "${s.name}"?`)) return;
        await fetch(`/api/scripts/${encodeURIComponent(s.name)}`, { method: 'DELETE' });
        loadScripts();
      });
      scriptsList.appendChild(item);
    });
  }

  // Update run select
  const prev = runScriptSelect.value;
  runScriptSelect.innerHTML = '<option value="">— select a script —</option>';
  list.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = s.name;
    runScriptSelect.appendChild(opt);
  });
  if (prev) {
    runScriptSelect.value = prev;
    runScriptSelect.dispatchEvent(new Event('change'));
  }
}

// ── Parameter rows ────────────────────────────────────────────────────────────
function buildParamRows() {
  paramList.innerHTML = '';
  paramCounter = 0;

  // Deduplicate fills by selector (keep first occurrence, last value)
  const lastFillValue = new Map();
  for (const a of currentActions) {
    if (a.type === 'fill') lastFillValue.set(a.selector, a.value);
  }

  const fills = [];
  const seen = new Set();
  for (const a of currentActions) {
    if (a.type === 'fill' && !seen.has(a.selector)) {
      seen.add(a.selector);
      fills.push({ ...a, value: lastFillValue.get(a.selector) });
    }
  }

  if (fills.length === 0) return;

  // Group fills that share the same value — these are likely the same logical field
  const valueGroups = new Map(); // value → [fill, fill, ...]
  for (const fill of fills) {
    const key = fill.value;
    if (!valueGroups.has(key)) valueGroups.set(key, []);
    valueGroups.get(key).push(fill);
  }

  for (const [value, group] of valueGroups) {
    if (group.length > 1) {
      // Multiple selectors share the same value → group row
      addGroupedParamRow(value, group);
    } else {
      addFillParamRow(group[0]);
    }
  }
}

/**
 * Render a group of fills that all share the same value.
 * The user can assign one parameter name for the entire group.
 */
function addGroupedParamRow(value, fills) {
  const id = ++paramCounter;
  const row = document.createElement('div');
  row.className = 'fill-param-row fill-param-group';
  // store all selectors as JSON so collectParams can read them
  row.dataset.selectors = JSON.stringify(fills.map(f => f.selector));
  row.dataset.value = value;
  row.dataset.sensitive = fills.some(f => f.sensitive) ? '1' : '';

  const displayValue = fills.some(f => f.sensitive) ? '••••••' : value;
  const suggestedName = sanitizeParamName(fills[0].selector);
  const selectorList = fills.map(f => { const s = escAttr(f.selector); return `<code title="${s}">${s}</code>`; }).join(', ');
  const isVariable = fills.some(f => f.sensitive);

  row.innerHTML = `
    <div class="fill-param-info fill-param-info--group">
      <span class="fill-group-badge">⚡ ${fills.length} fields, same value</span>
      <span class="fill-value">${escAttr(displayValue)}</span>
    </div>
    <div class="fill-selectors-list">${selectorList}</div>
    <div class="fill-param-controls">
      <label class="mode-toggle" title="Click to switch between hardcoded and variable">
        <input type="checkbox" class="param-toggle"${isVariable ? ' checked' : ''}>
        <span class="mode-state mode-hard">🔒 Hardcoded</span>
        <span class="mode-state mode-var">📝 Variable →</span>
      </label>
      <input type="text" class="param-name"
             placeholder="variable name (e.g. ${escAttr(suggestedName)})"
             value="${escAttr(suggestedName)}"
             style="display:${isVariable ? '' : 'none'}" />
    </div>
  `;

  _wireToggle(row, isVariable);
  paramList.appendChild(row);
}

function addFillParamRow(fill) {
  const id = ++paramCounter;
  const row = document.createElement('div');
  row.className = 'fill-param-row';
  row.dataset.selector = fill.selector;
  row.dataset.value = fill.value;
  row.dataset.sensitive = fill.sensitive ? '1' : '';

  const displayValue = fill.sensitive ? '••••••' : fill.value;
  const suggestedName = sanitizeParamName(fill.selector);
  const isVariable = fill.sensitive;

  row.innerHTML = `
    <div class="fill-param-info">
      <span class="fill-selector" title="${escAttr(fill.selector)}">${escAttr(fill.selector)}</span>
      <span class="fill-value">${escAttr(displayValue)}</span>
    </div>
    <div class="fill-param-controls">
      <label class="mode-toggle" title="Click to switch between hardcoded and variable">
        <input type="checkbox" class="param-toggle"${isVariable ? ' checked' : ''}>
        <span class="mode-state mode-hard">🔒 Hardcoded</span>
        <span class="mode-state mode-var">📝 Variable →</span>
      </label>
      <input type="text" class="param-name"
             placeholder="variable name (e.g. ${escAttr(suggestedName)})"
             value="${escAttr(suggestedName)}"
             style="display:${isVariable ? '' : 'none'}" />
    </div>
  `;

  _wireToggle(row, isVariable);
  paramList.appendChild(row);
}

/** Wire the hardcoded/variable toggle for a fill row. */
function _wireToggle(row, initialChecked) {
  const toggle = row.querySelector('.param-toggle');
  const nameInput = row.querySelector('.param-name');
  _applyToggleState(row, initialChecked);
  toggle.addEventListener('change', () => {
    _applyToggleState(row, toggle.checked);
    if (toggle.checked) nameInput.focus();
  });
}

function _applyToggleState(row, isVariable) {
  row.querySelector('.mode-hard').style.display = isVariable ? 'none' : '';
  row.querySelector('.mode-var').style.display  = isVariable ? '' : 'none';
  const nameInput = row.querySelector('.param-name');
  nameInput.style.display = isVariable ? '' : 'none';
  row.classList.toggle('mode-is-var', isVariable);

  // When variable mode is enabled we don't want the recorded value to show
  // in the list, since it won't be carried through to the saved script.
  const valSpan = row.querySelector('.fill-value');
  if (valSpan) {
    if (isVariable) {
      valSpan.textContent = '';
    } else {
      // restore the value or masked value
      const v = row.dataset.value;
      valSpan.textContent = row.dataset.sensitive ? '••••••' : v;
    }
  }
}

function addParamRow(defaultValue = '', selectorHint = '', sensitive = false) {
  const id = ++paramCounter;
  const row = document.createElement('div');
  row.className = 'param-row';
  row.dataset.id = id;
  row.innerHTML = `
    <input type="text" class="param-name" placeholder="paramName (e.g. username)"
           value="${sensitive ? sanitizeParamName(selectorHint) : ''}" />
    <input type="text" class="param-default" placeholder="default value"
           value="${escAttr(defaultValue)}" />
    <button type="button" class="btn btn-sm btn-danger" data-remove="${id}">✕</button>
  `;
  row.querySelector('[data-remove]').addEventListener('click', () => row.remove());
  paramList.appendChild(row);
}

function sanitizeParamName(selector) {
  return selector.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+/, '').substring(0, MAX_PARAM_NAME_LENGTH) || 'param';
}
function escAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function collectParams() {
  const params = [];

  // Grouped fill rows (multiple selectors share one value → one parameter)
  paramList.querySelectorAll('.fill-param-group').forEach(row => {
    const toggle = row.querySelector('.param-toggle');
    if (!toggle || !toggle.checked) return;
    const name = row.querySelector('.param-name').value.trim();
    const defaultValue = '';
    if (name) {
      const selectors = JSON.parse(row.dataset.selectors || '[]');
      params.push({ name, defaultValue, selectors });
    }
  });

  // Individual fill-param rows (auto-detected, unique value)
  paramList.querySelectorAll('.fill-param-row:not(.fill-param-group)').forEach(row => {
    const toggle = row.querySelector('.param-toggle');
    if (!toggle || !toggle.checked) return;
    const name = row.querySelector('.param-name').value.trim();
    const defaultValue = '';
    if (name) {
      const selector = row.dataset.selector;
      params.push({ name, defaultValue, selector });
    }
  });

  // Manual param rows (added via "+ Add Parameter manually")
  paramList.querySelectorAll('.param-row').forEach(row => {
    const name = row.querySelector('.param-name').value.trim();
    const defaultValue = row.querySelector('.param-default').value;
    if (name) params.push({ name, defaultValue });
  });

  return params;
}

// ── Socket events ─────────────────────────────────────────────────────────────

socket.on('connect', () => {
  appendLog(serverLog, '✓ Connected to server', 'log-success');
});

socket.on('disconnect', () => {
  appendLog(serverLog, '✗ Disconnected from server', 'log-error');
});

socket.on('stateUpdate', (data) => {
  setRecordingState(data.isRecording);
  actionCount.textContent = data.actionCount;
});

socket.on('log', (data) => {
  appendLog(serverLog, data.msg, 'log-server');
});

socket.on('runLog', (data) => {
  const cls = data.level === 'error' ? 'log-error' : data.level === 'success' ? 'log-success' : 'log-info';
  appendLog(runLog, data.msg, cls);
});

socket.on('actionRecorded', (action) => {
  currentActions.push(action);
  appendLog(actionLog, actionLabel(action), actionClass(action.type));
  actionCount.textContent = currentActions.length;
});

socket.on('recordingStarted', () => {
  currentActions = [];
  actionLog.innerHTML = '';
  btnWipe.disabled = true;
  appendLog(serverLog, '▶ Recording started', 'log-success');
});

socket.on('recordingStopped', (data) => {
  currentActions = data.actions || currentActions;
  appendLog(serverLog, `⏹ Recording stopped — ${data.actionCount} action(s)`, 'log-info');
  btnWipe.disabled = currentActions.length === 0;
  // Open save modal
  modalActionCount.textContent = data.actionCount + ' action(s)';
  scriptNameInput.value = '';
  buildParamRows();
  openModal(modalSave);
});

socket.on('scriptSaved', (data) => {
  appendLog(serverLog, `💾 Saved: ${data.file}`, 'log-success');
  closeModal(modalSave);
  currentActions = [];
  btnWipe.disabled = true;
  loadScripts();
});

socket.on('dataWiped', () => {
  currentActions = [];
  actionLog.innerHTML = '';
  actionCount.textContent = '0';
  btnWipe.disabled = true;
  appendLog(serverLog, '🗑 Unsaved data wiped.', 'log-info');
});

socket.on('error', (data) => {
  appendLog(serverLog, `⚠ ${data.msg}`, 'log-error');
});

// ── Button handlers ───────────────────────────────────────────────────────────

btnStart.addEventListener('click', () => {
  const url = startUrlInput.value.trim();
  socket.emit('startRecording', { url });
  // Open the VNC viewer in a new tab so the user can watch/interact with the browser
  window.open(vncUrl, '_blank', 'noopener');
});

btnStop.addEventListener('click', () => {
  socket.emit('stopRecording');
});

btnWipe.addEventListener('click', () => {
  if (!confirm('Wipe all unsaved recording data? This cannot be undone.')) return;
  socket.emit('wipeData');
});

btnOpenVnc.addEventListener('click', () => {
  window.open(vncUrl, '_blank', 'noopener');
});

btnRefresh.addEventListener('click', () => loadScripts());

runScriptSelect.addEventListener('change', async () => {
  const name = runScriptSelect.value;
  // clear previous values
  runParamsTA.value = '';
  loopParamsTA.value = '';
  if (!name) return;
  try {
    const res = await fetch(`/api/scripts/${encodeURIComponent(name)}`);
    if (!res.ok) return;
    const src = await res.text();
    // look for the params destructuring block inside run() to extract default values
    // anchor to `async function run` so we ignore other destructuring (e.g. imports)
    const re = /async function run[^\{]*\{[\s\S]*?const\s*{\s*([\s\S]*?)\s*}\s*=\s*params;/;
    const m = re.exec(src);
    if (m) {
      const obj = {};
      m[1].split(',').forEach(part => {
        const pieces = part.split('=').map(s=>s.trim());
        if (pieces[0]) {
          try {
            // eslint-disable-next-line no-eval
            obj[pieces[0]] = eval(pieces[1]);
          } catch {
            obj[pieces[0]] = '';
          }
        }
      });
      if (Object.keys(obj).length) runParamsTA.value = JSON.stringify(obj, null, 2);
    }
  } catch (err) {
    console.error('failed to load script for params', err);
  }
});

btnRun.addEventListener('click', async () => {
  const scriptName = runScriptSelect.value;
  if (!scriptName) { alert('Please select a script to run.'); return; }

  let params = {};
  let loopParams = null;

  const rawParams = runParamsTA.value.trim();
  const rawLoop   = loopParamsTA.value.trim();

  try {
    if (rawParams) params = JSON.parse(rawParams);
  } catch { alert('Params JSON is invalid.'); return; }

  try {
    if (rawLoop) loopParams = JSON.parse(rawLoop);
  } catch { alert('Loop Params JSON is invalid.'); return; }

  appendLog(runLog, `▶ Running: ${scriptName}`, 'log-info');

  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scriptName, params, loopParams }),
  });
  const body = await res.json();
  if (!body.ok) appendLog(runLog, `⚠ ${body.error}`, 'log-error');
});

btnViewScript.addEventListener('click', async () => {
  const scriptName = runScriptSelect.value;
  if (!scriptName) { alert('Please select a script first.'); return; }

  const res = await fetch(`/api/scripts/${encodeURIComponent(scriptName)}`);
  if (!res.ok) { alert('Could not load script.'); return; }
  const src = await res.text();
  scriptSourceCode.textContent = src;
  document.getElementById('modal-view-title').textContent = `🔍 ${scriptName}.js`;
  openModal(modalView);
});

btnSaveConfirm.addEventListener('click', () => {
  const name = scriptNameInput.value.trim();
  if (!name) { scriptNameInput.focus(); return; }
  const params = collectParams();
  socket.emit('saveScript', { name, params });
});

btnSaveCancel.addEventListener('click', () => closeModal(modalSave));
btnViewClose.addEventListener('click', () => closeModal(modalView));
btnAddParam.addEventListener('click', () => addParamRow());

// ── Chrome Recorder import ────────────────────────────────────────────────────

chromeImportFile.addEventListener('change', () => {
  const file = chromeImportFile.files[0];
  if (file) {
    chromeImportFilename.textContent = file.name;
    btnImportChrome.disabled = false;
  } else {
    chromeImportFilename.textContent = 'No file selected';
    btnImportChrome.disabled = true;
  }
});

btnImportChrome.addEventListener('click', async () => {
  const file = chromeImportFile.files[0];
  if (!file) return;

  let json;
  try {
    const text = await file.text();
    json = JSON.parse(text);
  } catch {
    alert('Could not parse JSON file. Make sure you exported it from Chrome DevTools Recorder.');
    return;
  }

  appendLog(serverLog, `📥 Importing: ${file.name}`, 'log-info');

  let data;
  try {
    const res = await fetch('/api/import-chrome', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(json),
    });
    data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Import failed');
  } catch (err) {
    appendLog(serverLog, `⚠ Import error: ${err.message}`, 'log-error');
    alert('Import failed: ' + err.message);
    return;
  }

  // Load imported actions and open the save modal for review
  currentActions = data.actions;
  actionLog.innerHTML = '';
  currentActions.forEach(a => appendLog(actionLog, actionLabel(a), actionClass(a.type)));
  actionCount.textContent = currentActions.length;
  btnWipe.disabled = currentActions.length === 0;

  appendLog(serverLog, `✓ Imported ${currentActions.length} action(s) from Chrome recording`, 'log-success');

  // Open save modal pre-filled with the recording title
  modalActionCount.textContent = currentActions.length + ' action(s) (imported)';
  scriptNameInput.value = data.title || '';
  buildParamRows();
  openModal(modalSave);

  // Reset file input
  chromeImportFile.value = '';
  chromeImportFilename.textContent = 'No file selected';
  btnImportChrome.disabled = true;
});

modalOverlay.addEventListener('click', () => {
  closeModal(modalSave);
  closeModal(modalView);
});

// Keyboard: Escape closes modals
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModal(modalSave);
    closeModal(modalView);
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
loadScripts();
