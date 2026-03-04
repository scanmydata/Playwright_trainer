'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { chromium } = require('playwright');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const { actionsToScript } = require('./recorder/actions-to-script');
const { chromeRecorderToActions } = require('./recorder/chrome-to-playwright');

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '2mb' }));

// Trust the forward proxy (Codespaces / noVNC) so rate-limit can
// use the X-Forwarded-For header without throwing an error.
app.set('trust proxy', true);

// Rate limiting for API routes (protects file system access)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,             // 60 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api/', apiLimiter);

const SYSTEM_SCRIPTS_DIR = path.join(__dirname, 'system-scripts');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

// user scripts directory (where saved recordings will live going forward)
const USER_SCRIPTS_DIR = path.join(__dirname, 'user-scripts');

// ensure directories exist
[USER_SCRIPTS_DIR, SYSTEM_SCRIPTS_DIR, DOWNLOADS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// migrate legacy scripts folder if present
const LEGACY_DIR = path.join(__dirname, 'scripts');
if (fs.existsSync(LEGACY_DIR)) {
  const legacyFiles = fs.readdirSync(LEGACY_DIR).filter(f => f.endsWith('.js'));
  for (const f of legacyFiles) {
    const src = path.join(LEGACY_DIR, f);
    const dst = path.join(USER_SCRIPTS_DIR, f);
    if (!fs.existsSync(dst)) fs.renameSync(src, dst);
  }
  try {
    const rem = fs.readdirSync(LEGACY_DIR);
    if (rem.length === 0) fs.rmdirSync(LEGACY_DIR, { recursive: true });
  } catch (_) {}
}

const MAX_SCRIPT_NAME_LENGTH = 80;
const FILL_DEBOUNCE_MS = 400;

function toSafeScriptName(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}



const state = {
  isRecording: false,
  browser: null,
  context: null,
  page: null,
  actions: [],
  sessionId: null,
};

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

/** List saved scripts */
app.get('/api/scripts', (_req, res) => {
  try {
    const files = fs.readdirSync(USER_SCRIPTS_DIR)
      .filter(f => f.endsWith('.js') && f !== '.gitkeep')
      .map(f => {
        const stat = fs.statSync(path.join(USER_SCRIPTS_DIR, f));
        return { name: f.replace(/\.js$/, ''), file: f, created: stat.mtime };
      })
      .sort((a, b) => b.created - a.created);
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Get source code of a script */
app.get('/api/scripts/:name', (req, res) => {
  const safeName = toSafeScriptName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Invalid script name' });
  const file = path.join(USER_SCRIPTS_DIR, safeName + '.js');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  res.type('text/plain').send(fs.readFileSync(file, 'utf8'));
});

/** Delete a script */
app.delete('/api/scripts/:name', (req, res) => {
  const safeName = toSafeScriptName(req.params.name);
  if (!safeName) return res.status(400).json({ error: 'Invalid script name' });
  const file = path.join(USER_SCRIPTS_DIR, safeName + '.js');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(file);
  res.json({ ok: true });
});

/** Run a saved script (single or loop) */
app.post('/api/run', async (req, res) => {
  const { scriptName, params, loopParams } = req.body;
  const safeName = toSafeScriptName(scriptName);
  if (!safeName) return res.status(400).json({ error: 'Valid scriptName required' });

  const file = path.join(USER_SCRIPTS_DIR, safeName + '.js');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Script not found' });

  res.json({ ok: true, message: 'Script execution started' });

  // helper: upgrade script before execution
  function patchScriptForParams(src, paramsObj) {
    let out = src;

    // 1. eliminate any click that is immediately followed by a goto to the
    //   same target – the goto alone is enough and avoids timing issues.
    out = out.replace(/await page\.click\((['"`][^\)]+['"`])\);\s*await page\.goto\((['\"])(.*?)\2/g,
      `await page.goto($2$3$2`);
    // 2. after removal we can still rewrite remaining bare "a" clicks to use
    //    the href of the next goto if it exists
    out = out.replace(/await page\.click\("a"\);/g, (m, offset) => {
      const rest = out.slice(offset + m.length);
      const m2 = /await page\.goto\((['"])(.*?)\1/.exec(rest);
      if (m2) {
        const url = m2[2];
        return `await page.click('a[href="${url}"]');`;
      }
      return m;
    });

    // 2. drop known flaky clicks (e.g. close buttons) that often disappear headlessly
    // remove any click whose selector contains the Greek word Κλείσιμο ("Close")
    // handles both plain and escaped quotes inside the string
    out = out.replace(/await page\.click\([^)]*text=\\?"Κλείσιμο"\\?[^)]*\);/g, '// removed flaky close-click');

    // 3. determine which parameter names to replace
    let names = [];
    if (paramsObj && Object.keys(paramsObj).length) {
      names = Object.keys(paramsObj);
    } else {
      // parse the destructuring inside the run() function only
      const m = /async function run[^\{]*\{[\s\S]*?const\s*{\s*([\s\S]*?)\s*}\s*=\s*params;/.exec(src);
      if (m) {
        names = m[1]
          .split(',')
          .map(s => s.split('=')[0].trim())
          .filter(Boolean);
      }
    }

    // 3. replace literal values with parameter variables
    for (const name of names) {
      const esc = name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
      const quotes = "['\\\"\\`]";
      const fillRe = new RegExp(`(page\\.fill\\([^,]*${esc}[^,]*,\\s*)${quotes}.*?${quotes}`, 'g');
      out = out.replace(fillRe, `$1${name}`);
      const selectRe = new RegExp(`(page\\.selectOption\\([^,]*${esc}[^,]*,\\s*)${quotes}.*?${quotes}`, 'g');
      out = out.replace(selectRe, `$1${name}`);
    }

    return out;
  }

  // Run async so we don't block the response
  (async () => {
    try {
      // always attempt to patch the script; paramsObj may be empty but
      // we'll still infer parameter names from the source itself
      {
        let src = fs.readFileSync(file, 'utf8');
        const newSrc = patchScriptForParams(src, params || {});
        if (newSrc !== src) {
          fs.writeFileSync(file, newSrc, 'utf8');
          io.emit('runLog', { level: 'info', msg: '[run] Script upgraded to use parameter variables or improved selectors' });
        }
      }

      // Flush require cache so edits are picked up
      delete require.cache[require.resolve(file)];
      const script = require(file);

      if (loopParams && Array.isArray(loopParams) && loopParams.length > 0) {
        io.emit('runLog', { level: 'info', msg: `[run] Starting loop with ${loopParams.length} iterations` });
        await script.runLoop(loopParams);
      } else {
        io.emit('runLog', { level: 'info', msg: '[run] Starting single run' });
        await script.run(params || {});
      }
      io.emit('runLog', { level: 'success', msg: '[run] Completed successfully' });
    } catch (err) {
      io.emit('runLog', { level: 'error', msg: `[run] Error: ${err.message}` });
    }
  })();
});

/**
 * Return the VNC viewer URL.
 * In GitHub Codespaces, environment variables give the exact forwarded URL.
 * Otherwise the client computes it from window.location.
 */
app.get('/api/vnc-url', (_req, res) => {
  const codespaceName = process.env.CODESPACE_NAME;
  const fwdDomain = process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
  if (codespaceName && fwdDomain) {
    const query = new URLSearchParams({
      autoconnect: '1',
      resize: 'scale',
      path: 'websockify',
      encrypt: '1',
    });
    return res.json({
      url: `https://${codespaceName}-6080.${fwdDomain}/vnc.html?${query.toString()}`,
    });
  }
  res.json({ url: null }); // client will derive it from window.location
});

/** Import Chrome DevTools Recorder JSON → return converted actions for preview */
app.post('/api/import-chrome', (req, res) => {
  try {
    const recording = req.body;
    const actions = chromeRecorderToActions(recording);
    const title = (recording.title || 'imported_recording')
      .replace(/[^a-z0-9_\-]/gi, '_')
      .substring(0, MAX_SCRIPT_NAME_LENGTH);
    res.json({ ok: true, actions, title });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Recorder injection script (runs inside the browser page)
// ---------------------------------------------------------------------------

function buildRecorderInitScript() {
  // Stringified so it can be passed to addInitScript
  return `(function () {
  'use strict';

  if (window.__playwrightTrainerInjected) return;
  window.__playwrightTrainerInjected = true;

  const fillTimers = {};

  /* ---- Selector generation ---- */
  function getBestSelector(el) {
    if (!el || el === document.body) return 'body';

    if (el.getAttribute('data-testid'))
      return '[data-testid="' + el.getAttribute('data-testid') + '"]';

    if (el.id && /^[a-zA-Z]/.test(el.id))
      return '#' + el.id;

    if (el.getAttribute('aria-label'))
      return '[aria-label="' + el.getAttribute('aria-label') + '"]';

    if (el.getAttribute('placeholder'))
      return '[placeholder="' + el.getAttribute('placeholder') + '"]';

    if (el.getAttribute('name'))
      return '[name="' + el.getAttribute('name') + '"]';

    const tag = el.tagName.toLowerCase();
    // prefer text for buttons/links when available
    if ((tag === 'button' || tag === 'a') && el.textContent.trim())
      return 'text=' + JSON.stringify(el.textContent.trim().substring(0, 60));
    // if it's a bare anchor without text, use href attribute to avoid generic "a" selector
    if (tag === 'a' && el.getAttribute('href')) {
      return 'a[href="' + el.getAttribute('href') + '"]';
    }

    if (tag === 'input' && el.type)
      return 'input[type="' + el.type + '"]';

    const cls = Array.from(el.classList).slice(0, 2).join('.');
    return tag + (cls ? '.' + cls : '');
  }

  /* ---- Click ---- */
  document.addEventListener('click', function (e) {
    const target = e.target;
    const interesting = target.closest(
      'a, button, [role="button"], input[type="submit"], input[type="button"], label'
    ) || target;

    // ignore obvious "close" buttons/popups; text may vary by language
    const txt = (interesting.textContent || '').trim();
    if (txt === 'Κλείσιμο' || txt.toLowerCase() === 'close') {
      return; // don't record this click
    }

    const selector = getBestSelector(interesting);
    const href = interesting.href || (interesting.closest('[href]') || {}).href || null;

    window.__recordAction({
      type: 'click',
      selector: selector,
      href: href,
      text: txt.substring(0, 100),
      ts: Date.now(),
    });
  }, true);

  /* ---- Fill (text inputs, textarea) ---- */
  document.addEventListener('input', function (e) {
    const el = e.target;
    if (!el || !['INPUT', 'TEXTAREA'].includes(el.tagName)) return;
    if (['submit', 'button', 'checkbox', 'radio', 'file'].includes(el.type)) return;

    const selector = getBestSelector(el);
    clearTimeout(fillTimers[selector]);
    fillTimers[selector] = setTimeout(function () {
      window.__recordAction({
        type: 'fill',
        selector: selector,
        value: el.value,
        sensitive: (el.type === 'password'),
        ts: Date.now(),
      });
      delete fillTimers[selector];
    }, ${FILL_DEBOUNCE_MS});
  }, true);

  /* ---- Select ---- */
  document.addEventListener('change', function (e) {
    const el = e.target;
    if (el.tagName === 'SELECT') {
      window.__recordAction({
        type: 'selectOption',
        selector: getBestSelector(el),
        value: el.value,
        label: el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : el.value,
        ts: Date.now(),
      });
    } else if (el.type === 'checkbox') {
      window.__recordAction({
        type: 'check',
        selector: getBestSelector(el),
        checked: el.checked,
        ts: Date.now(),
      });
    }
  }, true);
})();`;
}

// ---------------------------------------------------------------------------
// Socket.io – recording control
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  console.log('[ws] client connected:', socket.id);

  // Send current state to newly connected client
  socket.emit('stateUpdate', {
    isRecording: state.isRecording,
    actionCount: state.actions.length,
  });

  /* ---- Start Recording ---- */
  socket.on('startRecording', async (data) => {
    if (state.isRecording) {
      socket.emit('error', { msg: 'Already recording. Stop the current session first.' });
      return;
    }

    const startUrl = (data && data.url) ? data.url.trim() : 'about:blank';
    state.actions = [];
    state.sessionId = Date.now().toString();
    state.isRecording = true;

    io.emit('stateUpdate', { isRecording: true, actionCount: 0 });
    io.emit('log', { msg: `Recording started → ${startUrl}` });

    try {
      // Detect if running headless (CI / no DISPLAY)
      const headless = !process.env.DISPLAY;

      state.browser = await chromium.launch({
        headless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check',
        ],
        slowMo: 50,
      });

      state.context = await state.browser.newContext({
        acceptDownloads: true,
        viewport: { width: 1920, height: 1080 },
        ignoreHTTPSErrors: true,
        bypassCSP: true,
      });

      // Expose binding so injected script can push actions to Node
      await state.context.exposeBinding('__recordAction', (_source, action) => {
        recordAction(action);
      });

      // Inject recorder into every page / frame
      await state.context.addInitScript(buildRecorderInitScript());

      // Track navigations (frame level)
      state.context.on('page', (newPage) => {
        attachPageListeners(newPage);
        io.emit('log', { msg: `New tab opened: ${newPage.url()}` });
      });

      state.page = await state.context.newPage();
      attachPageListeners(state.page);

      if (startUrl && startUrl !== 'about:blank') {
        await state.page.goto(startUrl, { waitUntil: 'domcontentloaded' });
        recordAction({ type: 'goto', url: startUrl, ts: Date.now() });
      }

      socket.emit('recordingStarted', { sessionId: state.sessionId });
    } catch (err) {
      state.isRecording = false;
      console.error('[recorder]', err);
      socket.emit('error', { msg: 'Failed to launch browser: ' + err.message });
      io.emit('stateUpdate', { isRecording: false, actionCount: 0 });
      await cleanupBrowser();
    }
  });

  /* ---- Stop Recording ---- */
  socket.on('stopRecording', async () => {
    if (!state.isRecording) {
      socket.emit('error', { msg: 'Not currently recording.' });
      return;
    }

    state.isRecording = false;
    const captured = [...state.actions];

    await cleanupBrowser();

    io.emit('stateUpdate', { isRecording: false, actionCount: captured.length });
    io.emit('log', { msg: `Recording stopped. ${captured.length} actions captured.` });
    socket.emit('recordingStopped', { actions: captured, actionCount: captured.length });
  });

  /* ---- Save Script ---- */
  socket.on('saveScript', (data) => {
    const { name, params } = data;
    if (!name) {
      socket.emit('error', { msg: 'Script name is required.' });
      return;
    }

    const safeName = name.replace(/[^a-z0-9_\-]/gi, '_').substring(0, MAX_SCRIPT_NAME_LENGTH);
    const scriptSrc = actionsToScript(state.actions, { name, params: params || [] });
    const filePath = path.join(USER_SCRIPTS_DIR, safeName + '.js');

    try {
      fs.writeFileSync(filePath, scriptSrc, 'utf8');
      socket.emit('scriptSaved', { name: safeName, file: safeName + '.js' });
      io.emit('log', { msg: `Script saved: ${safeName}.js` });
    } catch (err) {
      socket.emit('error', { msg: 'Failed to save script: ' + err.message });
    }
  });

  /* ---- Wipe unsaved data ---- */
  socket.on('wipeData', () => {
    if (state.isRecording) {
      socket.emit('error', { msg: 'Cannot wipe data while recording. Stop the recording first.' });
      return;
    }
    state.actions = [];
    io.emit('stateUpdate', { isRecording: false, actionCount: 0 });
    socket.emit('dataWiped');
    io.emit('log', { msg: 'Unsaved recording data wiped.' });
  });

  socket.on('disconnect', () => {
    console.log('[ws] client disconnected:', socket.id);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function attachPageListeners(page) {
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (!url || url === 'about:blank') return;

    recordAction({ type: 'goto', url, ts: Date.now() });
  });

  page.on('download', async (download) => {
    const filename = download.suggestedFilename();
    const dest = path.join(DOWNLOADS_DIR, filename);
    await download.saveAs(dest).catch(() => {});
    const action = { type: 'download', filename, dest, ts: Date.now() };
    recordAction(action);
    io.emit('log', { msg: `Download captured: ${filename}` });
  });
}

function recordAction(action) {
  const normalized = {
    ...action,
    ts: typeof action?.ts === 'number' ? action.ts : Date.now(),
  };

  const prev = state.actions.length ? state.actions[state.actions.length - 1] : null;
  state.actions.push(normalized);

  const step = state.actions.length;
  const prevTs = prev && typeof prev.ts === 'number' ? prev.ts : null;
  const paceMs = prevTs !== null ? Math.max(0, normalized.ts - prevTs) : 0;
  const details = normalized.selector || normalized.url || normalized.filename || '';
  const compactDetails = String(details).replace(/\s+/g, ' ').trim().slice(0, 80);

  io.emit('actionRecorded', normalized);
  io.emit('stateUpdate', { isRecording: state.isRecording, actionCount: state.actions.length });
  io.emit('log', {
    msg: `[recorder] step ${step} | pace ${paceMs}ms | ${normalized.type}${compactDetails ? ` | ${compactDetails}` : ''}`,
  });
}

async function cleanupBrowser() {
  try {
    if (state.browser) {
      await state.browser.close();
    }
  } catch (_) {
    // ignore
  }
  state.browser = null;
  state.context = null;
  state.page = null;
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  🎭 Playwright Trainer running at http://localhost:${PORT}\n`);
  if (process.env.DISPLAY) {
    console.log(`  🖥️  Browser display: ${process.env.DISPLAY}`);
    console.log(`  🔍 Browser view (noVNC): http://localhost:6080\n`);
  } else {
    console.log('  ℹ️  No DISPLAY found — browser will run headless.\n');
    console.log('  To enable headed mode in Codespaces the startup.sh will configure Xvfb.\n');
  }
});
