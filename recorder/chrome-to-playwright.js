'use strict';

/**
 * Convert a Chrome DevTools Recorder JSON export to our internal action array.
 *
 * Chrome Recorder step types handled:
 *   navigate  → goto
 *   click     → click
 *   change    → fill  (text inputs)
 *   select    → selectOption
 *   setViewport, keyDown, keyUp, scroll → skipped
 *
 * @param {object} recording - Parsed Chrome DevTools Recorder JSON
 * @returns {Array} actions in the same format the live recorder produces
 */
function chromeRecorderToActions(recording) {
  if (!recording || !Array.isArray(recording.steps)) {
    throw new Error('Invalid Chrome Recorder JSON: missing "steps" array');
  }

  const actions = [];
  for (const step of recording.steps) {
    const action = stepToAction(step);
    if (action) actions.push(action);
  }
  return actions;
}

function stepToAction(step) {
  const ts = Date.now();

  switch (step.type) {
    case 'setViewport':
      return null; // we manage our own viewport

    case 'navigate':
      if (!step.url || step.url === 'about:blank') return null;
      return { type: 'goto', url: step.url, ts };

    case 'click': {
      const selector = pickSelector(step.selectors);
      if (!selector) return null;
      return { type: 'click', selector, text: '', href: null, ts };
    }

    case 'change': {
      const selector = pickSelector(step.selectors);
      if (!selector || step.value === undefined) return null;
      return {
        type: 'fill',
        selector,
        value: step.value,
        sensitive: /password|passwd|pwd|secret/i.test(selector),
        ts,
      };
    }

    case 'select': {
      const selector = pickSelector(step.selectors);
      if (!selector || step.value === undefined) return null;
      return { type: 'selectOption', selector, value: step.value, label: step.value, ts };
    }

    case 'keyDown':
    case 'keyUp':
    case 'scroll':
    case 'waitForElement':
    case 'waitForExpression':
      return null;

    default:
      return null;
  }
}

/**
 * Pick the best Playwright-friendly CSS selector from a Chrome recorder
 * selectors array.
 *
 * Chrome format: [ [sel_chain_part1, sel_chain_part2?], [alt1], ... ]
 *
 * Priority: ID CSS > attribute CSS > plain CSS > ARIA > XPATH
 */
function pickSelector(selectors) {
  if (!selectors || !selectors.length) return null;

  const candidates = [];

  for (const group of selectors) {
    if (!Array.isArray(group) || !group.length) continue;
    const raw = group[0];
    if (!raw) continue;

    if (raw.startsWith('xpath/')) {
      candidates.push({ priority: 4, sel: `xpath=${raw.slice(6)}` });
    } else if (raw.startsWith('aria/')) {
      // Convert aria/Label to [aria-label="Label"], escaping special chars
      const ariaLabel = raw.slice(5).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      candidates.push({ priority: 3, sel: `[aria-label="${ariaLabel}"]` });
    } else if (raw.startsWith('pierce/')) {
      candidates.push({ priority: 2, sel: raw.slice(7) });
    } else {
      // Regular CSS selector — prefer IDs
      const priority = raw.startsWith('#') ? 0 : 1;
      candidates.push({ priority, sel: raw });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates[0].sel;
}

module.exports = { chromeRecorderToActions, pickSelector };
