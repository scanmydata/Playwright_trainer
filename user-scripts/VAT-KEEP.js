'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

/**
 * Script : CC
 * Recorded: 2026-03-03
 * @param {string} params.username - username
 * @param {string} params.password - password
 * @param {number} params.year - tax year
 * @param {string} [params.periodType] - 'oneMonth' or 'threeMonths'
 * @param {number} [params.month] - 1–12 (required when periodType is oneMonth)
 * @param {number} [params.quarter] - 1–4 (required when periodType is threeMonths)
 * @param {string} [params.startDate] - YYYY-MM (inclusive); when provided with
 *   endDate the script will iterate month-by-month between the two dates and
 *   ignore periodType/month/quarter.
 * @param {string} [params.endDate] - YYYY-MM (inclusive) end of range.
 */

async function run(params = {}) {
  const {
    username = "",
    password = "",
    year = new Date().getFullYear(),
  } = params;

  // keep track of what happened so the caller can inspect it; also log a
  // concise summary at the end of the run.
  const result = {
    noOblig: false,          // true if no obligations or no saved declarations
    downloaded: false,       // true if a PDF was successfully fetched
    downloadPath: null,      // path to the downloaded file
    invalidCreds: false,     // set when login page shows error message
    error: null,             // any error that occurred
  };

  const headless = process.env.PW_HEADLESS === '1';
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    // clear any existing data to avoid reusing another account
    await context.clearCookies();
    await context.clearPermissions();
    // do not try to access localStorage on cross-origin pages; navigation to
    // logout URL below will reset session state

    // explicitly hit logout endpoint to revoke server session, then load start page
    await page.goto('https://login.gsis.gr/oam/server/logout?end_url=https://www1.aade.gr/taxisnet/vat/protected/displayDeclarationTypes.htm', { waitUntil: 'domcontentloaded' });

    await page.goto("https://www1.aade.gr/taxisnet/vat/protected/displayDeclarationTypes.htm", { waitUntil: 'domcontentloaded' });

    const loginField = page.locator('#username');
    let loggedIn = true;
    if (await loginField.count()) {
      if (!username || !password) {
        console.warn('[run] credentials not provided; login form will remain visible');
        loggedIn = false;
      } else {
        await page.fill('#username', username);
        await page.fill('#password', password);

        // try a variety of submit buttons in order
        const submitSelectors = [
          'button[type="submit"]',
          'input[type="submit"]',
          'button:has-text("Είσοδος")',
          'button:has-text("Σύνδεση")',
        ];
        let clicked = false;
        for (const sel of submitSelectors) {
          const btn = page.locator(sel).first();
          if (await btn.count()) {
            await Promise.all([
              page.waitForLoadState('domcontentloaded'),
              btn.click(),
            ]);
            clicked = true;
            break;
          }
        }
        if (!clicked) {
          // fallback to pressing Enter
          await Promise.all([
            page.waitForLoadState('domcontentloaded'),
            page.keyboard.press('Enter'),
          ]);
        }
        // check again whether login field still present
        if (await page.locator('#username').count()) {
          // the form stayed visible; maybe credentials were bad. look for a
          // known error message element on the page and label accordingly.
          const errText = await page.evaluate(() => {
            const el = document.querySelector('#errDiv label, .error');
            return el ? el.innerText.trim() : '';
          });
          if (errText) {
            console.log('[run] login failed, error message:', errText);
            result.invalidCreds = true;
            result.error = errText;
          }
          loggedIn = false;
        }
      }
    }


    if (!loggedIn) {
      console.log('[run] not logged in - skipping subsequent navigation');
      if (!result.error) {
        result.error = 'not logged in';
      }
      console.log('[run] result', JSON.stringify(result));
      return result;
    }

    await page.goto(`https://www1.aade.gr/taxisnet/vat/protected/displayLiabilitiesForYear.htm?declarationType=vatF2&year=${year}`, { waitUntil: 'domcontentloaded' });

    // determine which periods to check. there are three modes:
    // 1. explicit single month/quarter (params.month or params.quarter)
    // 2. full‑year mode (no month/quarter given, just periodType)
    // 3. arbitrary date range (params.startDate and params.endDate, YYYY-MM)
    const periodType = params.periodType || 'oneMonth';
    let values = [];

    // range mode takes precedence
    if (params.startDate && params.endDate) {
      // generate list of month numbers between start and end inclusive
      const [sY, sM] = params.startDate.split('-').map(Number);
      const [eY, eM] = params.endDate.split('-').map(Number);
      if (!sY || !sM || !eY || !eM) {
        throw new Error('startDate and endDate must be YYYY-MM');
      }
      let curY = sY, curM = sM;
      while (curY < eY || (curY === eY && curM <= eM)) {
        values.push({ year: curY, month: curM });
        curM++;
        if (curM === 13) { curM = 1; curY++; }
      }
      // when range mode is active we will override the usual periodType
    } else if (periodType === 'oneMonth') {
      if (params.month) {
        values = [parseInt(params.month, 10)];
      } else {
        values = Array.from({ length: 12 }, (_, i) => i + 1);
      }
    } else if (periodType === 'threeMonths') {
      if (params.quarter) {
        values = [parseInt(params.quarter, 10)];
      } else {
        values = [1, 2, 3, 4];
      }
    } else {
      throw new Error('Unsupported periodType: ' + periodType);
    }

    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    const enc = encodeURIComponent;
    const sessionResults = [];

    // helper to process one period value and return its result object
    async function processPeriod(val) {
      // human-readable period label for logging
      const label = (typeof val === 'object' && val.year && val.month)
        ? `${val.year}-${String(val.month).padStart(2,'0')}`
        : String(val);
      let periodStart, periodEnd;
      // handle range object {year,month}
      if (typeof val === 'object' && val.year && val.month) {
        const m = val.month;
        const y = val.year;
        const lastDay = new Date(y, m, 0).getDate();
        periodStart = `01/${pad(m)}/${y}`;
        periodEnd = `${lastDay}/${pad(m)}/${y}`;
      } else if (periodType === 'oneMonth') {
        const m = val;
        const lastDay = new Date(year, m, 0).getDate();
        periodStart = `01/${pad(m)}/${year}`;
        periodEnd = `${lastDay}/${pad(m)}/${year}`;
      } else {
        const q = val;
        const startMonth = 1 + (q - 1) * 3;
        const endMonth = startMonth + 2;
        const lastDay = new Date(year, endMonth, 0).getDate();
        periodStart = `01/${pad(startMonth)}/${year}`;
        periodEnd = `${lastDay}/${pad(endMonth)}/${year}`;
      }

      const listUrl =
        `https://www1.aade.gr/taxisnet/vat/protected/displayDeclarationsList.htm` +
        `?declarationType=vatF2&year=${year}` +
        `&periodType=${periodType}` +
        `&periodStart=${enc(periodStart)}` +
        `&periodEnd=${enc(periodEnd)}` +
        `&effectivePeriodStart=${enc(periodStart)}` +
        `&effectivePeriodEnd=${enc(periodEnd)}`;

      await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
      // if the login form reappeared, bail out immediately
      if (await page.locator('#username').count()) {
        throw new Error('Session expired or login required when loading list page');
      }

      // now reproduce the remainder of the original logic but using a
      // fresh copy of the result template for this period
      const res = { ...result, noOblig: false, downloaded: false, downloadPath: null, invalidCreds: false, error: null };
      const bodyText = await page.evaluate(() => document.body.innerText || '');
      if (/Δεν\s+έχετε\s+υποχρεώσεις/i.test(bodyText)) {
        console.log('[run] no obligations for period', label);
        res.noOblig = true;
        return res;
      }
      if (/Δεν\s+υπάρχουν\s+αποθηκευμένες\s+Δηλώσεις/i.test(bodyText)) {
        console.log('[run] no saved declarations for period', label);
        res.noOblig = true;
        return res;
      }
      // choose the row whose displayed period matches our computed dates
      let popup;
      const matchedRow = page.locator('tr')
        .filter({ hasText: periodStart })
        .filter({ hasText: periodEnd })
        .first();
      if (await matchedRow.count()) {
        const btn = matchedRow.locator('text="Προβολή"').first();
        const [p] = await Promise.all([
          page.waitForEvent('popup'),
          btn.click(),
        ]);
        popup = p;
      } else {
        const previews = page.locator('text="Προβολή"');
        const count = await previews.count();
        if (count === 0) {
          console.log('[run] no Προβολή buttons for period', label, 'body text:', bodyText.slice(0,1500));
          throw new Error('No Προβολή button found');
        }
        const target = previews.nth(count - 1);
        const [p] = await Promise.all([
          page.waitForEvent('popup'),
          target.click(),
        ]);
        popup = p;
      }
      await popup.waitForLoadState('domcontentloaded');

      const pdfRespPromise = popup.waitForResponse(
        r => (r.headers()['content-type'] || '').includes('pdf'),
        { timeout: 10000 }
      ).catch(() => null);

      const iconBtn = popup.locator('#icon, cr-icon');
      if (await iconBtn.count()) {
        try {
          await iconBtn.click();
        } catch (e) {
          await popup.evaluate(() => {
            const el = document.querySelector('#icon');
            if (el) el.click();
          }).catch(() => {});
        }
      }

      const prePdf = await pdfRespPromise;
      if (prePdf) {
        const buffer = await prePdf.body();
        const dlPath = path.join(__dirname, '..', 'downloads', `viewPdf-${label}.pdf`);
        fs.mkdirSync(path.dirname(dlPath), { recursive: true });
        fs.writeFileSync(dlPath, buffer);
        console.log('[download] saved to', dlPath);
        res.downloaded = true;
        res.downloadPath = dlPath;
        return res;
      }

      const downloadSelector = 'a[download], button[download], a:has-text("Λήψη"), a:has-text("Download"), button:has-text("Download")';
      const dlBtn = popup.locator(downloadSelector).first();
      if (await dlBtn.count()) {
        const [download] = await Promise.all([
          popup.waitForEvent('download'),
          dlBtn.click(),
        ]);
        const dlPath = path.join(__dirname, '..', 'downloads', `viewPdf-${label}.pdf`);
        fs.mkdirSync(path.dirname(dlPath), { recursive: true });
        await download.saveAs(dlPath);
        console.log('[download] saved to', dlPath);
        res.downloaded = true;
        res.downloadPath = dlPath;
        return res;
      }

      const pdfUrl = await popup.evaluate(() => {
        const sel = 'embed[type="application/pdf"], iframe[src*=".pdf"], object[type="application/pdf"]';
        const el = document.querySelector(sel);
        return el ? el.src || el.data || el.getAttribute('src') : null;
      });
      if (!pdfUrl) {
        const [download] = await Promise.all([
          popup.waitForEvent('download', { timeout: 5000 }).catch(() => null),
          popup.click('[download]').catch(() => {}),
        ]);
        if (download) {
          const dlPath = path.join(__dirname, '..', 'downloads', `viewPdf-${label}.pdf`);
          fs.mkdirSync(path.dirname(dlPath), { recursive: true });
          await download.saveAs(dlPath);
          console.log('[download] saved to', dlPath);
          res.downloaded = true;
          res.downloadPath = dlPath;
          return res;
        } else {
          throw new Error('Could not determine PDF URL or download action');
        }
      }
      const response = await context.request.get(pdfUrl);
      const buffer = await response.body();
      const dlPath = path.join(__dirname, '..', 'downloads', `viewPdf-${label}.pdf`);
      fs.mkdirSync(path.dirname(dlPath), { recursive: true });
      fs.writeFileSync(dlPath, buffer);
      console.log('[download] saved to', dlPath);
      res.downloaded = true;
      res.downloadPath = dlPath;
      return res;
    }

    // process each desired period sequentially
    for (let i = 0; i < values.length; i++) {
      const val = values[i];
      const singleRes = await processPeriod(val);
      sessionResults.push(singleRes);
      if (i < values.length - 1) {
        // navigate back to the list page to reuse the session/state
        await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    }

    if (sessionResults.length > 1) {
      console.log('[run] multi-results', JSON.stringify(sessionResults));
      return sessionResults;
    } else {
      console.log('[run] result', JSON.stringify(sessionResults[0]));
      return sessionResults[0];
    }
    // if navigation redirected back to login form we lost the session
    if (await page.locator('#username').count()) {
      throw new Error('Session expired or login required when loading list page');
    }

    // read the full body text for later diagnostics and for the "no
    // obligations" message which may be broken across elements.
    const bodyText = await page.evaluate(() => document.body.innerText || '');
    // there are two different “nothing to show” messages we’ve seen so far:
    // 1. “Δεν έχετε υποχρεώσεις …” (no obligations at all)
    // 2. “Δεν υπάρχουν αποθηκευμένες Δηλώσεις” (no saved declarations)
    // treat either as a no‑data condition.
    if (/Δεν\s+έχετε\s+υποχρεώσεις/i.test(bodyText)) {
      console.log('[run] no obligations for selected period (text search)');
      result.noOblig = true;
      console.log('[run] result', JSON.stringify(result));
      return result;
    }
    if (/Δεν\s+υπάρχουν\s+αποθηκευμένες\s+Δηλώσεις/i.test(bodyText)) {
      console.log('[run] no saved declarations for selected period');
      result.noOblig = true;
      console.log('[run] result', JSON.stringify(result));
      return result;
    }
    // also attempt the original locator-based lookup as a secondary check
    const noObligCount = await page.locator('text=/Δεν\s+έχετε\s+υποχρεώσεις/i').count();
    if (noObligCount > 0) {
      console.log('[run] no obligations for selected period (locator search)');
      return { noOblig: true };
    }
    // locate Προβολή buttons and ensure at least one exists (debug if not)
    const previews = page.locator('text="Προβολή"');
    const count = await previews.count();
    if (count === 0) {
      // dump some text so we can review what was actually returned. bodyText
      // above already contains the full text, so use that rather than capturing
      // another page.content() or screenshot.
      console.log('[run] no Προβολή buttons; page body text:', bodyText.slice(0,1500));
      throw new Error('No Προβολή button found');
    }
    // click the most recent "Προβολή" button if more than one
    const target = previews.nth(count - 1);
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      target.click(),
    ]);
    await popup.waitForLoadState('domcontentloaded');

    // pre-emptively wait for any PDF response from the popup (could be triggered
    // by clicking icon or automatically by viewer)
    const pdfRespPromise = popup.waitForResponse(
      r => (r.headers()['content-type'] || '').includes('pdf'),
      { timeout: 10000 }
    ).catch(() => null);

    // try clicking the known download icon (#icon/cr-icon) or shadowed element
    const iconBtn = popup.locator('#icon, cr-icon');
    if (await iconBtn.count()) {
      try {
        await iconBtn.click();
      } catch (e) {
        // if click fails (shadow dom etc) try evaluate
        await popup.evaluate(() => {
          const el = document.querySelector('#icon');
          if (el) el.click();
        }).catch(() => {});
      }
    }

    // if the pdf response already arrived, save and exit
    const prePdf = await pdfRespPromise;
    if (prePdf) {
      const buffer = await prePdf.body();
      const dlPath_13 = path.join(__dirname, '..', 'downloads', 'viewPdf.pdf');
      fs.mkdirSync(path.dirname(dlPath_13), { recursive: true });
      fs.writeFileSync(dlPath_13, buffer);
      console.log('[download] saved to', dlPath_13);
      result.downloaded = true;
      result.downloadPath = dlPath_13;
      console.log('[run] result', JSON.stringify(result));
      return result;
    } else {
      // try to locate an embedded PDF source URL inside the popup
      const pdfUrl = await popup.evaluate(() => {
        const sel = 'embed[type="application/pdf"], iframe[src*=".pdf"], object[type="application/pdf"]';
        const el = document.querySelector(sel);
        return el ? el.src || el.data || el.getAttribute('src') : null;
      });
      if (!pdfUrl) {
        // fallback again to any download event by clicking generic download link
        const [download_13] = await Promise.all([
          popup.waitForEvent('download', { timeout: 5000 }).catch(() => null),
          popup.click('[download]').catch(() => {}),
        ]);
        if (download_13) {
          const dlPath_13 = path.join(__dirname, '..', 'downloads', 'viewPdf.pdf');
          fs.mkdirSync(path.dirname(dlPath_13), { recursive: true });
          await download_13.saveAs(dlPath_13);
          console.log('[download] saved to', dlPath_13);
          result.downloaded = true;
          result.downloadPath = dlPath_13;
          console.log('[run] result', JSON.stringify(result));
          return result;
        } else {
          throw new Error('Could not determine PDF URL or download action');
        }
      } else {
        // fetch the PDF via the browser context (preserves cookies)
        const response = await context.request.get(pdfUrl);
        const buffer = await response.body();
        const dlPath_13 = path.join(__dirname, '..', 'downloads', 'viewPdf.pdf');
        fs.mkdirSync(path.dirname(dlPath_13), { recursive: true });
        fs.writeFileSync(dlPath_13, buffer);
        console.log('[download] saved to', dlPath_13);
        result.downloaded = true;
        result.downloadPath = dlPath_13;
        console.log('[run] result', JSON.stringify(result));
        return result;
      }
    }
  } catch (err) {
    // capture error message and rethrow so CLI still fails appropriately
    result.error = err.message || String(err);
    console.error('[run] encountered error', result.error);
    throw err;
  } finally {
    await browser.close();
  }
  // if we reach the end without an earlier return (should not normally
  // happen) return the result object anyway so callers can inspect it.
  return result;
}

/**
 * Run the script for every set of params in paramsArray (loop mode).
 * @param {Array} paramsArray - array of parameter objects, e.g. [{ foo:'bar' }, { foo:'baz' }]
 */
async function runLoop(paramsArray = []) {
  const results = [];
  for (const p of paramsArray) {
    console.log('[loop] running with params:', JSON.stringify(p));
    const res = await run(p);
    results.push({ params: p, result: res, ok: true });
  }
  return results;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--loop' && args[1]) {
    // Usage: node script.js --loop '[{"paramName":"value1"},{"paramName":"value2"}]' or any JSON array of parameter objects
    runLoop(JSON.parse(args[1])).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
  } else if (args[0] === '--params' && args[1]) {
    run(JSON.parse(args[1]))
      .then(res => {
        console.log('[run] result', JSON.stringify(res));
        process.exit(0);
      })
      .catch(e => { console.error(e); process.exit(1); });
  } else {
    run()
      .then(res => {
        console.log('[run] result', JSON.stringify(res));
        process.exit(0);
      })
      .catch(e => { console.error(e); process.exit(1); });
  }
}

module.exports = { run, runLoop };
