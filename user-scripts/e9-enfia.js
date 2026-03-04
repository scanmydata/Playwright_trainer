'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

/**
 * Script : e9-enfia
 * Recorded: 2026-03-03
 *
 * @param {string} params.username - TAXISnet username
 * @param {string} params.password - TAXISnet password
 * @param {number|number[]} [params.years] - year or array of years to query
 *   (defaults to current year if omitted).
 * @param {string[]} [params.docs] - documents to fetch: 'property' or 'enfia'
 *   (defaults to ['property']).
 *
 * @returns {Object|Object[]} result(s) with flags similar to other scripts.
 */

async function run(params = {}) {
  const debug = process.env.DEBUG === '1';
  if (debug) console.log('[run] debug enabled');

  const {
    username = "",
    password = "",
    years = [],
    docs = [],
  } = params;

  // prepare year list
  let yearList = [];
  if (Array.isArray(years)) yearList = years.slice();
  else if (years) yearList = [years];
  if (yearList.length === 0) yearList = [new Date().getFullYear()];

  // docs default
  let docsList = Array.isArray(docs) && docs.length ? docs.slice() : ['property'];

  const resultTemplate = {
    noOblig: false,
    downloaded: false,
    downloadPath: null,
    invalidCreds: false,
    error: null,
  };

  // determine a consistent downloads directory within the repository
  // so users can easily inspect it from the project root.
  // __dirname is user-scripts; go up one level to project root.
  const downloadsDir = path.resolve(__dirname, '..', 'downloads');

  // allow slowMo to give the portal time to react to each click/input
  // default to 600ms if not specified by environment
  const slowMo = process.env.SLOW_MO !== undefined
    ? parseInt(process.env.SLOW_MO, 10) || 0
    : 600;

  const browser = await chromium.launch({ headless: process.env.PW_HEADLESS === '1', slowMo });
  const context = await browser.newContext({ acceptDownloads: true });
  let page = await context.newPage();

  try {
    // multipage helpers that validate selectors and pause after acting
    let currentPage = page;
    async function safeClick(selector, options = {}) {
      // wait for the element to appear in the DOM
      await currentPage.waitForSelector(selector, { state: 'visible', timeout: 15000 });
      const el = currentPage.locator(selector);
      if (!(await el.count())) {
        throw new Error(`safeClick: selector not found after waiting: ${selector}`);
      }
      await el.click(options);
      await currentPage.waitForTimeout(slowMo);
    }
    async function safeFill(selector, value, options = {}) {
      const el = currentPage.locator(selector);
      if (!(await el.count())) {
        throw new Error(`safeFill: selector not found: ${selector}`);
      }
      await el.fill(value, options);
      await currentPage.waitForTimeout(slowMo);
    }

    // login
    await page.goto("https://www.aade.gr/dilosi-e9-enfia", { waitUntil: 'domcontentloaded' });
    // new tab login link
    const [loginTab] = await Promise.all([
      context.waitForEvent('page').catch(() => null),
      safeClick("[aria-label=\"Είσοδος στην εφαρμογή - ανοίξτε σε νέα καρτέλα\"]"),
    ]);
    const loginPage = loginTab || page;
    currentPage = loginPage;
    if (debug) console.log('[run] filling credentials');
    if (!username || !password) {
      throw new Error('missing credentials');
    }
    await safeFill("#username", username);
    await safeFill("#password", password);
    await safeClick("[name=\"btn_login\"]");
    await loginPage.waitForLoadState('load').catch(() => {});
    if (await loginPage.locator('#username').count()) {
      const errText = await loginPage.evaluate(() => {
        const el = document.querySelector('#errDiv label, .error');
        return el ? el.innerText.trim() : '';
      });
      if (errText) {
        console.log('[run] login failed, message:', errText);
        return { ...resultTemplate, invalidCreds: true, error: errText };
      }
    }

    if (loginPage !== page) {
      try { await page.close(); } catch (e) {}
      page = loginPage;
    }

    // navigate to ETAX main portal & enter application
    await page.goto("https://www1.aade.gr/etak/", { waitUntil: 'domcontentloaded' });
    await page.click("#pt1\\:cbEnter");
    await page.waitForLoadState('networkidle').catch(() => {});

    const results = [];

    function yearToOption(y) {
      // heuristic mapping: option value = year - 2010
      return String(Number(y) - 2010);
    }

    for (const year of yearList) {
      if (debug) console.log('[run] processing year', year);
      // set year if dropdown exists
      try {
        await page.click("#pt1\\:yearSelect\\:\\:content");
        await page.selectOption("#pt1\\:yearSelect\\:\\:content", yearToOption(year));
        await page.click("#pt1\\:yearSelect\\:\\:content");
      } catch (e) {
        if (debug) console.warn('[run] year dropdown not found or option missing for', year);
      }

      for (const doc of docsList) {
        if (debug) console.log('[run] attempting doc', doc, 'for year', year);
        const res = { ...resultTemplate };
        try {
          let selector;
          let filename;
          if (doc === 'property') {
            selector = '#pt1\\:iterPerStatus\\:0\\:cl24';
            filename = `PeriousiakiKatastasi${year}.pdf`;
          } else if (doc === 'enfia') {
            // primary id-based selector
            selector = `#pt1\\:clPrintEkk${year}`;
            filename = `ENFIA-${year}.pdf`;
          } else {
            if (debug) console.log('[run] unknown doc type', doc);
            continue;
          }

          // if ENFIA and id selector not found, try fallback by visible link text containing year
          let locator = page.locator(selector);
          if (doc === 'enfia' && !(await locator.count())) {
            const textPattern = `Εκτύπωση εκκαθαριστικού`; // common prefix
            locator = page.locator('a', { hasText: textPattern }).filter({ hasText: String(year) });
            if (await locator.count()) {
              selector = null; // we've replaced with locator reference below
            }
          }

          // if no hyperlink exists at all, mark as no obligations and skip
          if (selector && !(await page.locator(selector).count()) || (!selector && !(await locator.count()))) {
            res.noOblig = true;
            if (debug) console.log('[run] no link for', doc, year, '- assuming empty');
          } else {
            const clickTarget = selector ? page : locator;
            const clickArg = selector || locator;
            const [download] = await Promise.all([
              page.waitForEvent('download').catch(() => null),
              clickTarget.click(clickArg).catch(() => null),
            ]);
            if (download) {
              const dlPath = path.join(downloadsDir, filename);
              fs.mkdirSync(path.dirname(dlPath), { recursive: true });
              await download.saveAs(dlPath);
              // verify the file really exists and is non-empty
              if (!fs.existsSync(dlPath) || fs.statSync(dlPath).size === 0) {
                throw new Error(`downloaded file missing or empty: ${dlPath}`);
              }
              // log relative to workspace root for readability
              console.log('[download] saved to', path.relative(process.cwd(), dlPath));
              res.downloaded = true;
              res.downloadPath = dlPath;
            } else {
              throw new Error(`expected download event for ${doc} ${year} but none fired`);
            }
          }
        } catch (err) {
          res.error = err.message || String(err);
          console.error('[run] error processing', doc, year, res.error);
        }
        results.push({ year, doc, res });
      }
    }

    // logout sequence
    await page.click("#pt1:pt_cl1").catch(() => {});
    await page.goto("https://login.gsis.gr/oam/server/logout?end_url=https://www1.aade.gr/etak/", { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.goto("https://login.gsis.gr/mylogin/login.jsp", { waitUntil: 'domcontentloaded' }).catch(() => {});

    if (results.length === 1) return results[0].res;
    return results;
  } finally {
    await browser.close();
  }
}

async function runLoop(paramsArray = []) {
  const results = [];
  return results;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--loop' && args[1]) {
    // Usage: node script.js --loop '<json array>'
    runLoop(JSON.parse(args[1])).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
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
