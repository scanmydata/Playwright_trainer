'use strict';
const { chromium } = require('playwright');

async function run(params = {}) {
  const { username = 'alice', password } = params;
  const browser = await chromium.launch();
  await browser.close();
}

module.exports = { run };
