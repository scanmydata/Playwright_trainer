'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

/**
 * Script : test3
 * Recorded: 2026-03-04
 * @param {string} params.username - username
 * @param {string} params.password - password
 */

async function run(params = {}) {
  const debug = process.env.DEBUG === '1';
  const pace = process.env.PACE ? parseInt(process.env.PACE, 10) : 0;

  const slowMo = process.env.SLOW_MO !== undefined
    ? parseInt(process.env.SLOW_MO, 10) || 0
    : pace || 600;
  if (debug) console.log('[run] slowMo set to', slowMo);

  const downloadsDir = path.resolve(__dirname, 'downloads');

  async function safeClick(selector, options = {}) {
    await page.waitForSelector(selector, { state: 'visible', timeout: 15000 });
    const el = page.locator(selector);
    if (!(await el.count())) throw new Error(`safeClick: selector not found: ${selector}`);
    await el.click(options);
    await page.waitForTimeout(slowMo);
  }
  async function safeFill(selector, value, options = {}) {
    const el = page.locator(selector);
    if (!(await el.count())) throw new Error(`safeFill: selector not found: ${selector}`);
    await el.fill(value, options);
    await page.waitForTimeout(slowMo);
  }

  const {
    username = "",
    password = "",
    periodType = "oneMonth",
    month = "",
    quarter = "",
  } = params;

  const result = {
    noOblig: false,
    downloaded: false,
    downloadPath: null,
    invalidCreds: false,
    systemError: false,
    noBusiness: false,
    isIndividual: false,
    error: null,
  };

  let browser;
  let page;
  try {
    browser = await chromium.launch({ headless: process.env.PW_HEADLESS !== '0', slowMo });
    const context = await browser.newContext({ acceptDownloads: true, downloadsPath: downloadsDir });
    // log download events for visibility
    context.on('download', dl => {
      console.log('[event] download event fired, suggested filename', dl.suggestedFilename());
    });
    // capture the first PDF response at network level (sometimes the file is
    // fetched before we ever see a download event)
    let pdfResponseSaved = false;
    context.on('response', async r => {
      if (pdfResponseSaved) return;
      const ct = (r.headers()['content-type'] || '').toLowerCase();
      if (ct.includes('application/pdf')) {
        try {
          const buf = await r.body();
          const isRealPdf = !!(buf && buf.length > 5 && buf.slice(0, 5).toString() === '%PDF-');
          if (isRealPdf) {
            // try to derive filename
            let fname = null;
            const cd = r.headers()['content-disposition'] || '';
            const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]*)/i);
            if (m) fname = decodeURIComponent(m[1]);
            if (!fname) {
              // fallback to last segment of URL
              try {
                const u = new URL(r.url());
                fname = path.basename(u.pathname) || null;
              } catch {};
            }
            if (!fname) fname = `early-${Date.now()}.pdf`;
            if (!/\.pdf$/i.test(fname)) fname = `${fname}.pdf`;
            const filePath = path.join(downloadsDir, fname);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, buf);
            console.log('[auto-response] saved pdf from network', filePath);
            result.downloaded = true;
            result.downloadPath = filePath;
            pdfResponseSaved = true;
          } else if (debug) {
            console.log('[auto-response] ignored non-pdf body despite pdf content-type from', r.url());
          }
        } catch (e) {
          if (debug) console.log('[auto-response] error reading pdf', e);
        }
      }
    });
    // intercept blob creation to capture original PDF data
    await context.addInitScript(() => {
      const origCreate = URL.createObjectURL;
      URL.createObjectURL = function(blob) {
        try { window._lastBlobForTrainer = blob; } catch (_) {}
        return origCreate.call(this, blob);
      };
      // also wrap Blob constructor to keep the last blob
      const OrigBlob = Blob;
      window.Blob = function(parts, options) {
        const b = new OrigBlob(parts, options);
        try { window._lastBlobForTrainer = b; } catch (_) {}
        return b;
      };
      window.Blob.prototype = OrigBlob.prototype;
      // preserve static properties like Blob.prototype
      Object.defineProperty(window.Blob, 'prototype', { value: OrigBlob.prototype });
    });
    page = await context.newPage();

    async function step(fn) {
      const r = await fn();
      await page.waitForTimeout(1000);
      return r;
    }
    async function dumpDiagnostics(tag) {
      const stamp = Date.now();
      const baseDir = path.join(downloadsDir, 'debug');
      fs.mkdirSync(baseDir, { recursive: true });
      const pngPath = path.join(baseDir, `${tag}-${stamp}.png`);
      const htmlPath = path.join(baseDir, `${tag}-${stamp}.html`);
      await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
      const html = await page.content().catch(() => '');
      if (html) fs.writeFileSync(htmlPath, html);
      if (debug) console.log('[diag] saved', pngPath, htmlPath, page.url());
    }

    // helper used throughout the script for saving a Playwright Download object
    async function saveDownload(dl) {
      try {
        const filePath = path.join(downloadsDir, `ektiposi-${Date.now()}.pdf`);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        await dl.saveAs(filePath);
        console.log('[download] saved via manual click to', filePath);
        result.downloaded = true;
        result.downloadPath = filePath;
      } catch (e) {
        if (debug) console.log('[saveDownload] error', e);
      }
    }
    async function tryLogin() {
      try {
        const govUrl = 'https://www.gov.gr/upourgeia/oloi-foreis/anexartete-arkhe-demosion-esodon-aade/bebaiose-phorologikou-metroou';
        if (debug) console.log('[login] opening gov entry page', govUrl);
        await step(() => page.goto(govUrl, { waitUntil: 'domcontentloaded', timeout: 250000 }));
        await page.waitForURL('**/gov.gr/**', { timeout: 30000 }).catch(() => null);
        if (debug) console.log('[login] current url after gov open', page.url());

        // first preference: click the official entry button on gov.gr
        let movedToLogin = false;
        const govEntryBtn = page.locator('text="Είσοδος στην υπηρεσία"').first();
        if (await govEntryBtn.count()) {
          await step(() => govEntryBtn.click().catch(() => {}));
          movedToLogin = !!(await page.waitForURL('**/login.gsis.gr/**', { timeout: 30000 }).catch(() => null));
        }
        const loginUrl = "https://login.gsis.gr/mylogin/login.jsp?bmctx=1DB55AB50C08F2B418903DE4EB7466AD47038BC455E39B9EA82B1EB28CE52BC6&contextType=external&username=string&password=secure_string&challenge_url=https%3A%2F%2Flogin.gsis.gr%2Fmylogin%2Flogin.jsp&ssoCookie=disablehttponly&request_id=-447430090749148318&authn_try_count=0&locale=en_US&resource_url=https%253A%252F%252Fwww1.aade.gr%252Fsaadeapps3%252Fcomregistry";
        if (!movedToLogin && !/login\.gsis\.gr/.test(page.url())) {
          if (debug) console.log('[login] gov button did not move to login, using direct login URL fallback');
          await step(() => page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 250000 }));
        }
        await page.fill('#username', username);
        await page.waitForTimeout(1000);
        await page.fill('#password', password);
        await page.waitForTimeout(1000);
        await page.click('[name="btn_login"]').catch(() => null);
        await page.waitForTimeout(1000);
        await page.keyboard.press('Enter').catch(() => null);
        await page.waitForTimeout(1000);
        const redirectHit = await page.waitForURL('**/saadeapps3/comregistry/**', { timeout: 20000 }).catch(() => null);
        const urlLooksLoggedIn = /saadeapps3\/comregistry/i.test(page.url());
        const appShellReady = await page.locator('#myselect1, div.custom-panel-title-small, text="Έκδοση"')
          .first()
          .waitFor({ state: 'visible', timeout: 25000 })
          .then(() => true)
          .catch(() => false);
        if (redirectHit || urlLooksLoggedIn || appShellReady) return true;
        const html = await page.content().catch(() => '');
        if (/Προέκυψε\s+σφάλμα\s+συστήματος/i.test(html)) {
          result.systemError = true;
        } else {
          result.invalidCreds = true;
        }
        return false;
      } catch (e) {
        if (debug) console.log('[tryLogin] exception', e.message);
        return false;
      }
    }

    let loggedIn = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      loggedIn = await tryLogin();
      if (loggedIn) break;
      if (debug) console.log(`[run] login attempt ${attempt} failed, retrying...`);
      await page.waitForTimeout(2500 * attempt);
    }
    if (!loggedIn) {
      await dumpDiagnostics('login_failed');
      return result;
    }
    // login eventually succeeded; clear transient flags from previous attempts
    result.invalidCreds = false;
    result.systemError = false;

    // post-login navigation and download sequence
    await step(() => page.goto('https://www1.aade.gr/saadeapps3/comregistry/#!/arxiki', { waitUntil: 'domcontentloaded' }));
    await page.waitForTimeout(1200);

    await step(() => page.locator('div.custom-panel-title-small:visible').first().click().catch(() => {}));

    await step(() => page.goto('https://www1.aade.gr/saadeapps3/comregistry/#!/vevaiwseismhtrwou', { waitUntil: 'domcontentloaded' }));
    await page.waitForTimeout(1200);
    await step(() => page.locator('div.custom-panel-title-small:visible').first().click().catch(() => {}));

    await step(() => page.goto('https://www1.aade.gr/saadeapps3/comregistry/#!/mhtrwoepixeirhshs', { waitUntil: 'domcontentloaded' }));
    await page.waitForTimeout(1500);

    async function detectBusinessContext() {
      const onBusinessRoute = /#!\/mhtrwoepixeirhshs/i.test(page.url());
      const hasSelect = (await page.locator('#myselect1').count()) > 0;
      const hasIssueBtn = (await page.locator('text="Έκδοση"').count()) > 0;
      const hasBusinessOptions = (await page.locator('#myselect1 option[value="flagdrastepix"], #myselect1 option[value="flagegkeswt"]').count()) > 0;
      return {
        onBusinessRoute,
        hasSelect,
        hasIssueBtn,
        hasBusinessOptions,
        ok: onBusinessRoute && (hasSelect || hasIssueBtn || hasBusinessOptions),
      };
    }

    let businessCtx = await detectBusinessContext();
    if (!businessCtx.ok) {
      if (debug) console.log('[run] business context not confirmed on first try', businessCtx);
      // one more deterministic retry before classifying user as individual
      await step(() => page.goto('https://www1.aade.gr/saadeapps3/comregistry/#!/mhtrwoepixeirhshs', { waitUntil: 'domcontentloaded' }));
      await page.waitForTimeout(1500);
      businessCtx = await detectBusinessContext();
      if (debug) console.log('[run] business context after retry', businessCtx);
    }

    if (!businessCtx.ok) {
      result.noBusiness = true;
      result.isIndividual = true;
      result.error = 'individual account - business registry unavailable';
      if (debug) console.log('[run] treating account as individual (no business context detected)');
      return result;
    }

    const selectors = ['flagdrastepix', 'flagegkeswt', 'flagdrastepix'];
    for (const value of selectors) {
      const sel = page.locator('#myselect1').first();
      const exists = await sel.locator(`option[value="${value}"]`).count();
      if (exists) {
        await step(() => sel.selectOption(value).catch(() => {}));
        await page.waitForTimeout(300);
      }
    }

    // prepare to catch the automatic download that occurs when the Έκδοση button
    // is pressed. the download often fires on the same page or popup immediately.
    const downloadPromise = context.waitForEvent('download', { timeout: 30000 }).catch(() => null);
    const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
    await step(() => page.click('text="Έκδοση"').catch(() => {}));
    // if a download fired right away, save it and exit early
    const dlAuto = await downloadPromise;
    if (dlAuto) {
      await saveDownload(dlAuto);
      // we got the real PDF; no need for further fallback
      return result;
    }
    // the network-response listener might have already saved a PDF
    if (result.downloaded) {
      console.log('[run] pdf captured via network response, skipping fallbacks');
      return result;
    }

    const popup = await popupPromise;
    const downloadPage = popup || page;
    await downloadPage.waitForLoadState('domcontentloaded').catch(() => {});
    if (debug) {
      const curUrl = downloadPage.url();
      console.log('[debug] downloadPage.url()', curUrl);
      await dumpDiagnostics('after_ekdosi');
      // log potential download-related elements for inspection
      const cand = await downloadPage.evaluate(() =>
        Array.from(document.querySelectorAll('*'))
          .filter(el => el.innerText && /Download|Λήψη/i.test(el.innerText))
          .map(el => el.outerHTML.slice(0,200))
      );
      console.log('[debug] download candidates', cand);
      // try to locate the shadow‑root icon and print its coordinates for mapping
      const shadowIcon = downloadPage.locator('viewer-download-controls >>> #icon').first();
      if (await shadowIcon.count()) {
        const bb = await shadowIcon.boundingBox();
        console.log('[coords] shadow icon box', bb);
      } else {
        console.log('[coords] shadow icon not found');
      }
      if (/^blob:/.test(curUrl)) {
        const size = await downloadPage.evaluate(async u => {
          try {
            const r = await fetch(u);
            const ab = await r.arrayBuffer();
            return ab.byteLength;
          } catch (e) {
            return 'fetch-failed-'+e.message;
          }
        }, curUrl);
        console.log('[debug] blob size', size);
      }
    }
    // attempt clicking around top-right corner in a small grid, hoping to hit the download icon
    const vp = downloadPage.viewportSize();
    if (vp) {
      const starts = [40, 80, 120];
      let got = null;
      for (const ox of starts) {
        for (const oy of starts) {
          const x = vp.width - ox;
          const y = oy;
          const [dl] = await Promise.all([
            downloadPage.waitForEvent('download', { timeout: 2000 }).catch(() => null),
            step(() => downloadPage.mouse.click(x, y).catch(() => {})),
          ]);
          if (dl) {
            got = dl;
            break;
          }
        }
        if (got) break;
      }
      if (got) {
        await saveDownload(got);
      }
    }

    // attempt clicking PDF viewer's download button if it exists (top-right)
    const dlBtn = downloadPage.locator('button[aria-label*="Download"], button[title*="Λήψη"], button[title*="Download"]');
    if (await dlBtn.count()) {
      await step(() => dlBtn.first().click().catch(() => {}));
    }
    // also try the shadow-root icon directly (chrome viewer)
    try {
      await downloadPage.evaluate(() => {
        const ctrl = document.querySelector('viewer-download-controls');
        const icon = ctrl && ctrl.shadowRoot && ctrl.shadowRoot.querySelector('#icon');
        if (icon) icon.click();
      });
    } catch (_e) {}

    async function tryDownload(p) {
      const filename = `ektiposi-${Date.now()}.pdf`;
      const dlPath = path.join(downloadsDir, filename);
      fs.mkdirSync(path.dirname(dlPath), { recursive: true });
      let saved = false;

      // a) monitor for any PDF network response
      const pdfRespPromise = p.waitForResponse(
        r => (r.headers()['content-type'] || '').toLowerCase().includes('application/pdf')
              || /\.pdf([?#].*)?$/i.test(r.url()),
        { timeout: 10000 }
      ).catch(() => null);

      // b) extract from PDF.js viewer if present
      if (!saved) {
        const pdfBytes = await p.evaluate(async () => {
          try {
            if (window.PDFViewerApplication && window.PDFViewerApplication.pdfDocument) {
              const data = await window.PDFViewerApplication.pdfDocument.getData();
              return Array.from(data);
            }
          } catch(e) { return null; }
          return null;
        });
        if (pdfBytes && pdfBytes.length) {
          fs.writeFileSync(dlPath, Buffer.from(pdfBytes));
          saved = true;
        }
      }

      // c) click Chrome viewer download icon (toolbar)
      const iconBtn = p.locator('#icon:visible, cr-icon:visible').first();
      if (await iconBtn.count()) {
        await iconBtn.click().catch(() => {});
        // response may be captured by pdfRespPromise
      }

      // d) click any labelled download button on viewer toolbar
      if (!saved) {
        const dlBtn = p.locator('button[aria-label*="Download"], button[title*="Λήψη"], button[title*="Download"]');
        if (await dlBtn.count()) {
          await dlBtn.first().click().catch(() => {});
        }
      }

      // e) generic download element
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

      // f) network response from (a)
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

      // g) inspect embed/iframe/object for pdf URL
      if (!saved) {
        const pdfUrl = await p.evaluate(() => {
          const sel = 'embed[type="application/pdf"], iframe[src*=".pdf"], object[type="application/pdf"]';
          const el = document.querySelector(sel);
          return el ? el.src || el.data || el.getAttribute('src') : null;
        });
        if (pdfUrl) {
          try {
            let buf = null;
            if (/^blob:/.test(pdfUrl)) {
              buf = await p.evaluate(async u => {
                const r = await fetch(u);
                const a = await r.arrayBuffer();
                return Array.from(new Uint8Array(a));
              }, pdfUrl).then(arr => arr ? Buffer.from(arr) : null).catch(() => null);
            } else {
              const res = await context.request.get(pdfUrl).catch(() => null);
              if (res && res.ok()) buf = await res.body().catch(() => null);
            }
            if (buf && buf.length) {
              fs.writeFileSync(dlPath, buf);
              saved = true;
            }
          } catch (e) {
            // ignore
          }
        }
      }

      // h) fallback to previously intercepted blob
      if (!saved) {
        const arr = await p.evaluate(async () => {
          try {
            if (window._lastBlobForTrainer) {
              const ab = await window._lastBlobForTrainer.arrayBuffer();
              return Array.from(new Uint8Array(ab));
            }
          } catch (e) {
            return {error: e.message};
          }
          return null;
        });
        if (arr && arr.error) {
          if (debug) console.log('[tryDownload] blob read error', arr.error);
        }
        if (arr && arr.length && !arr.error) {
          if (debug) console.log('[tryDownload] got blob from _lastBlobForTrainer, length', arr.length);
          const buf = Buffer.from(arr);
          fs.writeFileSync(dlPath, buf);
          saved = true;
        }
      }

      // i) blob URL manual fetch
      if (!saved) {
        const cur = p.url();
        if (/^blob:/.test(cur)) {
          try {
            const arr = await p.evaluate(async u => {
              return await new Promise((resolve, reject) => {
                try {
                  const xhr = new XMLHttpRequest();
                  xhr.open('GET', u);
                  xhr.responseType = 'arraybuffer';
                  xhr.onload = () => { resolve(Array.from(new Uint8Array(xhr.response))); };
                  xhr.onerror = reject;
                  xhr.send();
                } catch (e) { reject(e); }
              });
            }, cur);
            const buf = Buffer.from(arr);
            fs.writeFileSync(dlPath, buf);
            saved = true;
          } catch {
            // ignore failures
          }
        }
        // still unsaved? try clicking the shadow download icon directly
        if (!saved) {
          try {
            await p.evaluate(() => {
              const ctrl = document.querySelector('viewer-download-controls');
              const icon = ctrl && ctrl.shadowRoot && ctrl.shadowRoot.querySelector('#icon');
              if (icon) icon.click();
            });
          } catch (_e) {}
        }
      }

      // j) context.request on blob URL
      if (!saved) {
        const cur = p.url();
        if (/^blob:/.test(cur)) {
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

      // k) direct pdf URL
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

    // first try keyboard save (Ctrl+S) which may trigger download from PDF viewer
    const [dlS] = await Promise.all([
      downloadPage.waitForEvent('download', { timeout: 5000 }).catch(() => null),
      step(() => downloadPage.keyboard.press('Control+S').catch(() => {})),
    ]);
    if (dlS) {
      await saveDownload(dlS);
    }

    const [dl1] = await Promise.all([
      downloadPage.waitForEvent('download', { timeout: 12000 }).catch(() => null),
      step(() => downloadPage.locator('[download], button[download], a:has-text("Download"), a:has-text("Λήψη")').first().click().catch(() => {})),
    ]);
    if (dl1) {
      const filePath = path.join(downloadsDir, `ektiposi-${Date.now()}.pdf`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      await dl1.saveAs(filePath);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
        throw new Error(`downloaded file missing or empty: ${filePath}`);
      }
      result.downloaded = true;
      result.downloadPath = filePath;
      console.log('[download] saved to', path.relative(process.cwd(), filePath));
    }
    if (!result.downloaded) {
      const firstPath = await tryDownload(downloadPage);
      if (firstPath) {
        console.log('[download] saved via tryDownload to', firstPath);
        result.downloaded = true;
        result.downloadPath = firstPath;
      }
    }
    if (!result.downloaded) {
      await step(() => downloadPage.keyboard.press('Control+P').catch(() => {}));
      try {
        const pdfBuf = await downloadPage.pdf({ format: 'A4' });
        const filePath = path.join(downloadsDir, `printout-${Date.now()}.pdf`);
        fs.writeFileSync(filePath, pdfBuf);
        if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
          throw new Error(`file.pdf export failed: ${filePath}`);
        }
        console.log('[download] saved via page.pdf to', path.relative(process.cwd(), filePath));
        result.downloaded = true;
        result.downloadPath = filePath;
      } catch {}
    }
    if (!result.downloaded) {
      result.noOblig = true;
      await dumpDiagnostics('download_failed');
    }
  } catch (e) {
    if (debug) console.log('[run] error', e);
    result.error = e.message || String(e);
  } finally {
    if (browser) await browser.close();
  }
  return result;
}

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
    runLoop(JSON.parse(args[1]))
      .then(r => { console.log('[loop] results', JSON.stringify(r)); process.exit(0); })
      .catch(e => { console.error(e); process.exit(1); });
  } else if (args[0] === '--params' && args[1]) {
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
