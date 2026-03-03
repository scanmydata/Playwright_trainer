'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

/**
 * Script : suppl
 * Recorded: 2026-03-03
 * @param {string} params.username - username
 * @param {string} params.password - password
 */

async function run(params = {}) {
  const {
    username = "",
    password = "",
    periodType = "oneMonth",
    month = "",
    quarter = "",
  } = params;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    await page.goto("https://www.aade.gr/dilosi-forologias-eisodimatos-fp-e1-e2-e3", { waitUntil: 'domcontentloaded' });
    await page.click("[aria-label=\"Είσοδος στην Εφαρμογή - ανοίξτε σε νέα καρτέλα\"]");
    await page.click("#username");
    await page.fill("#username", username);
    await page.fill("#password", password);
    await page.click("[name=\"btn_login\"]");
    await page.goto("https://www1.aade.gr/webtax/incomefp/year2025/income/e1/index.jsp;JSESSIONID-WEBTAX=ggmGpnXhJQpSVwhfQFC5YzQFVYQ7GtJns01vRPD1zBGpGB6v0vxp!791222248", { waitUntil: 'domcontentloaded' });
    await page.click("[name=\"PB_EKKATH_PDF_SYZ\"]");
    await page.goto("https://www1.aade.gr/webtax/incomefp/login.done", { waitUntil: 'domcontentloaded' });
  } finally {
    await browser.close();
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
    await run(p);
    results.push({ params: p, ok: true });
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
    run(JSON.parse(args[1])).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
  } else {
    run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
  }
}

module.exports = { run, runLoop };
