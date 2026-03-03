'use strict';

/**
 * Convert an array of recorded actions into a runnable Playwright script.
 *
 * @param {Array}  actions    - Recorded action objects
 * @param {object} options
 * @param {string} options.name        - Human-readable script name
 * @param {Array}  options.params      - Parameter definitions [{name, defaultValue, sensitive}]
 * @returns {string} Generated JavaScript source code
 */
function actionsToScript(actions, options = {}) {
  const { name = 'recorded_script', params = [] } = options;
  // params may include extra fields like `selector` or `selectors` used for mapping

  const cleaned = cleanActions(actions);
  const paramBlock = buildParamBlock(params, cleaned);
  // if we detect a direct "displayDeclarationsList" URL we will turn it into a
  // computed-period block when generating code
  const hasDynamicPeriod = cleaned.some(a =>
    a.type === 'goto' && /displayDeclarationsList\.htm/.test(a.url || '')
  );

  const actionLines = cleaned
    .map((a, i) => actionToCode(a, params, i, hasDynamicPeriod))
    .filter(Boolean);

  // ensure tax-period params exist (safe to add even if unused)
  const extraParams = [
    { name: 'periodType', defaultValue: 'oneMonth', description: 'oneMonth or threeMonths' },
    { name: 'month', defaultValue: '', description: '1-12; required if periodType===oneMonth' },
    { name: 'quarter', defaultValue: '', description: '1-4; required if periodType===threeMonths' },
  ];
  const allParams = params.concat(extraParams);
  const paramDestructure = allParams.length
    ? `  const {\n${allParams.map(p => `    ${p.name} = ${JSON.stringify(p.defaultValue ?? '')}`).join(',\n')},\n  } = params;\n`
    : '';

  return `'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

/**
 * Script : ${name}
 * Recorded: ${new Date().toISOString().split('T')[0]}
${paramBlock}
 */

async function run(params = {}) {
${paramDestructure}
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    ${actionLines.join('\n    ')}
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
`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clean & deduplicate a raw action list.
 * Fill actions for the same selector are merged: the first occurrence keeps its
 * position in the sequence but its value is updated to the last recorded value.
 */
function cleanActions(actions) {
  // Pre-compute the final value for each fill selector
  const lastFillValue = new Map();
  for (const a of actions) {
    if (a.type === 'fill') lastFillValue.set(a.selector, a.value);
  }

  const out = [];
  const seenFillSelectors = new Set();

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];

    if (a.type === 'fill') {
      if (seenFillSelectors.has(a.selector)) continue; // skip later duplicates
      seenFillSelectors.add(a.selector);
      // Use the final value for this selector
      out.push({ ...a, value: lastFillValue.get(a.selector) });
      continue;
    }

    // Deduplicate consecutive identical navigations
    if (a.type === 'goto') {
      const last = out[out.length - 1];
      if (last && last.type === 'goto' && last.url === a.url) continue;
    }

    // Drop internal about:blank navigations
    if (a.type === 'goto' && (!a.url || a.url === 'about:blank')) continue;

    out.push({ ...a });
  }
  return out;
}

/**
 * Build the JSDoc @param block for the script header.
 */
function buildParamBlock(params, actions) {
  if (!params.length) return ' * No parameters defined.';
  return params
    .map(p => ` * @param {string} params.${p.name} - ${p.description || p.name}${p.sensitive ? ' (sensitive)' : ''}`)
    .join('\n');
}

/**
 * Translate a single action to a Playwright code line.
 */
function actionToCode(action, params = [], index = 0, hasDynamicPeriod = false) {
  // find a parameter by its default value
  const paramByValue = (value) => {
    const hit = params.find(p => p.defaultValue === value);
    return hit ? hit.name : null;
  };

  // find a parameter that corresponds to a selector (or one of multiple selectors)
  const paramBySelector = (selector) => {
    const hit = params.find(p => {
      if (p.selector && p.selector === selector) return true;
      if (p.selectors && Array.isArray(p.selectors) && p.selectors.includes(selector)) return true;
      return false;
    });
    return hit ? hit.name : null;
  };

  const valueExpr = (action) => {
    // selector-based parameters take precedence
    if (action.selector) {
      const ps = paramBySelector(action.selector);
      if (ps) return ps;
    }
    const pn = paramByValue(action.value);
    return pn ? pn : JSON.stringify(action.value);
  };

  switch (action.type) {
    case 'goto':
      if (hasDynamicPeriod && /displayDeclarationsList\.htm/.test(action.url || '')) {
        // replace recorded link with parameter-driven calculation
        return `// recorded declaration-list URL replaced with dynamic period logic
` +
`    const periodType = params.periodType || 'oneMonth';
` +
`    let periodStart = '';
` +
`    let periodEnd = '';
` +
`    function pad(n) { return n < 10 ? '0' + n : '' + n; }
` +
`    if (periodType === 'oneMonth') {
` +
`      const m = parseInt(params.month, 10);
` +
`      if (!m || m < 1 || m > 12) {
` +
`        throw new Error('For oneMonth period you must pass params.month (1-12)');
` +
`      }
` +
`      const lastDay = new Date(params.year, m, 0).getDate();
` +
`      periodStart = \`01/\${pad(m)}/\${params.year}\`;
` +
`      periodEnd = \`\${lastDay}/\${pad(m)}/\${params.year}\`;
` +
`    } else if (periodType === 'threeMonths') {
` +
`      const q = parseInt(params.quarter, 10);
` +
`      if (!q || q < 1 || q > 4) {
` +
`        throw new Error('For threeMonths period you must pass params.quarter (1-4)');
` +
`      }
` +
`      const startMonth = 1 + (q - 1) * 3;
` +
`      const endMonth = startMonth + 2;
` +
`      const lastDay = new Date(params.year, endMonth, 0).getDate();
` +
`      periodStart = \`01/\${pad(startMonth)}/\${params.year}\`;
` +
`      periodEnd = \`\${lastDay}/\${pad(endMonth)}/\${params.year}\`;
` +
`    } else {
` +
`      throw new Error('Unsupported periodType: ' + periodType);
` +
`    }
` +
`    const enc = encodeURIComponent;
` +
`    const listUrl =
` +
`      \`https://www1.aade.gr/taxisnet/vat/protected/displayDeclarationsList.htm\` +
` +
`      \`?declarationType=vatF2&year=\${params.year}\` +
` +
`      \`&periodType=\${periodType}\` +
` +
`      \`&periodStart=\${enc(periodStart)}\` +
` +
`      \`&periodEnd=\${enc(periodEnd)}\` +
` +
`      \`&effectivePeriodStart=\${enc(periodStart)}\` +
` +
`      \`&effectivePeriodEnd=\${enc(periodEnd)}\`;
` +
`    return \`await page.goto(listUrl, { waitUntil: 'domcontentloaded' });\`;
`;
      }
      return `await page.goto(${JSON.stringify(action.url)}, { waitUntil: 'domcontentloaded' });`;

    case 'click':
      return `await page.click(${JSON.stringify(action.selector)});`;

    case 'fill': {
      const val = valueExpr(action);
      return `await page.fill(${JSON.stringify(action.selector)}, ${val});`;
    }

    case 'selectOption': {
      const val = valueExpr(action);
      return `await page.selectOption(${JSON.stringify(action.selector)}, ${val});`;
    }

    case 'check':
      return action.checked
        ? `await page.check(${JSON.stringify(action.selector)});`
        : `await page.uncheck(${JSON.stringify(action.selector)});`;

    case 'download': {
      const savePath = `path.join(__dirname, '..', 'downloads', '${action.filename || 'download_' + index}')`;
      return (
        `const [download_${index}] = await Promise.all([\n` +
        `      page.waitForEvent('download'),\n` +
        `      page.click(${JSON.stringify(action.triggerSelector || action.selector || '[download]')}),\n` +
        `    ]);\n` +
        `    const dlPath_${index} = ${savePath};\n` +
        `    fs.mkdirSync(path.dirname(dlPath_${index}), { recursive: true });\n` +
        `    await download_${index}.saveAs(dlPath_${index});\n` +
        `    console.log('[download] saved to', dlPath_${index});`
      );
    }

    case 'newTab':
      return `// New tab opened – context tracks it automatically`;

    case 'waitForNavigation':
      return `// Navigation to: ${action.url}`;

    default:
      return null;
  }
}

module.exports = { actionsToScript, cleanActions, actionToCode };
