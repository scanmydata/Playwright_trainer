'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

/**
 * Script : e1-e2-e3
 * Recorded: 2026-03-03
 * 
 * Downloads E1/E2/E3 income tax declarations from AADE portal.
 * 
 * @param {string} params.username - TAXISnet username
 * @param {string} params.password - TAXISnet password
 * @param {number|number[]} [params.years=[2025]] - Year(s) to download (default: 2025)
 * @param {string[]} [params.docs] - Document button names to download.
 *   If omitted, auto-discovers enabled buttons (excluding ΣΥΝΟΨΗ, myDATA, Τροποποιητικ).
 *   Supported shortcuts: 'E1', 'E2_YPO', 'E2_SYZ', 'E3', 'EKKATH', 'EKKATH_SYZ'
 *   Or use full button names like 'PBE1_PRINT_PDF', 'PB_EKKATH_PDF', etc.
 * @param {Object.<string,string>} [params.choices] - Optional: pre-select dropdown values (e.g. {"YEAR":"2025"})
 * 
 * @returns {Object} result - Download result object
 * @returns {boolean} result.noOblig - True if no data/obligations found for period
 * @returns {boolean} result.downloaded - True if at least one PDF was successfully saved
 * @returns {string|null} result.downloadPath - Path to last downloaded file, or null
 * @returns {boolean} result.invalidCreds - True when login fails with error message
 * @returns {string|null} result.error - Error message string, or null if no error
 * 
 * Environment Variables:
 * - PW_HEADLESS=0 : Run in headed mode (visible browser window)
 * - PW_HEADLESS=1 : Run in headless mode (default)
 * - DEBUG=1 : Enable verbose debug output
 */

async function run(params = {}) {
  const debug = process.env.DEBUG === '1';
  if (debug) console.log('[run] debug enabled');
  // supported params:
  // { username, password, years?, docs?, choices? }
  // - years: array or single year to iterate (defaults 2025)
  // - docs: array of document keys (e.g. ['E1','EKKATH_SYZ','EKKATH'])
  // - choices: object mapping <select> names to values
  const {
    username = "",
    password = "",
    years = [],
    docs = [],
    choices = {},
  } = params;

  const result = {
    noOblig: false,
    downloaded: false,
    downloadPath: null,
    invalidCreds: false,
    error: null,
  };

  const headless = process.env.PW_HEADLESS === '1';
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ acceptDownloads: true });
  let page = await context.newPage();

  try {
    // login page
    await page.goto("https://www.aade.gr/dilosi-forologias-eisodimatos-fp-e1-e2-e3", { waitUntil: 'domcontentloaded' });
    
    // login button opens new tab
    let loginPage = page;
    const [maybeLoginTab] = await Promise.all([
      context.waitForEvent('page').catch(() => null),
      page.click("[aria-label=\"Είσοδος στην Εφαρμογή - ανοίξτε σε νέα καρτέλα\"]"),
    ]);
    if (maybeLoginTab) {
      loginPage = maybeLoginTab;
      await loginPage.waitForLoadState('domcontentloaded').catch(() => {});
    }
    
    // fill credentials if provided
    const loginField = loginPage.locator('#username');
    let loggedIn = true;
    if (await loginField.count()) {
      if (!username || !password) {
        console.warn('[run] credentials not provided; login form will remain visible');
        loggedIn = false;
      } else {
        await loginPage.click('#username');
        await loginPage.fill('#username', username);
        await loginPage.fill('#password', password);
        await loginPage.click("[name=\"btn_login\"]");
        await loginPage.waitForLoadState('load').catch(() => {});
        console.log('[run] after login, URL is:', loginPage.url());
        if (await loginPage.locator('#username').count()) {
          // login still shown -> invalid creds
          const errText = await loginPage.evaluate(() => {
            const el = document.querySelector('#errDiv label, .error');
            return el ? el.innerText.trim() : '';
          });
          if (errText) {
            console.log('[run] login failed, message:', errText);
            result.invalidCreds = true;
            result.error = errText;
          }
          loggedIn = false;
        }
      }
    }

    if (!loggedIn) {
      console.log('[run] not logged in - aborting');
      return result;
    }
    
    // keep loginPage alive - close original if it's different
    if (loginPage !== page) {
      try { await page.close(); } catch (e) {}
    }
    page = loginPage;
    
    // navigate to the document listing by following the "Είσοδος στην εφαρμογή" link
    const enterAppLink = page.locator('a:has-text("Είσοδος στην εφαρμογή")');
    if (await enterAppLink.count()) {
      if (debug) console.log('[run] navigating to app via link');
      await enterAppLink.click();
      await page.waitForLoadState('networkidle').catch(() => {});
    }

    // prepare year list
    let yearList = [];
    if (Array.isArray(years)) yearList = years.slice();
    else if (years) yearList = [years];
    if (yearList.length === 0) yearList = [2025];

    for (const year of yearList) {
      // navigate to login.done page which shows the document buttons for the selected year
      // if year parameter is needed, the page URL is already set via year${year}/income/e1/index.jsp
      // but the buttons appear at login.done after the entry link is clicked
      await page.goto(`https://www1.aade.gr/webtax/incomefp/login.done`, { waitUntil: 'domcontentloaded' });
      
      // wait longer for dynamic content + JavaScript to execute
      await page.waitForLoadState('networkidle').catch(() => {});
      
      // check for iframes that might contain the content
      const frames = page.frames();
      if (debug) console.log('[run] found', frames.length, 'frames on page');
      
      // wait for ANY button or table to appear
      await page.waitForSelector('table button, button[name], iframe', { timeout: 8000 }).catch(() => {});
      
      // also try to find buttons INSIDE frames
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        try {
          const frameButtons = await frame.$$('button[name]');
          if (frameButtons.length > 0) {
            if (debug) console.log(`[run] found ${frameButtons.length} buttons in frame ${i}`);
          }
        } catch (e) {}
      }
      
      if (debug) {
        const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 700));
        console.log('[run] page content (first 700 chars):', bodyText);
        
        // also check for all buttons and links
        const allBtns = await page.$$eval('button, a[role="button"], input[type="button"]', els =>
          els.map(e => ({ tag: e.tagName, text: e.innerText?.substring(0, 50), name: e.name || e.id, onclick: e.onclick ? 'has' : 'no' }))
        );
        console.log('[run] all buttons/links found:', allBtns);
        
        // search for links containing E1, E2, E3
        const allLinks = await page.$$eval('a', els =>
          els.map(a => ({ href: a.href, text: a.innerText.trim(), class: a.className }))
            .filter(a => a.text || a.href)
            .slice(0, 15)
        );
        console.log('[run] first ~15 links on page:', allLinks);
      }

      // inspect available dropdowns for debugging/parameters
      const selects = await page.$$eval('select', els =>
        els.map(s => ({
          name: s.name || s.id || null,
          options: Array.from(s.options).map(o => ({ value: o.value, text: o.textContent })),
        }))
      );
      console.log('[run] dropdowns on page (year', year + '):', selects);

      // apply any explicit choices passed in
      for (const [name, val] of Object.entries(choices)) {
        try {
          await page.selectOption(`select[name="${name}"],select#${name}`, String(val));
        } catch (e) {
          console.warn('[run] could not set choice', name, val, e.message);
        }
      }

      // if caller didn't specify docs, discover them from the table buttons
      let docsToUse = Array.isArray(docs) && docs.length ? docs.slice() : null;
      if (!docsToUse) {
        const btns = await page.$$eval('table button[name]', els =>
          els.map(b => ({
            name: b.getAttribute('name'),
            text: b.textContent.trim(),
            disabled: b.hasAttribute('disabled') || b.disabled,
          }))
        );
        // if not found at top level, try in frames
        let buttonList = btns;
        if (buttonList.length === 0) {
          const frames = page.frames();
          for (const frame of frames) {
            try {
              const frameBtns = await frame.$$eval('table button[name]', els =>
                els.map(b => ({
                  name: b.getAttribute('name'),
                  text: b.textContent.trim(),
                  disabled: b.hasAttribute('disabled') || b.disabled,
                }))
              );
              if (frameBtns.length > 0) {
                buttonList = frameBtns;
                if (debug) console.log('[run] found buttons in iframe');
                break;
              }
            } catch (e) {}
          }
        }
        
        if (debug) console.log('[run] discovered document buttons', buttonList);
        // exclude summary and other non-download buttons
        docsToUse = buttonList
          .filter(b => !b.disabled)
          .filter(b => !/ΣΥΝΟΨΗ|myDATA|Τροποποιητικ/i.test(b.text) && b.name)
          .map(b => b.name);
        if (debug) console.log('[run] default docs list ->', docsToUse);
      }

      // iterate requested documents
      for (const doc of docsToUse) {
        let selector;
        // map common short names to actual button name attributes
        switch (doc) {
          case 'E1':
            selector = '[name="PBE1_PRINT_PDF"]';
            break;
          case 'EKKATH_SYZ':
            selector = '[name="PB_EKKATH_PDF_SYZ"]';
            break;
          case 'EKKATH':
            selector = '[name="PB_EKKATH_PDF"]';
            break;
          case 'E2_YPO':
            selector = '[name="PBE2_PRINT_PDF"]';
            break;
          case 'E2_SYZ':
            selector = '[name="PBE2_SYZYGOY_PRINT_PDF"]';
            break;
          case 'E3':
            selector = '[name="PBE3_PRINT_PDF"]';
            break;
          default:
            // fallback: assume doc is already a button name attribute
            selector = `[name="${doc}"]`;
            console.log('[run] using doc as direct button name:', doc);
        }

        const button = page.locator(selector).first();
        if (!(await button.count())) {
          console.log('[run] selector not found for doc', doc, 'selector:', selector, '- skipping');
          continue;
        }

        const enabled = await button.isEnabled().catch(() => false);
        if (!enabled) {
          console.log('[run] doc button is disabled, skipping', doc, 'selector:', selector);
          continue;
        }

        console.log('[run] downloading', doc, 'for year', year);
        // click the button; it may open a popup with the PDF viewer
        let targetPage = page;
        const [maybePopup] = await Promise.all([
          page.waitForEvent('popup').catch(() => null),
          button.click(),
        ]);
        if (maybePopup) {
          targetPage = maybePopup;
          await targetPage.waitForLoadState('domcontentloaded').catch(() => {});
        }

        const downloadPage = targetPage;
        const filename = `report-${doc}-${year}.pdf`;
        const dlPath = path.join(__dirname, '..', 'downloads', filename);
        fs.mkdirSync(path.dirname(dlPath), { recursive: true });

        // simplified download: rely on network response capture
        let saved = false;
        const pdfRespPromise = downloadPage.waitForResponse(
          r => (r.headers()['content-type'] || '').toLowerCase().includes('application/pdf') || /\.pdf([?#].*)?$/i.test(r.url()),
          { timeout: 10000 }
        ).catch(() => null);

        // click the document button in order to trigger PDF generation
        // (the caller already clicked the main button earlier to open popup)
        const pdfResp = await pdfRespPromise;
        if (pdfResp) {
          const buffer = await pdfResp.body().catch(() => null);
          if (buffer && buffer.length > 0) {
            fs.writeFileSync(dlPath, buffer);
            saved = true;
          }
        }

        // fallback: if popup is a direct PDF
        if (!saved) {
          const currentUrl = downloadPage.url();
          if (/\.pdf([?#].*)?$/i.test(currentUrl)) {
            const response = await context.request.get(currentUrl).catch(() => null);
            if (response && response.ok()) {
              const buffer = await response.body().catch(() => null);
              if (buffer && buffer.length > 0) {
                fs.writeFileSync(dlPath, buffer);
                saved = true;
              }
            }
          }
        }

        if (saved) {
          console.log('[download] saved to', dlPath, '(method=network)');
          result.downloaded = true;
          result.downloadPath = dlPath;
        } else {
          console.warn('[run] no download method succeeded for', doc, year);
        }
        // close popup if we opened one
        if (maybePopup) {
          try { await maybePopup.close(); } catch (e) {}
        }
      }

      // optionally logout between years? keep session open for efficiency
    }

    // logout sequence mimicking original
    await page.click("text=\"Αποσύνδεση\"").catch(() => {});
    await page.goto("https://www1.aade.gr/webtax/incomefp/logout.do", { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.goto("https://login.gsis.gr/oam/server/osso_logout?p_done_url=https://www1.aade.gr:443/taxisnet/mytaxisnet", { waitUntil: 'domcontentloaded' }).catch(() => {});
  } catch (err) {
    result.error = err.message || String(err);
    console.error('[run] encountered error', result.error);
    throw err;
  } finally {
    await browser.close();
  }
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
