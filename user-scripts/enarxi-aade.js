'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

/**
 * Script : enarxi-aade
 * Recorded: 2026-03-03
 * @param {string} params.username - username
 * @param {string} params.password - password
 */

async function run(params = {}) {
  const debug = process.env.DEBUG === '1';
  if (debug) console.log('[run] debug enabled');

  const {
    username = "",
    password = "",
  } = params;

  const result = {
    noOblig: false,
    downloaded: false,
    downloadPath: null,
    invalidCreds: false,
    error: null,
  };

  // allow optional pacing when running too fast against the site
  const pace = process.env.PACE ? parseInt(process.env.PACE, 10) : 0;
  let browser;
  
  try {
    browser = await chromium.launch({ headless: process.env.PW_HEADLESS === '1', slowMo: pace });
  const context = await browser.newContext({
    acceptDownloads: true,
    // ensure any browser-initiated downloads end up under our workspace
    downloadsPath: path.join(__dirname, '..', 'downloads'),
  });

  // log any download events for debugging
  if (debug) {
    context.on('download', async dl => {
      const p = await dl.path().catch(() => null);
      console.log('[download-event] received', dl.suggestedFilename(), 'path', p);
    });
  }
  const page = await context.newPage();

  async function dumpDiagnostics(tag) {
    try {
      const stamp = Date.now();
      const baseDir = path.join(__dirname, '..', 'downloads', 'debug');
      fs.mkdirSync(baseDir, { recursive: true });
      const safeTag = String(tag || 'diag').replace(/[^a-z0-9_-]/gi, '_');
      const pngPath = path.join(baseDir, `${safeTag}-${stamp}.png`);
      const htmlPath = path.join(baseDir, `${safeTag}-${stamp}.html`);
      await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
      const html = await page.content().catch(() => '');
      if (html) fs.writeFileSync(htmlPath, html);
      if (debug) console.log('[diag] saved', pngPath, htmlPath, 'url', page.url());
    } catch (e) {
      if (debug) console.warn('[diag] failed to save diagnostics', e.message);
    }
  }

  async function clickVisible(p, selector, label = selector, timeout = 8000) {
    const loc = p.locator(`${selector}:visible`).first();
    if (!(await loc.count())) return false;
    await loc.click({ timeout }).catch(() => null);
    if (debug) console.log('[clickVisible]', label, 'clicked');
    return true;
  }

  async function selectIfPresent(p, selectSelector, value) {
    const sel = p.locator(selectSelector).first();
    if (!(await sel.count())) return false;
    const hasValue = await sel.locator(`option[value="${value}"]`).count();
    if (!hasValue) return false;
    await sel.selectOption(value).catch(() => null);
    await p.waitForTimeout(300);
    if (debug) console.log('[selectIfPresent] selected', value);
    return true;
  }

  try {
      const loginUrl = "https://login.gsis.gr/mylogin/login.jsp?bmctx=1DB55AB50C08F2B418903DE4EB7466AD47038BC455E39B9EA82B1EB28CE52BC6&contextType=external&username=string&password=secure_string&challenge_url=https%3A%2F%2Flogin.gsis.gr%2Fmylogin%2Flogin.jsp&ssoCookie=disablehttponly&request_id=-3171065650028371185&authn_try_count=0&locale=en_US&resource_url=https%253A%252F%252Fwww1.aade.gr%252Fsaadeapps3%252Fcomregistry";
      if (debug) console.log('[run] using start2 direct GSIS login flow');
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      console.error('[run] initial service navigation failed', e.message);
      await dumpDiagnostics('initial_navigation_failed');
      result.error = 'initial navigation failed';
      return result;
    }
    await page.fill("#username", username);
    await page.fill("#password", password);
    await page.click("[name=\"btn_login\"]");

    // give the site a little breathing room; headless runs often go too fast
    await page.waitForTimeout(5000);
    // login can land on intermediate pages before app shell is ready
    const redirectHit = await page.waitForURL('**/saadeapps3/comregistry/**', { timeout: 60000 }).catch(() => null);
    const urlLooksLoggedIn = /saadeapps3\/comregistry/i.test(page.url());
    const appShellReady = await page.locator('#myselect1, div.custom-panel-title-small, text="Έκδοση"')
      .first()
      .waitFor({ state: 'visible', timeout: 30000 })
      .then(() => true)
      .catch(() => false);
    if (!redirectHit && !urlLooksLoggedIn && !appShellReady) {
      if (debug) console.log('[run] login did not redirect, assuming invalid credentials');
      result.invalidCreds = true;
      await dumpDiagnostics('login_failed');
      return result;
    }

    // navigate through the registry sections using the updated flow
    await page.goto("https://www1.aade.gr/saadeapps3/comregistry/#!/arxiki", { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await clickVisible(page, 'div.custom-panel-title-small', 'arxiki panel');

    await page.goto("https://www1.aade.gr/saadeapps3/comregistry/#!/vevaiwseismhtrwou", { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await clickVisible(page, 'div.custom-panel-title-small', 'vevaiwseismhtrwou panel');

    await page.goto("https://www1.aade.gr/saadeapps3/comregistry/#!/mhtrwoepixeirhshs", { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);

    try {
      // robust option sequence: only select values that exist, no generic "option" clicks
      const values = [
        'flagsxeseis',
        'flagsysxetizomenoiafm',
        'flagsxeseis',
        'flagsymmetoxesnomikaproswpa',
        'flagsxeseis',
        'flagdrastepix',
        'flagsxeseis',
        'flagsymmetoxesnomikaproswpa',
        'flagdrastepix',
        'flagegkeswt',
        'flagegkatastaseisexwterikoy',
        'flagsxeseis',
        'flagedraallodaphs',
        'flagsxeseis',
        'flagintraremotesalestbe',
        'flagsxeseis',
      ];
      for (const val of values) {
        await selectIfPresent(page, '#myselect1', val);
      }
    } catch (e) {
      if (debug) console.warn('[run] selection sequence failed', e.message);
    }

    const popupPromise = page.waitForEvent('popup', { timeout: 6000 }).catch(() => null);
    await page.click('text="Έκδοση"');
    let popupPage;
    let downloadPage;
    popupPage = await popupPromise;
    downloadPage = popupPage || page;
    
    if (popupPage) {
      await popupPage.waitForLoadState('domcontentloaded').catch(() => {});
      if (debug) console.log('[run] popup opened for download, URL:', popupPage.url());

      // set up download listener immediately - might be auto-triggered
      const downloadPromise = popupPage.waitForEvent('download', { timeout: 30000 }).catch(() => null);
      
      // if popup opened with blob:, it's the Chrome PDF viewer extension
      if (/^blob:/.test(popupPage.url())) {
        if (debug) console.log('[run] popup is blob PDF viewer (chrome extension)');
        
        // try keyboard shortcut Ctrl+S to save/download
        if (debug) console.log('[run] trying Ctrl+S to trigger download...');
        const [dlFromHotkey] = await Promise.all([
          popupPage.waitForEvent('download', { timeout: 15000 }).catch(() => null),
          popupPage.keyboard.press('Control+S').catch(e => {
            if (debug) console.log('[run] Ctrl+S error:', e.message);
          })
        ]);
        if (dlFromHotkey) {
          const filePath = path.join(__dirname, '..', 'downloads', `ektiposi-${Date.now()}.pdf`);
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          await dlFromHotkey.saveAs(filePath);
          console.log('[download] saved via Ctrl+S hotkey to', filePath);
          result.downloaded = true;
          result.downloadPath = filePath;
        } else if (debug) {
          console.log('[run] Ctrl+S did not trigger download, trying wait for auto event...');
        }
        
        // fallback: wait longer for any download that might trigger
        if (!result.downloaded) {
          await popupPage.waitForTimeout(8000);
          let dl = await downloadPromise.catch(() => null);
          if (dl) {
            const filePath = path.join(__dirname, '..', 'downloads', `ektiposi-${Date.now()}.pdf`);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            await dl.saveAs(filePath);
            console.log('[download] saved via delayed event to', filePath);
            result.downloaded = true;
            result.downloadPath = filePath;
          }
        }
      }
    }
    await downloadPage.waitForTimeout(2000);

    // if we haven't downloaded yet via popup, try the old methods
    if (!result.downloaded) {
      // diagnostic: dump what's visible now on the download page
      if (debug) {
        const visibleLinks = await downloadPage.$$eval('a:visible, button:visible', els =>
          els.slice(0, 20).map(e => ({ tag: e.tagName, text: e.innerText?.substring(0, 40), id: e.id, href: e.href }))
        ).catch(() => []);
        console.log('[run] visible links/buttons after Έκδοση:', visibleLinks);
      }

      // wait explicitly for #icon to appear (Chrome PDF viewer) in the popup
      const iconVisible = await downloadPage.locator('#icon:visible').first().waitFor({ state: 'visible', timeout: 12000 }).then(() => true).catch(() => false);
      if (debug && iconVisible) console.log('[run] #icon is visible in popup');

      // try #icon download if found
      if (iconVisible) {
        const iconLoc = downloadPage.locator('#icon:visible').first();
        const [dl] = await Promise.all([
          downloadPage.waitForEvent('download', { timeout: 15000 }).catch(() => null),
          iconLoc.click().catch(() => {}),
        ]);
        if (dl) {
          const filePath = path.join(__dirname, '..', 'downloads', `ektiposi-${Date.now()}.pdf`);
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          await dl.saveAs(filePath);
          console.log('[download] saved via #icon fallback to', filePath);
          result.downloaded = true;
          result.downloadPath = filePath;
        }
      }
      // fallback: click generic download button/attribute in the same page
      if (!result.downloaded) {
        const [dl2] = await Promise.all([
          downloadPage.waitForEvent('download', { timeout: 8000 }).catch(() => null),
          clickVisible(downloadPage, '[download], button[download], a:has-text("Download"), a:has-text("Λήψη")', 'generic download', 5000),
        ]);
        if (dl2) {
          const filePath = path.join(__dirname, '..', 'downloads', `ektiposi-${Date.now()}.pdf`);
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          await dl2.saveAs(filePath);
          console.log('[download] saved via generic button to', filePath);
          result.downloaded = true;
          result.downloadPath = filePath;
        }
      }
    }

    // helper for robust download
    async function tryDownload(p) {
      const filename = `ektiposi-${Date.now()}.pdf`;
      const dlPath = path.join(__dirname, '..', 'downloads', filename);
      fs.mkdirSync(path.dirname(dlPath), { recursive: true });
      let saved = false;

      const pdfRespPromise = p.waitForResponse(
        r => (r.headers()['content-type'] || '').toLowerCase().includes('application/pdf')
              || /\.pdf([?#].*)?$/i.test(r.url()),
        { timeout: 10000 }
      ).catch(() => null);

      // try explicit viewer icon first (Chrome PDF viewer)
      const iconBtn = p.locator('#icon:visible, cr-icon:visible').first();
      if (await iconBtn.count()) {
        const [dl] = await Promise.all([
          p.waitForEvent('download', { timeout: 10000 }).catch(() => null),
          iconBtn.click().catch(() => {}),
        ]);
        if (dl) {
          await dl.saveAs(dlPath);
          saved = true;
        }
      }

      // generic download link/button
      if (!saved) {
        const dlBtn = p.locator('a[download], button[download], a:has-text("Λήψη"), a:has-text("Download"), button:has-text("Download")').first();
        if (await dlBtn.count()) {
          const [dl] = await Promise.all([
            p.waitForEvent('download', { timeout: 5000 }).catch(() => null),
            dlBtn.click().catch(() => {}),
          ]);
          if (dl) {
            await dl.saveAs(dlPath);
            saved = true;
          }
        }
      }

      // network response
      if (!saved) {
        const resp = await pdfRespPromise;
        if (resp) {
          const buf = await resp.body().catch(() => null);
          if (buf && buf.length) {
            fs.writeFileSync(dlPath, buf);
            saved = true;
          }
        }
      }

      // direct url
      if (!saved) {
        const cur = p.url();
        if (/\.pdf([?#].*)?$/i.test(cur)) {
          const res = await context.request.get(cur).catch(() => null);
          if (res && res.ok()) {
            const buf = await res.body().catch(() => null);
            if (buf && buf.length) {
              fs.writeFileSync(dlPath, buf);
              saved = true;
            }
          }
        }
      }

      return saved ? dlPath : null;
    }

    // attempt two downloads sequentially to mimic original flow if we haven't
    // already obtained something via the manual blob/download clicks above.
    // IMPORTANT: use downloadPage (not page) since Έκδοση may have opened popup
    if (!result.downloaded) {
      if (debug) console.log('[run] about to try downloads, downloadPage type:', typeof downloadPage, 'downloadPage:', downloadPage ? 'exists' : 'null');
      const firstPath = await tryDownload(downloadPage);
      if (firstPath) {
        console.log('[download] saved to', firstPath);
        result.downloaded = true;
        result.downloadPath = firstPath;
      } else {
        result.noOblig = true;
        if (debug) console.log('[run] first download failed');
      }
    }
    if (!result.downloaded) {
      const secondPath = await tryDownload(downloadPage);
      if (secondPath) {
        console.log('[download] saved to', secondPath);
        result.downloaded = true;
        result.downloadPath = secondPath;
      }
    }
    await page.click("text=\"ΔΟΥΡΑΜΑΝΗΣ  ΓΕΩΡΓΙΟΣ\"");
    await page.goto("https://login.gsis.gr/oam/server/logout?end_url=https://www1.aade.gr:443/saadeapps3/comregistry", { waitUntil: 'domcontentloaded' });
    await page.goto("https://login.gsis.gr/mylogin/login.jsp?bmctx=1DB55AB50C08F2B418903DE4EB7466AD47038BC455E39B9EA82B1EB28CE52BC6&contextType=external&username=string&password=secure_string&challenge_url=https%3A%2F%2Flogin.gsis.gr%2Fmylogin%2Flogin.jsp&ssoCookie=disablehttponly&request_id=-1001328674732579891&authn_try_count=0&locale=en_US&resource_url=https%253A%252F%252Fwww1.aade.gr%252Fsaadeapps3%252Fcomregistry", { waitUntil: 'domcontentloaded' });
    return result;
  } catch (e) {
    console.error('[run] error:', e);
    result.error = e.message;
    return result;
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Run the script for every set of params in paramsArray (loop mode).
 * @param {Array} paramsArray - array of parameter objects, e.g. [{ foo:'bar' }, { foo:'baz' }]
 */
async function runLoop(paramsArray = []) {
  const results = [];
  for (const p of paramsArray) {
    console.log('[loop] running with params:', JSON.stringify(p));
    try {
      const res = await run(p);
      results.push({ params: p, result: res, ok: true });
    } catch (e) {
      results.push({ params: p, result: { error: e.message || String(e) }, ok: false });
    }
  }
  return results;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--loop' && args[1]) {
    // Usage: node script.js --loop '<json array>'
    runLoop(JSON.parse(args[1]))
      .then(r => { console.log('[loop] results', JSON.stringify(r)); process.exit(0); })
      .catch(e => { console.error(e); process.exit(1); });
  } else if (args[0] === '--params' && args[1]) {
    // Usage: node script.js --params '{"username":"alice"}'
    run(JSON.parse(args[1]))
      .then(res => { console.log('[run] result', JSON.stringify(res)); process.exit(0); })
      .catch(e => { console.error(e); process.exit(1); });
  } else {
    run()
      .then(res => { console.log('[run] result', JSON.stringify(res)); process.exit(0); })
      .catch(e => { console.error(e); process.exit(1); });
  }
}

module.exports = { run, runLoop };
