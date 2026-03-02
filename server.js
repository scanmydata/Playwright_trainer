'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { chromium } = require('playwright');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const { actionsToScript } = require('./recorder/actions-to-script');

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Rate limiting for API routes (protects file system access)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,             // 60 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api/', apiLimiter);

const SCRIPTS_DIR = path.join(__dirname, 'scripts');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

[SCRIPTS_DIR, DOWNLOADS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const MAX_SCRIPT_NAME_LENGTH = 80;
const FILL_DEBOUNCE_MS = 400;



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
    const files = fs.readdirSync(SCRIPTS_DIR)
      .filter(f => f.endsWith('.js') && f !== '.gitkeep')
      .map(f => {
        const stat = fs.statSync(path.join(SCRIPTS_DIR, f));
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
  const file = path.join(SCRIPTS_DIR, req.params.name + '.js');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  res.type('text/plain').send(fs.readFileSync(file, 'utf8'));
});

/** Delete a script */
app.delete('/api/scripts/:name', (req, res) => {
  const file = path.join(SCRIPTS_DIR, req.params.name + '.js');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(file);
  res.json({ ok: true });
});

/** Run a saved script (single or loop) */
app.post('/api/run', async (req, res) => {
  const { scriptName, params, loopParams } = req.body;
  if (!scriptName) return res.status(400).json({ error: 'scriptName required' });

  const file = path.join(SCRIPTS_DIR, scriptName + '.js');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Script not found' });

  res.json({ ok: true, message: 'Script execution started' });

  // Run async so we don't block the response
  (async () => {
    try {
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
    if ((tag === 'button' || tag === 'a') && el.textContent.trim())
      return 'text=' + JSON.stringify(el.textContent.trim().substring(0, 60));

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
    const selector = getBestSelector(interesting);
    const href = interesting.href || (interesting.closest('[href]') || {}).href || null;

    window.__recordAction({
      type: 'click',
      selector: selector,
      href: href,
      text: (interesting.textContent || '').trim().substring(0, 100),
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
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        slowMo: 50,
      });

      state.context = await state.browser.newContext({
        acceptDownloads: true,
        viewport: { width: 1920, height: 1080 },
      });

      // Expose binding so injected script can push actions to Node
      await state.context.exposeBinding('__recordAction', (_source, action) => {
        state.actions.push(action);
        io.emit('actionRecorded', action);
        io.emit('stateUpdate', { isRecording: true, actionCount: state.actions.length });
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
        state.actions.push({ type: 'goto', url: startUrl, ts: Date.now() });
        io.emit('actionRecorded', { type: 'goto', url: startUrl });
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
    const filePath = path.join(SCRIPTS_DIR, safeName + '.js');

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

    state.actions.push({ type: 'goto', url, ts: Date.now() });
    io.emit('actionRecorded', { type: 'goto', url });
    io.emit('stateUpdate', { isRecording: state.isRecording, actionCount: state.actions.length });
  });

  page.on('download', async (download) => {
    const filename = download.suggestedFilename();
    const dest = path.join(DOWNLOADS_DIR, filename);
    await download.saveAs(dest).catch(() => {});
    const action = { type: 'download', filename, dest, ts: Date.now() };
    state.actions.push(action);
    io.emit('actionRecorded', action);
    io.emit('log', { msg: `Download captured: ${filename}` });
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
