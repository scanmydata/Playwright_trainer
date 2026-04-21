'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs'); // Import 'fs' module at the top level

  async function logClipboardContent(page) {
    try {
      // Wait for the input field to be present and for it to contain a value.
      const selector = 'input[ng-model="ldapinfo.mail"]';
      await page.waitForSelector(selector, { timeout: 30000 });
      await page.waitForFunction((sel) => {
        const inputElement = document.querySelector(sel);
        return inputElement && inputElement.value && inputElement.value.trim().length > 0;
      }, selector, { timeout: 30000 });

      const clipboardText = await page.evaluate(() => {
        const inputElement = document.querySelector('input[ng-model="ldapinfo.mail"]');
        return inputElement ? inputElement.value : 'Input field not found';
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
 * Script : email-fetch2
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
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    // Start from the AADE registry page to follow the correct redirect/login flow.
    await page.goto("https://www1.aade.gr/saadeapps3/comregistry/#!/mhtrwoepikoinwnias", { waitUntil: 'load' });

    if (page.url().includes('login.gsis.gr')) {
      await page.waitForSelector('#username', { timeout: 30000 });
      await page.fill('#username', username);
      await page.fill('#password', password);
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }).catch(() => {}),
        page.click('button[type=submit]')
      ]);
    }

    // Ensure we are on the communication details page after login.
    await page.goto("https://www1.aade.gr/saadeapps3/comregistry/#!/mhtrwoepikoinwnias", { waitUntil: 'load' });

    const clipboardContent = await logClipboardContent(page);
    console.log('Clipboard Content:', clipboardContent);

    await page.goto("https://login.gsis.gr/oam/server/logout?end_url=https://www1.aade.gr:443/saadeapps3/comregistry", { waitUntil: 'load' });
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
