'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

/**
 * Script : test
 * Recorded: 2026-03-02
 * @param {string} params.username - username
 * @param {string} params.password - password
 */

async function run(params = {}) {
  const {
    username = "",
    password = "",
  } = params;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    await page.goto("https://www.aade.gr/", { waitUntil: 'domcontentloaded' });
    await page.goto("https://www.aade.gr/mydata", { waitUntil: 'domcontentloaded' });
    await page.goto("https://login.gsis.gr/mylogin/login.jsp?bmctx=1DB55AB50C08F2B418903DE4EB7466AD47038BC455E39B9EA82B1EB28CE52BC6&contextType=external&username=string&password=secure_string&challenge_url=https%3A%2F%2Flogin.gsis.gr%2Fmylogin%2Flogin.jsp&ssoCookie=disablehttponly&request_id=-9213246133743444446&authn_try_count=0&locale=en_US&resource_url=https%253A%252F%252Fwww1.aade.gr%252Fsaadeapps2%252Fbookkeeper-web%252Fbookkeeper%252F#!/bookAggregate", { waitUntil: 'domcontentloaded' });
    await page.click("#username");
    await page.fill("#username", username);
    await page.fill("#password", password);
    await page.goto("https://www1.aade.gr/saadeapps2/bookkeeper-web/bookkeeper/", { waitUntil: 'domcontentloaded' });
    await page.goto("https://www1.aade.gr/saadeapps2/bookkeeper-web/bookkeeper/#!/", { waitUntil: 'domcontentloaded' });
    await page.goto("https://www1.aade.gr/saadeapps2/bookkeeper-web/bookkeeper/#!/bookAggregate", { waitUntil: 'domcontentloaded' });
    await page.click("img");
    await page.goto("https://login.gsis.gr/oam/server/logout?end_url=https://www1.aade.gr:443/saadeapps2/bookkeeper-web", { waitUntil: 'domcontentloaded' });
    await page.goto("https://login.gsis.gr/mylogin/login.jsp?bmctx=1DB55AB50C08F2B418903DE4EB7466AD47038BC455E39B9EA82B1EB28CE52BC6&contextType=external&username=string&password=secure_string&challenge_url=https%3A%2F%2Flogin.gsis.gr%2Fmylogin%2Flogin.jsp&ssoCookie=disablehttponly&request_id=1618402969126207721&authn_try_count=0&locale=en_US&resource_url=https%253A%252F%252Fwww1.aade.gr%252Fsaadeapps2%252Fbookkeeper-web", { waitUntil: 'domcontentloaded' });
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
    // Usage: node script.js --loop '[{"paramName":"value1"},{"paramName":"value2"}]' or any JSON array of parameter objects
    runLoop(JSON.parse(args[1])).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
  } else {
    run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
  }
}

module.exports = { run, runLoop };
