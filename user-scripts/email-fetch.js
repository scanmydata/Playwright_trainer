'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs'); // Import 'fs' module at the top level

  async function logClipboardContent(page) {
    try {
      const clipboardText = await page.evaluate(() => {
        return navigator.clipboard ? navigator.clipboard.readText() : 'Clipboard API not supported';
      });

      console.log('[clipboard]: ' + clipboardText);
      return clipboardText;
    } catch (error) {
      console.error('Error reading clipboard:', error);
      return null;
    }
  }

  // Export the function for use in other modules
  module.exports = { logClipboardContent };

/**
 * Script : email-fetch
 * Recorded: 2026-04-21
 * @param {string} params.username - username
 * @param {string} params.password - password
 */

async function run(params = {}) {
  const {
    username = "",
    password = ""
  } = params;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
    acceptDownloads: true
  });
  const page = await context.newPage();

  try {
    await page.goto("https://www.gov.gr/upourgeia/oloi-foreis/anexartete-arkhe-demosion-esodon-aade/bebaiose-phorologikou-metroou", { waitUntil: 'domcontentloaded' });
    await page.goto("https://login.gsis.gr/mylogin/login.jsp?bmctx=1DB55AB50C08F2B418903DE4EB7466AD47038BC455E39B9EA82B1EB28CE52BC6&contextType=external&username=string&password=secure_string&challenge_url=https%3A%2F%2Flogin.gsis.gr%2Fmylogin%2Flogin.jsp&ssoCookie=disablehttponly&request_id=-8191462219936258276&authn_try_count=0&locale=en_US&resource_url=https%253A%252F%252Fwww1.aade.gr%252Fsaadeapps3%252Fcomregistry", { waitUntil: 'domcontentloaded' });
    await page.fill("#username", username);
    await page.fill("#password", password);
    await page.goto("https://www1.aade.gr/saadeapps3/comregistry/", { waitUntil: 'domcontentloaded' });
    await page.goto("https://www1.aade.gr/saadeapps3/comregistry/#!/arxiki", { waitUntil: 'domcontentloaded' });
    await page.goto("https://www1.aade.gr/saadeapps3/comregistry/#!/mhtrwoepikoinwnias", { waitUntil: 'domcontentloaded' });

    // Call logClipboardContent after navigation is complete
    const clipboardContent = await logClipboardContent(page);
    console.log('Clipboard Content:', clipboardContent);

    await page.goto("https://login.gsis.gr/oam/server/logout?end_url=https://www1.aade.gr:443/saadeapps3/comregistry", { waitUntil: 'domcontentloaded' });
    await page.goto("https://login.gsis.gr/mylogin/login.jsp?bmctx=1DB55AB50C08F2B418903DE4EB7466AD47038BC455E39B9EA82B1EB28CE52BC6&contextType=external&username=string&password=secure_string&challenge_url=https%3A%2F%2Flogin.gsis.gr%2Fmylogin%2Flogin.jsp&ssoCookie=disablehttponly&request_id=1066311961768158945&authn_try_count=0&locale=en_US&resource_url=https%253A%252F%252Fwww1.aade.gr%252Fsaadeapps3%252Fcomregistry", { waitUntil: 'domcontentloaded' });
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
