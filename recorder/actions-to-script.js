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

  const cleaned = cleanActions(actions);
  const paramBlock = buildParamBlock(params, cleaned);
  const actionLines = cleaned
    .map((a, i) => actionToCode(a, params, i))
    .filter(Boolean);

  const paramDestructure = params.length
    ? `  const {\n${params.map(p => `    ${p.name} = ${JSON.stringify(p.defaultValue ?? '')}`).join(',\n')},\n  } = params;\n`
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
 * @param {Array} paramsArray - e.g. [{ startDate:'2024-01' }, { startDate:'2024-02' }]
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
    // Usage: node script.js --loop '[{"startDate":"2024-01"},{"startDate":"2024-02"}]'
    runLoop(JSON.parse(args[1])).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
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
 */
function cleanActions(actions) {
  const out = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];

    // Merge consecutive fills on the same selector (keep latest value)
    if (a.type === 'fill') {
      const last = out[out.length - 1];
      if (last && last.type === 'fill' && last.selector === a.selector) {
        last.value = a.value;
        continue;
      }
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
function actionToCode(action, params = [], index = 0) {
  const paramName = (value) => {
    const hit = params.find(p => p.defaultValue === value);
    return hit ? hit.name : null;
  };

  const valueExpr = (value) => {
    const pn = paramName(value);
    return pn ? pn : JSON.stringify(value);
  };

  switch (action.type) {
    case 'goto':
      return `await page.goto(${JSON.stringify(action.url)}, { waitUntil: 'domcontentloaded' });`;

    case 'click':
      return `await page.click(${JSON.stringify(action.selector)});`;

    case 'fill': {
      const val = valueExpr(action.value);
      return `await page.fill(${JSON.stringify(action.selector)}, ${val});`;
    }

    case 'selectOption': {
      const val = valueExpr(action.value);
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
