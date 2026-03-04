'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

/**
 * Script : start2
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

  const debug = process.env.DEBUG === '1';
  const pace = parseInt(process.env.PACE || '0', 10);
  if (debug) console.log('[start2] debug enabled pace', pace);
  const browser = await chromium.launch({ headless: true, slowMo: pace });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    // gov.gr front page sometimes returns Access Denied via Cloudflare, so skip
    // directly to the GSIS login endpoint which is where the button would land.
    await page.goto("https://login.gsis.gr/mylogin/login.jsp?bmctx=1DB55AB50C08F2B418903DE4EB7466AD47038BC455E39B9EA82B1EB28CE52BC6&contextType=external&username=string&password=secure_string&challenge_url=https%3A%2F%2Flogin.gsis.gr%2Fmylogin%2Flogin.jsp&ssoCookie=disablehttponly&request_id=-3171065650028371185&authn_try_count=0&locale=en_US&resource_url=https%253A%252F%252Fwww1.aade.gr%252Fsaadeapps3%252Fcomregistry", { waitUntil: 'domcontentloaded' });
    await page.fill("#username", username);
    await page.fill("#password", password);
    await page.click("[name=\"btn_login\"]");
    await page.waitForTimeout(2000);
    const logged = await page.waitForURL('**/saadeapps3/comregistry/**', { timeout: 20000 }).catch(() => null);
    if (!logged) {
      console.log('[start2] login did not redirect, aborting');
      await browser.close();
      return;
    }
    await page.goto("https://www1.aade.gr/saadeapps3/comregistry/", { waitUntil: 'domcontentloaded' });
    await page.goto("https://www1.aade.gr/saadeapps3/comregistry/#!/arxiki", { waitUntil: 'domcontentloaded' });
    await page.click("div.custom-panel-title-small");
    await page.goto("https://www1.aade.gr/saadeapps3/comregistry/#!/vevaiwseismhtrwou", { waitUntil: 'domcontentloaded' });
    await page.click("div.custom-panel-title-small");
    await page.goto("https://www1.aade.gr/saadeapps3/comregistry/#!/mhtrwoepixeirhshs", { waitUntil: 'domcontentloaded' });
    await page.selectOption("#myselect1", "flagsxeseis");
    await page.click("option");
    await page.selectOption("#myselect1", "flagsysxetizomenoiafm");
    await page.click("option");
    await page.selectOption("#myselect1", "flagsxeseis");
    await page.selectOption("#myselect1", "flagsymmetoxesnomikaproswpa");
    await page.click("option");
    await page.selectOption("#myselect1", "flagsxeseis");
    await page.selectOption("#myselect1", "flagsymmetoxesnomikaproswpa");
    await page.selectOption("#myselect1", "flagdrastepix");
    await page.click("option");
    await page.selectOption("#myselect1", "flagdrastepix");
    await page.selectOption("#myselect1", "flagegkeswt");
    await page.click("option");
    await page.selectOption("#myselect1", "flagegkatastaseisexwterikoy");
    await page.click("option");
    await page.selectOption("#myselect1", "flagsxeseis");
    await page.selectOption("#myselect1", "flagedraallodaphs");
    await page.click("option");
    await page.selectOption("#myselect1", "flagsxeseis");
    await page.selectOption("#myselect1", "flagintraremotesalestbe");
    await page.click("option");
    await page.selectOption("#myselect1", "flagsxeseis");
    await page.click("text=\"Έκδοση\"");
    await page.click("a[href=\"blob:https://www1.aade.gr/041ba71c-dc34-4d77-ae83-037c70455f98\"]");
    const [download_37] = await Promise.all([
      page.waitForEvent('download'),
      page.click("[download]"),
    ]);
    const dlPath_37 = path.join(__dirname, '..', 'downloads', 'ektiposi.pdf');
    fs.mkdirSync(path.dirname(dlPath_37), { recursive: true });
    await download_37.saveAs(dlPath_37);
    console.log('[download] saved to', dlPath_37);
    const [download_38] = await Promise.all([
      page.waitForEvent('download'),
      page.click("[download]"),
    ]);
    const dlPath_38 = path.join(__dirname, '..', 'downloads', 'ektiposi.pdf');
    fs.mkdirSync(path.dirname(dlPath_38), { recursive: true });
    await download_38.saveAs(dlPath_38);
    console.log('[download] saved to', dlPath_38);
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
