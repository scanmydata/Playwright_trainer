'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pdf = require('pdf-parse');

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

  // debugging helpers
  const debug = process.env.DEBUG === '1';
  const slowMo = process.env.SLOW_MO !== undefined
    ? parseInt(process.env.SLOW_MO, 10) || 0
    : 600;
  const downloadsDir = path.resolve(__dirname, 'downloads');

  // helpers
  async function safeClick(selector, options = {}) {
    await page.waitForSelector(selector, { state: 'visible', timeout: 15000 });
    const el = page.locator(selector);
    if (!(await el.count())) throw new Error(`safeClick: no element ${selector}`);
    await el.click(options);
    await page.waitForTimeout(slowMo);
  }
  async function safeFill(selector, value, options = {}) {
    const el = page.locator(selector);
    if (!(await el.count())) throw new Error(`safeFill: no element ${selector}`);
    await el.fill(value, options);
    await page.waitForTimeout(slowMo);
  }

  const result = {
    noOblig: false,
    downloaded: false,
    downloadPath: null,
    invalidCreds: false,
    error: null,
  };

  const headless = process.env.PW_HEADLESS === '1';
  const browser = await chromium.launch({ headless, slowMo });
  const context = await browser.newContext({ acceptDownloads: true, downloadsPath: downloadsDir });
  const page = await context.newPage();
  await context.clearCookies();
  await context.clearPermissions();
  await page.goto('https://login.gsis.gr/oam/server/logout?end_url=https://www1.aade.gr/taxisnet/vat/protected/displayDeclarationTypes.htm', { waitUntil: 'domcontentloaded' });
  await page.goto("https://www1.aade.gr/taxisnet/vat/protected/displayDeclarationTypes.htm", { waitUntil: 'domcontentloaded' });

  try {
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
    const seenDownloadKeys = new Set();
    // map quarterKey -> saved file path (when a quarterly PDF was saved)
    const seenQuarterToPath = new Map();
    // map content-hash -> saved file path (session-level cache)
    const seenHashToPath = new Map();
    // map normalized text -> saved file path (session-level cache)
    const seenTextToPath = new Map();

    async function extractNormalizedTextFromBuffer(buf) {
      try {
        const data = await pdf(buf);
        if (!data || !data.text) return '';
        // normalize: lower-case, collapse whitespace, remove extra punctuation
        return String(data.text)
          .replace(/\u00A0/g, ' ')
          .replace(/[\r\n]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
      } catch (e) {
        return '';
      }
    }

    async function findExistingFileByText(normalizedText) {
      if (!normalizedText) return null;
      if (seenTextToPath.has(normalizedText)) return seenTextToPath.get(normalizedText);
      try {
        const dlDir = downloadsDir;
        if (!fs.existsSync(dlDir)) return null;
        const files = fs.readdirSync(dlDir).filter(f => f.endsWith('.pdf'));
        for (const f of files) {
          const p = path.join(dlDir, f);
          try {
            const contents = fs.readFileSync(p);
            const txt = await extractNormalizedTextFromBuffer(contents);
            if (txt && txt === normalizedText) {
              seenTextToPath.set(normalizedText, p);
              return p;
            }
          } catch (e) { /* ignore read/parse errors */ }
        }
      } catch (e) { /* ignore */ }
      return null;
    }

        function findExistingFileByHash(hash, periodKey) {
          try {
            const dlDir = downloadsDir;
            if (!fs.existsSync(dlDir)) return null;
            const files = fs.readdirSync(dlDir).filter(f => f.endsWith('.pdf'));
            for (const f of files) {
              const p = path.join(dlDir, f);
              try {
                const contents = fs.readFileSync(p);
                const h = crypto.createHash('sha1').update(contents).digest('hex');
                if (h === hash) return p;
              } catch (e) { /* ignore read errors */ }
            }
          } catch (e) { /* ignore */ }
          return null;
        }


      // Save a PDF buffer with unified dedupe (hash + normalized text) and
      // mapping updates. Returns { path, existed } where existed=true when an
      // existing file was reused instead of writing a new one.
      async function trySaveBuffer(buffer, fileLabelLocal, periodKeyLocal, popupPeriodKeyLocal, dedupeKeyLocal, isQuarterLocal) {
        try {
          const hash = crypto.createHash('sha1').update(buffer).digest('hex');
          if (seenHashToPath.has(hash)) return { path: seenHashToPath.get(hash), existed: true };
          const existingByHash = findExistingFileByHash(hash, periodKeyLocal);
          if (existingByHash) { seenHashToPath.set(hash, existingByHash); return { path: existingByHash, existed: true }; }
          const txt = await extractNormalizedTextFromBuffer(buffer);
          if (txt && seenTextToPath.has(txt)) return { path: seenTextToPath.get(txt), existed: true };
          if (txt) {
            const existingByText = await findExistingFileByText(txt);
            if (existingByText) { seenTextToPath.set(txt, existingByText); return { path: existingByText, existed: true }; }
          }
          const dlPathLocal = path.join(downloadsDir, `viewPdf-${fileLabelLocal}.pdf`);
          fs.mkdirSync(path.dirname(dlPathLocal), { recursive: true });
          fs.writeFileSync(dlPathLocal, buffer);
          try { seenHashToPath.set(hash, dlPathLocal); if (txt) seenTextToPath.set(txt, dlPathLocal); if (isQuarterLocal) seenQuarterToPath.set(periodKeyLocal, dlPathLocal); if (popupPeriodKeyLocal && String(popupPeriodKeyLocal).startsWith('quarterly-')) seenQuarterToPath.set(popupPeriodKeyLocal, dlPathLocal); } catch (e) {}
          return { path: dlPathLocal, existed: false };
        } catch (e) {
          return { path: null, existed: false };
        }
      }
    function parseDateDMY(value) {
      if (!value) return null;
      const [d, m, y] = String(value).split('/').map(Number);
      if (!d || !m || !y) return null;
      return new Date(y, m - 1, d);
    }

    function findExistingFileByDecl(declNum) {
      if (!declNum) return null;
      try {
        const dlDir = downloadsDir;
        if (!fs.existsSync(dlDir)) return null;
        const files = fs.readdirSync(dlDir).filter(f => f.endsWith('.pdf'));
        const re = new RegExp(`(?:\\b|-)${declNum}(?:\\b|-)`);
        for (const f of files) {
          if (re.test(f)) return path.join(dlDir, f);
        }
      } catch (e) { /* ignore */ }
      return null;
    }

    function extractDeclNumber(text) {
      if (!text) return null;
      const s = String(text);
      // prefer explicit labeled declaration numbers with 3-6 digits
      const labelled = s.match(/Αριθ(?:μ|μός|μος)\s*(?:Δηλώσης|Δήλωσης|Δηλ\.|Δηλ)?\s*[:\-\s]*([0-9]{3,6})/i)
        || s.match(/ΑΡΙΘΜΟΣ\s*ΔΗΛΩΣΗΣ\s*[:\-\s]*([0-9]{3,6})/i)
        || s.match(/Αρ\.?\s*Δηλ(?:\.)?\s*[:\-\s]*([0-9]{3,6})/i);
      if (labelled && labelled[1]) return String(Number(labelled[1]));

      // otherwise look for any 3-6 digit standalone number (likely a decl num)
      const cand = s.match(/\b(\d{3,6})\b/g) || [];
      for (const c of cand) {
        const nRaw = c;
        const n = String(Number(c));
        const nInt = Number(n);
        // skip obvious year values (1900-2099) and the requested tax year
        if ((nRaw.length === 4 && nInt >= 1900 && nInt <= 2099) || nInt === Number(year)) continue;
        return n;
      }

      // last-resort: allow shorter labeled numbers but require explicit label
      const shortLabel = s.match(/Αριθ(?:μ|μός|μος)\s*(?:Δηλώσης|Δήλωσης)\s*[:\-\s]*([0-9]{1,2})/i);
      if (shortLabel && shortLabel[1]) return String(Number(shortLabel[1]));
      return null;
    }

    function getFileLabelFromPeriod(startStr, endStr, fallbackLabel) {
      const startDate = parseDateDMY(startStr);
      const endDate = parseDateDMY(endStr);
      if (!startDate || !endDate) return fallbackLabel;
      // Prefer exact quarter-end day matching to classify true quarterly
      // declarations. Use the explicit quarter-end days provided by the
      // user: 31/03, 30/31/07, 30/31/10, 31/12. If the range end matches
      // one of these canonical quarter ends, treat it as that quarter.
      const endDay = endDate.getDate();
      const endMonth = endDate.getMonth() + 1;
      const quarterEnds = {
        3: [31],        // Q1 ends 31/03
        7: [30, 31],    // Q2 acceptable ends 30/07 or 31/07
        10: [30, 31],   // Q3 acceptable ends 30/10 or 31/10
        12: [31],       // Q4 ends 31/12
      };
      if (quarterEnds[endMonth] && quarterEnds[endMonth].includes(endDay)) {
        let q = 1;
        if (endMonth === 3) q = 1;
        else if (endMonth === 7) q = 2;
        else if (endMonth === 10) q = 3;
        else if (endMonth === 12) q = 4;
        return `quarterly-${endDate.getFullYear()}-Q${q}`;
      }

      // Fallback heuristic: treat long ranges as quarterly, otherwise monthly
      const dayDiff = Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
      if (dayDiff >= 70) {
        const q = Math.floor(startDate.getMonth() / 3) + 1;
        return `quarterly-${startDate.getFullYear()}-Q${q}`;
      }
      const month = String(startDate.getMonth() + 1).padStart(2, '0');
      return `monthly-${startDate.getFullYear()}-${month}`;
    }

    function normalizePeriodLabelFromText(pageText = '') {
      const fiscalLineMatch = String(pageText).match(/Φορολογική\s+Περίοδος\s*:\s*([^\n\r]+)/i);
      if (!fiscalLineMatch) return null;
      const raw = fiscalLineMatch[1].trim();

      const quarterMatch = raw.match(/(\d+)\S*\s+Τρίμηνο\s+(\d{4})/i);
      if (quarterMatch) {
        const quarter = parseInt(quarterMatch[1], 10);
        const fiscalYear = parseInt(quarterMatch[2], 10);
        if (quarter >= 1 && quarter <= 4 && fiscalYear) {
          return `quarterly-${fiscalYear}-Q${quarter}`;
        }
      }

      const monthMatch = raw.match(/(\d+)\S*\s+Μήνας\s+(\d{4})/i);
      if (monthMatch) {
        const month = parseInt(monthMatch[1], 10);
        const fiscalYear = parseInt(monthMatch[2], 10);
        if (month >= 1 && month <= 12 && fiscalYear) {
          return `monthly-${fiscalYear}-${String(month).padStart(2, '0')}`;
        }
      }

      // fallback: try to parse the Ημερολογιακή Περίοδος (calendar range)
      // and decide monthly vs quarterly by inclusive month count.
      const calMatch = String(pageText).match(/Ημερολογιακή\s+Περίοδος\s*:\s*([0-3]\d\/\d{2}\/\d{4})\s*-\s*([0-3]\d\/\d{2}\/\d{4})/i);
      if (calMatch) {
        const start = calMatch[1];
        const end = calMatch[2];
        const p = (s) => s.split('/').map(Number); // [dd,mm,yyyy]
        const [sd, sm, sy] = p(start);
        const [ed, em, ey] = p(end);
        if (sd && sm && sy && ed && em && ey) {
          // inclusive months count
          const monthsInclusive = (ey - sy) * 12 + (em - sm) + 1;
          if (monthsInclusive > 1) {
            const q = Math.floor((sm - 1) / 3) + 1;
            return `quarterly-${sy}-Q${q}`;
          } else {
            return `monthly-${sy}-${String(sm).padStart(2, '0')}`;
          }
        }
      }

      return null;
    }

    // helper to process one period value and return its result object
    // `attempt` is used to retry once when a period seems empty but might
    // surface on a second try (the portal can be flaky).
    async function processPeriod(val, attempt = 1) {
      // human-readable period label for logging
      const isRangeMonth = typeof val === 'object' && val.year && val.month;
      const label = isRangeMonth
        ? `${val.year}-${String(val.month).padStart(2,'0')}`
        : String(val);
      const fallbackFileLabel = isRangeMonth
        ? `monthly-${val.year}-${String(val.month).padStart(2,'0')}`
        : (periodType === 'oneMonth'
          ? `monthly-${year}-${String(val).padStart(2,'0')}`
          : `quarterly-${year}-Q${val}`);
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
      const res = { ...result, noOblig: false, downloaded: false, downloadPath: null, invalidCreds: false, error: null, usedQuarter: false };
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
      // always start from the latest declaration entry (last "Προβολή")
      let popup;
      let resolvedPeriodStart = periodStart;
      let resolvedPeriodEnd = periodEnd;
      let periodKeyFromRow = null;
      let declSuffix = 'decl';
      let declNumber = null;
      let selectedRowText = '';

      const previews = page.locator('text="Προβολή"');
      const count = await previews.count();
      if (count === 0) {
        console.log('[run] no Προβολή buttons for period', label, 'body text:', bodyText.slice(0,1500));
        throw new Error('No Προβολή button found');
      }

      const target = previews.nth(count - 1);
      const targetRow = target.locator('xpath=ancestor::tr[1]').first();
      selectedRowText = await targetRow.innerText().catch(() => '');

      // extract declaration number from the selected row cells
      try {
        const cells = targetRow.locator('td');
        const cellCount = await cells.count();
        for (let ci = 0; ci < cellCount; ci++) {
          const ct = (await cells.nth(ci).innerText().catch(() => '')).trim();
          const m = ct.match(/^\s*(\d{3,6})\s*$/);
          if (m && m[1]) {
            declNumber = String(Number(m[1]));
            break;
          }
          const lm = ct.match(/Αριθ(?:μ|μός|μος)\s*[:\-\s]*(\d{1,6})/i);
          if (lm && lm[1]) {
            declNumber = String(Number(lm[1]));
            break;
          }
        }
      } catch (e) { /* ignore */ }

      const rowDates = selectedRowText.match(/\b\d{2}\/\d{2}\/\d{4}\b/g) || [];
      if (rowDates.length >= 2) {
        resolvedPeriodStart = rowDates[0];
        resolvedPeriodEnd = rowDates[1];
      }

      periodKeyFromRow = normalizePeriodLabelFromText(selectedRowText) || null;
      if (/Τροποποι/i.test(selectedRowText)) declSuffix = 'amend';
      else if (/Αρχικ/i.test(selectedRowText)) declSuffix = 'orig';

      const [p] = await Promise.all([
        page.waitForEvent('popup'),
        target.click(),
      ]);
      popup = p;
      await popup.waitForLoadState('domcontentloaded');
      // capture popup text once and extract decl number + any popup-derived period
      let popupTextFull = '';
      let popupPeriodKey = null;
      try {
        popupTextFull = await popup.evaluate(() => document.body.innerText || '').catch(() => '');
        declNumber = declNumber || extractDeclNumber(selectedRowText || popupTextFull || '');
        popupPeriodKey = normalizePeriodLabelFromText(popupTextFull) || null;
        if (popupPeriodKey && String(popupPeriodKey).startsWith('quarterly-')) {
          periodKeyFromRow = popupPeriodKey;
          if (isRangeMonth || periodType === 'oneMonth') res.usedQuarter = true;
        }
      } catch (e) { declNumber = null; popupTextFull = ''; popupPeriodKey = null; }

      const dateDerivedLabel = getFileLabelFromPeriod(resolvedPeriodStart, resolvedPeriodEnd, fallbackFileLabel);
      let periodKey = periodKeyFromRow || dateDerivedLabel;
      // If a quarterly period was detected while iterating months, defer
      // saving until the quarter's last month (user requested "keep the
      // last month of the quarter"). When we hit the last month we will
      // save the quarterly PDF under that month's label (monthly-YYYY-MM)
      // and still map the quarter key to the saved file.
      const isQuarter = String(periodKey).startsWith('quarterly-');
      const requestWasMonth = isRangeMonth || periodType === 'oneMonth';
      let deferQuarterSave = false;
      let useMonthlyLabelForQuarterSave = false;
      if (isQuarter && requestWasMonth) {
        // derive quarter number and the nominal last-month for that quarter
        const qm = String(periodKey).match(/quarterly-(\d{4})-Q(\d)/);
        if (qm) {
          const qnum = Number(qm[2]);
          const quarterLastMonthMap = { 1: 3, 2: 7, 3: 10, 4: 12 };
          const quarterLastMonth = quarterLastMonthMap[qnum];
          // Always save the quarterly PDF once and name it using the
          // quarter's last-month label (user requested keeping the last
          // month of the quarter). This ensures we only write one file
          // per quarter even when iterating month-by-month.
          periodKey = `monthly-${qm[1]}-${String(quarterLastMonth).padStart(2,'0')}`;
          useMonthlyLabelForQuarterSave = true;
        }
      }
      // prefer using declaration number for naming/dedupe when available
      const fileLabel = declNumber ? `decl-${declNumber}-${periodKey}-${declSuffix}` : `${periodKey}-${declSuffix}`;

      console.log('[run] periodKey:', periodKey, 'fileLabel:', fileLabel, 'resolvedRange:', resolvedPeriodStart, '-', resolvedPeriodEnd, 'requested:', label);
      if (periodKeyFromRow) console.log('[run] periodKey derived from row text');
      if (isQuarter && requestWasMonth) res.usedQuarter = true;

        // if the declaration number is available, use it as the global dedupe key
        let declDedupeKey = null;
        if (declNumber) declDedupeKey = `decl-${declNumber}`;
        const dedupeKey = declDedupeKey || (isQuarter ? periodKey : fileLabel);

        // if a file for this declaration already exists (filename contains the
        // declaration number), reuse it and skip downloading
        if (declNumber) {
          const existingByDecl = findExistingFileByDecl(declNumber);
          if (existingByDecl) {
            console.log('[run] declaration already saved (by decl#):', declNumber, existingByDecl);
            res.downloaded = true;
            res.downloadPath = existingByDecl;
            // map quarter if the existing filename indicates a quarterly PDF
            try { if (/quarterly-\d{4}-Q\d/.test(existingByDecl)) seenQuarterToPath.set(periodKey, existingByDecl); } catch (e) {}
            seenDownloadKeys.add(dedupeKey);
            return res;
          }
        }

        // compute the quarter key corresponding to the requested month (when
        // operating in month-by-month/range mode). This lets us avoid saving a
        // monthly file when a quarterly PDF for the same quarter was already
        // saved earlier in the session.
        let requestedQuarterKey = null;
        try {
          if (isRangeMonth) {
            const q = Math.floor((val.month - 1) / 3) + 1;
            requestedQuarterKey = `quarterly-${val.year}-Q${q}`;
          } else if (periodType === 'oneMonth') {
            const m = Number(val);
            const q = Math.floor((m - 1) / 3) + 1;
            requestedQuarterKey = `quarterly-${year}-Q${q}`;
          } else if (periodType === 'threeMonths') {
            // requested is already a quarter
            requestedQuarterKey = `quarterly-${year}-Q${val}`;
          }
        } catch (e) { /* ignore */ }

        // If we've already saved a quarterly PDF for this quarter, skip
        // downloading again and mark that we used the quarter for this month.
        if (requestedQuarterKey && seenQuarterToPath.has(requestedQuarterKey)) {
          console.log('[run] quarter already saved for', requestedQuarterKey, '- skipping period', label);
          res.downloaded = true;
          res.downloadPath = seenQuarterToPath.get(requestedQuarterKey);
          res.usedQuarter = true;
          // ensure we also treat the dedupe key as seen
          seenDownloadKeys.add(dedupeKey);
          return res;
        }

        // If we detected a quarterly declaration on a non-final month of the
        // quarter, defer saving until the quarter's final month.
        if (deferQuarterSave) {
          console.log('[run] quarterly declaration detected but deferring save until quarter-end for', label);
          res.noOblig = false;
          res.downloaded = false;
          res.downloadPath = null;
          res.usedQuarter = true;
          try { await popup.close(); } catch (e) {}
          return res;
        }

        if (seenDownloadKeys.has(dedupeKey)) {
          console.log('[run] duplicate declaration detected, skipping', dedupeKey, 'for requested period', label);
          return res;
        }

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
        const hash = crypto.createHash('sha1').update(buffer).digest('hex');
        if (seenHashToPath.has(hash)) {
          const existing = seenHashToPath.get(hash);
          console.log('[download] identical file already exists (session):', existing);
          res.downloaded = true;
          res.downloadPath = existing;
          try { const qm = path.basename(existing).match(/quarterly-\d{4}-Q\d/); if (qm) seenQuarterToPath.set(qm[0], existing); } catch (e) {}
          // also map by popup-derived quarter if available
          try { if (popupPeriodKey && popupPeriodKey.startsWith('quarterly-')) seenQuarterToPath.set(popupPeriodKey, existing); } catch (e) {}
          seenDownloadKeys.add(dedupeKey);
          return res;
        }
        const existing = findExistingFileByHash(hash, periodKey);
        if (existing) {
          console.log('[download] identical file already exists:', existing);
          res.downloaded = true;
          res.downloadPath = existing;
          seenHashToPath.set(hash, existing);
          try { const qm = path.basename(existing).match(/quarterly-\d{4}-Q\d/); if (qm) seenQuarterToPath.set(qm[0], existing); } catch (e) {}
          try { if (popupPeriodKey && popupPeriodKey.startsWith('quarterly-')) seenQuarterToPath.set(popupPeriodKey, existing); } catch (e) {}
          seenDownloadKeys.add(dedupeKey);
          return res;
        }
        seenDownloadKeys.add(dedupeKey);
        const saveResult = await trySaveBuffer(buffer, fileLabel, periodKey, popupPeriodKey, dedupeKey, isQuarter);
        if (saveResult && saveResult.existed) {
          console.log('[download] identical file already exists (save helper):', saveResult.path);
          res.downloaded = true;
          res.downloadPath = saveResult.path;
          seenDownloadKeys.add(dedupeKey);
          return res;
        }
        if (saveResult && saveResult.path) {
          console.log('[download] saved to', saveResult.path);
          res.downloaded = true;
          res.downloadPath = saveResult.path;
          seenDownloadKeys.add(fileLabel);
          return res;
        }
      }

      const downloadSelector = 'a[download], button[download], a:has-text("Λήψη"), a:has-text("Download"), button:has-text("Download")';
      const dlBtn = popup.locator(downloadSelector).first();
      if (await dlBtn.count()) {
        const [download] = await Promise.all([
          popup.waitForEvent('download'),
          dlBtn.click(),
        ]);
        // try to capture bytes from the download to compute hash before saving
        const tempBuf = await download.createReadStream().then(async (s) => {
          const chunks = [];
          for await (const chunk of s) chunks.push(chunk);
          return Buffer.concat(chunks);
        }).catch(() => null);
          if (tempBuf) {
          const saveResult = await trySaveBuffer(tempBuf, fileLabel, periodKey, popupPeriodKey, dedupeKey, isQuarter);
          if (saveResult && saveResult.existed) {
            console.log('[download] identical file already exists (save helper):', saveResult.path);
            res.downloaded = true;
            res.downloadPath = saveResult.path;
            seenDownloadKeys.add(dedupeKey);
            return res;
          }
          if (saveResult && saveResult.path) {
            console.log('[download] saved to', saveResult.path);
            res.downloaded = true;
            res.downloadPath = saveResult.path;
            seenDownloadKeys.add(dedupeKey);
            return res;
          }
        }
        const dlPath = path.join(downloadsDir, `viewPdf-${fileLabel}.pdf`);
        fs.mkdirSync(path.dirname(dlPath), { recursive: true });
        if (tempBuf) {
          fs.writeFileSync(dlPath, tempBuf);
        } else {
          await download.saveAs(dlPath);
        }
        // update session-level mappings (hash, text, quarter) after save
        try {
          const contentBuf = tempBuf || fs.readFileSync(dlPath);
          const h = crypto.createHash('sha1').update(contentBuf).digest('hex');
          seenHashToPath.set(h, dlPath);
          try { const txt = await extractNormalizedTextFromBuffer(contentBuf); if (txt) seenTextToPath.set(txt, dlPath); } catch (e) {}
          if (isQuarter) seenQuarterToPath.set(periodKey, dlPath);
          if (popupPeriodKey && String(popupPeriodKey).startsWith('quarterly-')) seenQuarterToPath.set(popupPeriodKey, dlPath);
        } catch (e) {}
        console.log('[download] saved to', dlPath);
        res.downloaded = true;
        res.downloadPath = dlPath;
        seenDownloadKeys.add(dedupeKey);
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
          // attempt to read download into buffer to dedupe
            const tempBuf = await download.createReadStream().then(async (s) => {
              const chunks = [];
              for await (const chunk of s) chunks.push(chunk);
              return Buffer.concat(chunks);
            }).catch(() => null);
            if (tempBuf) {
              const saveResult = await trySaveBuffer(tempBuf, fileLabel, periodKey, popupPeriodKey, dedupeKey, isQuarter);
              if (saveResult && saveResult.existed) {
                console.log('[download] identical file already exists (save helper):', saveResult.path);
                res.downloaded = true;
                res.downloadPath = saveResult.path;
                seenDownloadKeys.add(dedupeKey);
                return res;
              }
              if (saveResult && saveResult.path) {
                console.log('[download] saved to', saveResult.path);
                res.downloaded = true;
                res.downloadPath = saveResult.path;
                seenDownloadKeys.add(dedupeKey);
                return res;
              }
            }
            const dlPath = path.join(downloadsDir, `viewPdf-${fileLabel}.pdf`);
            fs.mkdirSync(path.dirname(dlPath), { recursive: true });
            if (tempBuf) fs.writeFileSync(dlPath, tempBuf); else await download.saveAs(dlPath);
            try {
              const contentBuf = tempBuf || fs.readFileSync(dlPath);
              const h = crypto.createHash('sha1').update(contentBuf).digest('hex');
              seenHashToPath.set(h, dlPath);
              try { const txt = await extractNormalizedTextFromBuffer(contentBuf); if (txt) seenTextToPath.set(txt, dlPath); } catch (e) {}
              if (isQuarter) seenQuarterToPath.set(periodKey, dlPath);
              if (popupPeriodKey && String(popupPeriodKey).startsWith('quarterly-')) seenQuarterToPath.set(popupPeriodKey, dlPath);
            } catch (e) {}
            console.log('[download] saved to', dlPath);
            res.downloaded = true;
            res.downloadPath = dlPath;
            seenDownloadKeys.add(dedupeKey);
            return res;
        } else {
          // no URL and no download event – may be portal hiccup. retry once.
          console.log('[run] no pdf URL or download event for', label, 'attempt', attempt);
          if (attempt < 2) {
            console.log('[run] retrying period', label, 'after reload');
            await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
            // ensure session still valid
            if (await page.locator('#username').count()) {
              throw new Error('Session expired when retrying period ' + label);
            }
            return processPeriod(val, attempt + 1);
          }
          res.noOblig = true;
          return res;
        }
      }
      if (!pdfUrl) {
        // should not reach here but guard anyway
        res.noOblig = true;
        return res;
      }
      const response = await context.request.get(pdfUrl);
      let buffer;
      try {
        buffer = await response.body();
      } catch (e) {
        console.warn('[run] failed to read response body:', e.message || e);
        // treat as non-existent PDF
        res.noOblig = true;
        return res;
      }
      const hash = crypto.createHash('sha1').update(buffer).digest('hex');
      if (seenHashToPath.has(hash)) {
        const existing = seenHashToPath.get(hash);
        console.log('[download] identical file already exists (session):', existing);
        res.downloaded = true;
        res.downloadPath = existing;
        seenDownloadKeys.add(dedupeKey);
        return res;
      }
      const existing = findExistingFileByHash(hash, periodKey);
      if (existing) {
        console.log('[download] identical file already exists:', existing);
        res.downloaded = true;
        res.downloadPath = existing;
        seenHashToPath.set(hash, existing);
        seenDownloadKeys.add(dedupeKey);
        return res;
      }
      // text-based dedupe for fetched PDF
      try {
        const txt = await extractNormalizedTextFromBuffer(buffer);
        if (txt) {
          const existingText = await findExistingFileByText(txt);
          if (existingText) {
            console.log('[download] identical-by-text file already exists:', existingText);
            res.downloaded = true;
            res.downloadPath = existingText;
            seenTextToPath.set(txt, existingText);
            seenDownloadKeys.add(dedupeKey);
            return res;
          }
        }
      } catch (e) {}
      const dlPath = path.join(downloadsDir, `viewPdf-${fileLabel}.pdf`);
      fs.mkdirSync(path.dirname(dlPath), { recursive: true });
      const saveResult = await trySaveBuffer(buffer, fileLabel, periodKey, popupPeriodKey, dedupeKey, isQuarter);
      if (saveResult && saveResult.existed) {
        console.log('[download] identical file already exists (save helper):', saveResult.path);
        res.downloaded = true;
        res.downloadPath = saveResult.path;
        seenDownloadKeys.add(dedupeKey);
        return res;
      }
      if (saveResult && saveResult.path) {
        console.log('[download] saved to', saveResult.path);
        res.downloaded = true;
        res.downloadPath = saveResult.path;
        try { /* mappings updated in helper */ } catch (e) {}
        seenDownloadKeys.add(fileLabel);
        seenDownloadKeys.add(dedupeKey);
        return res;
      }
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
  // support --params and --loop regardless of their position (handles stray backslashes or wrappers)
  const loopIndex = args.indexOf('--loop');
  const paramsIndex = args.indexOf('--params');
  if (loopIndex !== -1 && args[loopIndex + 1]) {
    try {
      const parsed = JSON.parse(args[loopIndex + 1]);
      runLoop(parsed).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
    } catch (e) {
      console.error('[run] could not parse --loop JSON:', e.message || e);
      process.exit(1);
    }
  } else if (paramsIndex !== -1 && args[paramsIndex + 1]) {
    try {
      const parsed = JSON.parse(args[paramsIndex + 1]);
      run(parsed)
        .then(res => {
          console.log('[run] result', JSON.stringify(res));
          process.exit(0);
        })
        .catch(e => { console.error(e); process.exit(1); });
    } catch (e) {
      console.error('[run] could not parse --params JSON:', e.message || e);
      process.exit(1);
    }
  } else {
    // no params provided; run interactive/default mode
    run()
      .then(res => {
        console.log('[run] result', JSON.stringify(res));
        process.exit(0);
      })
      .catch(e => { console.error(e); process.exit(1); });
  }
}

module.exports = { run, runLoop };
