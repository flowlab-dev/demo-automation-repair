/*
 * Test suite for the Palewood repair demo.
 *
 * It checks three things:
 *   1. the two workflow files really contain the defects / the fixes claimed;
 *   2. running them produces the numbers shown on the page;
 *   3. the copy of the workflows embedded in the page still matches the files.
 *
 * Run: node tests/run-tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORKFLOW_DIR = path.join(ROOT, 'workflows');

global.PalewoodScenario = require(path.join(ROOT, 'engine', 'scenario.js'));
global.PalewoodServices = require(path.join(ROOT, 'engine', 'services.js'));
global.PalewoodRunner = require(path.join(ROOT, 'engine', 'runner.js'));
const Simulation = require(path.join(ROOT, 'engine', 'simulation.js'));
const embedded = require(path.join(ROOT, 'engine', 'workflows.embedded.js'));

const readWorkflow = (file) => JSON.parse(fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8'));
const BROKEN = readWorkflow('order-intake-BROKEN.json');
const FIXED = readWorkflow('order-intake-FIXED.json');
const ERROR_HANDLER = readWorkflow('error-handler.json');

const nodeByName = (workflow, name) => workflow.nodes.find((node) => node.name === name);
const nodesOfType = (workflow, type) => workflow.nodes.filter((node) => node.type === type);

let passed = 0;
const failures = [];

function check(group, name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push({ group, name, message: error.message });
    console.log('  FAIL ' + name + '\n       ' + error.message);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}

// --------------------------------------------------------------- the runs
const brokenRun = Simulation.run({ workflow: BROKEN });
const fixedRun = Simulation.run({ workflow: FIXED, errorWorkflow: ERROR_HANDLER });
const orders = global.PalewoodScenario.buildOrders();
const marked = global.PalewoodScenario.marked;

console.log('\n1. Workflow files and the copy inside the page');

check('files', 'all three workflow files are valid n8n exports', () => {
  [BROKEN, FIXED, ERROR_HANDLER].forEach((workflow) => {
    assert(Array.isArray(workflow.nodes) && workflow.nodes.length > 0, 'workflow has no nodes');
    assert(typeof workflow.connections === 'object', 'workflow has no connections');
    assert(typeof workflow.name === 'string', 'workflow has no name');
  });
});

check('files', 'resource fields use n8n resource locators, not bare strings', () => {
  [BROKEN, FIXED, ERROR_HANDLER].forEach((workflow) => {
    workflow.nodes.forEach((node) => {
      ['documentId', 'sheetName', 'channelId'].forEach((key) => {
        const value = node.parameters[key];
        if (value === undefined) return;
        assert(value && typeof value === 'object' && value.__rl === true,
          node.name + '.' + key + ' must be a resource locator, got ' + JSON.stringify(value));
        assert(typeof value.mode === 'string' && typeof value.value === 'string',
          node.name + '.' + key + ' needs a mode and a value');
      });
    });
  });
});

check('files', 'the copy embedded in the page is identical to the files', () => {
  assertEqual(JSON.stringify(embedded['order-intake-BROKEN.json']), JSON.stringify(BROKEN), 'broken copy differs');
  assertEqual(JSON.stringify(embedded['order-intake-FIXED.json']), JSON.stringify(FIXED), 'fixed copy differs');
  assertEqual(JSON.stringify(embedded['error-handler.json']), JSON.stringify(ERROR_HANDLER), 'error handler copy differs');
});

check('files', 'no real credentials anywhere in the demo', () => {
  const scanned = ['index.html', 'README.md', 'build-embedded.js',
    'assets/app.js', 'assets/styles.css',
    'engine/runner.js', 'engine/services.js', 'engine/scenario.js',
    'engine/simulation.js', 'engine/workflows.embedded.js',
    'workflows/order-intake-BROKEN.json', 'workflows/order-intake-FIXED.json',
    'workflows/error-handler.json', 'tests/run-tests.js', 'tests/page-tests.js']
    .map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
  const text = scanned;
  const suspicious = text.match(/(sk-[A-Za-z0-9]{16,}|xoxb-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,})/g);
  assert(suspicious === null, 'found something that looks like a real key: ' + suspicious);
  const keys = text.match(/pk_live_[A-Za-z0-9_]+/g) || [];
  keys.forEach((key) => {
    assert(key.indexOf('EXAMPLE_NOT_A_REAL_KEY') !== -1, 'api key in the demo must be clearly marked as fake: ' + key);
  });
});

console.log('\n2. The broken workflow really contains the defects we report');

check('defects', 'D1 — the shop request has no retry and stops the run on error', () => {
  const fetch = nodeByName(BROKEN, 'Fetch new orders');
  assert(!fetch.retryOnFail, 'retryOnFail should be absent in the broken version');
  assert(!fetch.onError || fetch.onError === 'stopWorkflow', 'the broken version should stop the whole run');
});

check('defects', 'D2 — the window is a fixed "last N minutes", with no cursor', () => {
  const fetch = nodeByName(BROKEN, 'Fetch new orders');
  const since = fetch.parameters.queryParameters.parameters.find((p) => p.name === 'updated_since');
  assert(/\$now\.minus/.test(since.value), 'the broken version should ask for a fixed window: ' + since.value);
  assert(!BROKEN.nodes.some((n) => /cursor/i.test(n.name)), 'the broken version should have no cursor node');
});

check('defects', 'D3 — the API key sits in the workflow itself', () => {
  const fetch = nodeByName(BROKEN, 'Fetch new orders');
  const key = fetch.parameters.queryParameters.parameters.find((p) => p.name === 'api_key');
  assert(key !== undefined, 'the broken version should carry the key in a query parameter');
  assert(!fetch.credentials, 'the broken version should not use an n8n credential');
});

check('defects', 'D4 — one malformed order takes the whole batch down', () => {
  const code = nodeByName(BROKEN, 'Format order');
  assertEqual(code.parameters.mode, 'runOnceForAllItems', 'the broken Code node runs over the whole batch');
  assert(/last_name\.trim\(\)/.test(code.parameters.jsCode), 'the broken code reads last_name without a guard');
  assert(/phone\.replace/.test(code.parameters.jsCode), 'the broken code reads phone without a guard');
});

check('defects', 'D5 — nothing checks whether an order was already handled', () => {
  assertEqual(nodesOfType(BROKEN, 'n8n-nodes-base.removeDuplicates').length, 0, 'no dedupe node');
  const text = JSON.stringify(BROKEN);
  assert(text.indexOf('getWorkflowStaticData') === -1, 'the broken version remembers nothing between runs');
  assert(nodeByName(BROKEN, 'Save to Google Sheets').parameters.operation === 'append',
    'it appends blindly, so a second read of the same order makes a second row');
});

check('defects', 'D6 — a failed email stops the run and the team is never told', () => {
  const gmail = nodeByName(BROKEN, 'Email customer');
  assert(!gmail.retryOnFail, 'the broken Gmail node has no retry');
  assert(!gmail.onError || gmail.onError === 'stopWorkflow', 'the broken Gmail node stops the run');
  assert(!BROKEN.settings || !BROKEN.settings.errorWorkflow, 'the broken version has no error workflow');
});

console.log('\n3. The repaired workflow contains every fix we charge for');

check('fixes', 'F1 — the shop request retries and has an error branch', () => {
  const fetch = nodeByName(FIXED, 'Fetch new orders');
  assert(fetch.retryOnFail === true, 'retryOnFail must be on');
  assert(fetch.maxTries >= 3, 'at least 3 attempts');
  assertEqual(fetch.onError, 'continueErrorOutput', 'failures must leave through the error output');
  const branch = FIXED.connections['Fetch new orders'].main[1];
  assert(branch && branch.length > 0, 'the error output must be connected to an alert');
});

check('fixes', 'F2 — a cursor replaces the fixed window, with overlap', () => {
  const load = nodeByName(FIXED, 'Load cursor');
  assert(load, 'the cursor must be read at the start of the run');
  assert(/getWorkflowStaticData/.test(load.parameters.jsCode), 'the cursor must be stored between runs');
  assert(/overlapMinutes/.test(load.parameters.jsCode), 'the window must overlap to survive publishing lag');
  const fetch = nodeByName(FIXED, 'Fetch new orders');
  const since = fetch.parameters.queryParameters.parameters.find((p) => p.name === 'updated_since');
  assertEqual(since.value, '={{ $json.cursor }}', 'the request must use the cursor, not a fixed window');
  assert(!/\$now\.minus/.test(JSON.stringify(fetch.parameters)), 'no "last N minutes" left in the request');
});

check('fixes', 'F3 — the key lives in an n8n credential, not in the workflow', () => {
  const fetch = nodeByName(FIXED, 'Fetch new orders');
  assert(fetch.credentials && fetch.credentials.httpHeaderAuth, 'must use a header-auth credential');
  const params = fetch.parameters.queryParameters.parameters.map((p) => p.name);
  assert(params.indexOf('api_key') === -1, 'no key may remain in the query parameters');
});

check('fixes', 'F4 — validation runs per item and flags instead of dropping', () => {
  const code = nodeByName(FIXED, 'Validate and normalise');
  assertEqual(code.parameters.mode, 'runOnceForEachItem', 'must run per item');
  assert(/needs_review/.test(code.parameters.jsCode), 'must flag orders a human has to look at');
  const decision = nodeByName(FIXED, 'Needs a human?');
  assert(decision && decision.type === 'n8n-nodes-base.if', 'an IF node must route flagged orders');
});

check('fixes', 'F5 — repeats are dropped, real updates are applied to the same row', () => {
  const skip = nodeByName(FIXED, 'Skip orders already handled');
  assert(skip, 'the repeat filter must exist');
  assert(/store\.handled\[order\.id\]/.test(skip.parameters.jsCode), 'it must look the order id up in the store');
  assert(/storedAt === order\.updated_at/.test(skip.parameters.jsCode), 'an identical repeat is dropped');
  assert(/is_update = Boolean\(storedAt\)/.test(skip.parameters.jsCode), 'a newer timestamp is marked as an update');

  const save = nodeByName(FIXED, 'Save to Google Sheets');
  assertEqual(save.parameters.operation, 'appendOrUpdate', 'an update must rewrite the row, not add one');
  assertEqual(JSON.stringify(save.parameters.columns.matchingColumns), '["order_id"]', 'matched on the order id');
});

check('fixes', 'F8 — the cursor and the memory move only after the row is written', () => {
  const remember = nodeByName(FIXED, 'Remember what was stored');
  assert(remember, 'the bookkeeping node must exist');
  assert(/store\.cursor = newest/.test(remember.parameters.jsCode), 'the cursor moves here');
  assert(/store\.handled\[id\] = stamp/.test(remember.parameters.jsCode), 'the order is remembered here');
  assert(/delete store\.handled\[id\]/.test(remember.parameters.jsCode), 'old entries are dropped so the store cannot grow for ever');

  // Both storing branches do the same bookkeeping, and the review branch ends
  // there — a parked order must never fall through into Gmail.
  const fromSave = FIXED.connections['Save to Google Sheets'].main[0].map((c) => c.node);
  assert(fromSave.indexOf('Remember what was stored') !== -1, 'reached from the orders sheet');
  const parkedBookkeeping = nodeByName(FIXED, 'Remember the parked order');
  assert(parkedBookkeeping, 'the review branch must do its bookkeeping too');
  assert(!FIXED.connections['Remember the parked order'], 'the review branch must end there, not reach Gmail');
  const fromPark = FIXED.connections['Park order for review'].main[0].map((c) => c.node);
  assert(fromPark.indexOf('Email customer') === -1, 'a parked order must never reach Gmail');
  assert(!FIXED.nodes.some((n) => n.name === 'Move cursor forward'),
    'the old node that moved the cursor before saving must be gone');
});

check('fixes', 'F9 — an updated order is not emailed a second time', () => {
  const decision = nodeByName(FIXED, 'Is this an update?');
  assert(decision && decision.type === 'n8n-nodes-base.if', 'an IF node must split updates from new orders');
  const trueBranch = FIXED.connections['Is this an update?'].main[0].map((c) => c.node);
  const falseBranch = FIXED.connections['Is this an update?'].main[1].map((c) => c.node);
  assert(trueBranch.indexOf('Tell the team it changed') !== -1, 'an update only notifies the team');
  assert(trueBranch.indexOf('Email customer') === -1, 'an update must not reach Gmail');
  assert(falseBranch.indexOf('Email customer') !== -1, 'a new order is emailed');
});

check('fixes', 'F6 — email failures retry, then alert, and never stop the run', () => {
  const gmail = nodeByName(FIXED, 'Email customer');
  assert(gmail.retryOnFail === true && gmail.maxTries >= 3, 'the Gmail node must retry');
  assertEqual(gmail.onError, 'continueErrorOutput', 'a failed email must leave through the error output');
  const alertBranch = FIXED.connections['Email customer'].main[1];
  assert(alertBranch && alertBranch.length > 0, 'the error output must reach an alert');
});

check('fixes', 'F7 — an error workflow turns any remaining crash into a message', () => {
  assert(FIXED.settings && FIXED.settings.errorWorkflow, 'the repaired workflow must name an error workflow');
  assertEqual(nodesOfType(ERROR_HANDLER, 'n8n-nodes-base.errorTrigger').length, 1, 'error handler needs an error trigger');
  assertEqual(nodesOfType(ERROR_HANDLER, 'n8n-nodes-base.slack').length, 1, 'error handler must notify the team');
});

console.log('\n4. What happens when both versions run the same shift');

check('behaviour', 'the scenario is the one we describe: 120 orders, 60 runs', () => {
  assertEqual(orders.length, 120, 'order count');
  assertEqual(global.PalewoodScenario.buildRuns().length, 60, 'run count');
  assertEqual(brokenRun.metrics.ordersPlaced, fixedRun.metrics.ordersPlaced, 'both versions see the same orders');
});

check('behaviour', 'broken: the exact figures every document quotes', () => {
  // These are the numbers printed in REPAIR-REPORT.md, README.md, the case text
  // and on the page. If a change moves them, this test fails before the
  // documents can quietly go out of date.
  const m = brokenRun.metrics;
  assertEqual(m.ordersPlaced, 120, 'orders placed');
  assertEqual(m.ordersSaved, 106, 'orders saved');
  assertEqual(m.ordersLost, 14, 'orders lost');
  assertEqual(m.lostRevenueEur, 2504, 'revenue lost');
  assertEqual(m.duplicateEmails, 6, 'duplicate emails');
  assertEqual(m.duplicateRows, 6, 'duplicate rows');
  assertEqual(m.customersWithoutConfirmation, 7, 'saved orders with no confirmation');
  assertEqual(m.runsFailed, 10, 'failed runs');
  assertEqual(m.silentFailures, 10, 'silent failures');
  assertEqual(m.alertsRaised, 0, 'alerts');
  assertEqual(m.ordersSaved + m.ordersLost, m.ordersPlaced, 'saved + lost must add up');
});

check('behaviour', 'broken: the losses split the way the report says', () => {
  assertEqual(brokenRun.lostByCause['failed run'], 11, 'orders lost inside runs that crashed');
  assertEqual(brokenRun.lostByCause['publishing lag'], 3, 'orders the fixed window never asked for');
});

check('behaviour', 'repaired: the exact figures every document quotes', () => {
  const m = fixedRun.metrics;
  assertEqual(m.ordersSaved, 119, 'orders saved');
  assertEqual(m.ordersParkedForReview, 1, 'parked for a human');
  assertEqual(m.confirmationEmails, 118, 'confirmation emails');
  assertEqual(m.alertsRaised, 4, 'alerts raised');
  assertEqual(fixedRun.updatedOrders, 4, 'rows rewritten because the customer changed the order');
});

check('behaviour', 'broken: every failed run is silent — no alert at all', () => {
  assert(brokenRun.metrics.runsFailed > 0, 'the broken version must have failed runs');
  assertEqual(brokenRun.metrics.silentFailures, brokenRun.metrics.runsFailed, 'all of them are silent');
  assertEqual(brokenRun.metrics.alertsRaised, 0, 'nobody is told anything');
});

check('behaviour', 'repaired: not a single order is lost', () => {
  assertEqual(fixedRun.metrics.ordersLost, 0, 'orders lost');
  assertEqual(
    fixedRun.metrics.ordersSaved + fixedRun.metrics.ordersParkedForReview,
    fixedRun.metrics.ordersPlaced,
    'every order is either saved or parked for a human'
  );
});

check('behaviour', 'repaired: no duplicate rows and no duplicate emails', () => {
  assertEqual(fixedRun.metrics.duplicateRows, 0, 'duplicate rows');
  assertEqual(fixedRun.metrics.duplicateEmails, 0, 'duplicate emails');
});

check('behaviour', 'repaired: no run crashes and no failure is silent', () => {
  assertEqual(fixedRun.metrics.runsFailed, 0, 'failed runs');
  assertEqual(fixedRun.metrics.silentFailures, 0, 'silent failures');
  assert(fixedRun.metrics.alertsRaised > 0, 'real problems still raise an alert');
});

check('behaviour', 'repaired: the outage is survived, not ignored', () => {
  const outageAlerts = fixedRun.slackMessages.filter((m) => /could not reach the shop API/.test(m.text));
  assert(outageAlerts.length >= 1, 'the shop outage must raise an alert');
  const lateOrders = marked.publishedLate.map((index) => orders[index].id);
  const savedIds = (fixedRun.sheets['Orders'] || []).map((row) => row.row.order_id);
  lateOrders.forEach((id) => {
    assert(savedIds.indexOf(id) !== -1, 'order published late must still be picked up: ' + id);
  });
});

check('behaviour', 'repaired: the order without an email address goes to a human, not to Gmail', () => {
  const orderId = orders[marked.missingEmail].id;
  const parked = (fixedRun.sheets['Needs review'] || []).map((row) => row.row.order_id);
  assert(parked.indexOf(orderId) !== -1, 'the order must be parked for review');
  const mailed = fixedRun.emails.some((mail) => mail.order_id === orderId);
  assert(!mailed, 'no email may be attempted for it');
  const alert = fixedRun.slackMessages.some((m) => m.text.indexOf(orderId) !== -1 && /needs a human/.test(m.text));
  assert(alert, 'the team must be told about it');
});

check('behaviour', 'repaired: a permanently bouncing address is saved and reported', () => {
  const orderId = orders[marked.hardBounceEmail].id;
  const savedIds = (fixedRun.sheets['Orders'] || []).map((row) => row.row.order_id);
  assert(savedIds.indexOf(orderId) !== -1, 'the order itself must be saved');
  const alert = fixedRun.slackMessages.some((m) => m.text.indexOf(orderId) !== -1 && /not delivered/.test(m.text));
  assert(alert, 'the team must be told the email did not arrive');
});

check('behaviour', 'repaired: an order the customer edited keeps one row and one email', () => {
  const editedIds = marked.editedByCustomer.map((index) => orders[index].id);
  assert(editedIds.length > 0, 'the scenario must contain edited orders');

  editedIds.forEach((id) => {
    const rows = (fixedRun.sheets['Orders'] || []).filter((row) => row.row.order_id === id);
    const mails = fixedRun.emails.filter((mail) => mail.order_id === id).length;
    assertEqual(rows.length, 1, 'exactly one row for ' + id);
    assertEqual(mails, 1, 'exactly one email for ' + id);
    assert(rows[0].replaced === true, 'the row for ' + id + ' must have been rewritten with the new details');
    const told = fixedRun.slackMessages.some((m) => m.text.indexOf(id) !== -1 && /was updated by the customer/.test(m.text));
    assert(told, 'the team must be told that ' + id + ' changed');
  });
});

check('behaviour', 'broken: the same edits produce a second row and a second email', () => {
  const editedIds = marked.editedByCustomer.map((index) => orders[index].id);
  const doubled = editedIds.filter((id) => {
    return (brokenRun.sheets['Orders'] || []).filter((row) => row.row.order_id === id).length > 1;
  });
  assert(doubled.length > 0, 'the broken version must duplicate at least one edited order');
  doubled.forEach((id) => {
    const mails = brokenRun.emails.filter((mail) => mail.order_id === id).length;
    assert(mails > 1, 'the customer of ' + id + ' was emailed more than once');
  });
});

check('behaviour', 'the overlap is larger than the worst publishing delay in the scenario', () => {
  // The repaired version survives late publications only while the overlap
  // exceeds the shop's worst delay. This states the margin instead of trusting it.
  const load = nodeByName(FIXED, 'Load cursor');
  const overlapMinutes = Number(/overlapMinutes = (\d+)/.exec(load.parameters.jsCode)[1]);
  const worstDelayMinutes = Math.max.apply(null, orders.map((order) => {
    return (order._available_at - Date.parse(order.created_at)) / 60000;
  }));
  assert(overlapMinutes > worstDelayMinutes,
    'overlap ' + overlapMinutes + ' min must exceed the worst publishing delay ' + worstDelayMinutes.toFixed(1) + ' min');
});

check('behaviour', 'the money lost by the broken version is real and recovered by the repair', () => {
  assert(brokenRun.metrics.lostRevenueEur > 0, 'the broken version must lose revenue');
  assertEqual(fixedRun.metrics.lostRevenueEur, 0, 'the repaired version loses none');
});

check('behaviour', 'the simulation is deterministic — same input, same numbers', () => {
  const again = Simulation.run({ workflow: BROKEN });
  assertEqual(JSON.stringify(again.metrics), JSON.stringify(brokenRun.metrics), 'second run differs');
});

console.log('\n5. The runner itself');

check('runner', 'n8n expressions are evaluated, not printed', () => {
  const resolve = global.PalewoodRunner.resolveValue;
  assertEqual(resolve('={{ $json.total }}', { $json: { total: 46 } }), 46, 'whole-value expression keeps its type');
  assertEqual(resolve('=Order {{ $json.id }} — EUR {{ $json.total }}', { $json: { id: 'PC-1', total: 46 } }),
    'Order PC-1 — EUR 46', 'inline expression');
  assertEqual(resolve('plain text', {}), 'plain text', 'plain values pass through');
});

check('runner', 'a Code node really executes the JavaScript stored in the file', () => {
  const Services = global.PalewoodServices;
  const clock = new Services.Clock(Date.parse('2026-09-15T08:00:00.000Z'));
  const env = Services.createEnvironment({ orders: [], faults: { shopApi: [], gmail: [] }, clock: clock });
  const workflow = {
    name: 'inline test',
    nodes: [
      { name: 'T', type: 'n8n-nodes-base.scheduleTrigger', parameters: {}, position: [0, 0] },
      { name: 'C', type: 'n8n-nodes-base.code', parameters: { mode: 'runOnceForAllItems', jsCode: 'return [{ json: { doubled: 21 * 2 } }];' }, position: [1, 0] }
    ],
    connections: { T: { main: [[{ node: 'C', type: 'main', index: 0 }]] } },
    settings: {}
  };
  const runner = new global.PalewoodRunner.Runner(workflow, env, { staticData: {} });
  const report = runner.execute();
  assertEqual(report.status, 'success', 'run should succeed');
  assertEqual(report.lastNodeExecuted, 'C', 'the code node should have run');
});

check('runner', 'a node that throws stops the run when the workflow says stopWorkflow', () => {
  const Services = global.PalewoodServices;
  const clock = new Services.Clock(Date.parse('2026-09-15T08:00:00.000Z'));
  const env = Services.createEnvironment({ orders: [], faults: { shopApi: [], gmail: [] }, clock: clock });
  const workflow = {
    name: 'failing test',
    nodes: [
      { name: 'T', type: 'n8n-nodes-base.scheduleTrigger', parameters: {}, position: [0, 0] },
      { name: 'C', type: 'n8n-nodes-base.code', parameters: { mode: 'runOnceForAllItems', jsCode: 'return [{ json: { x: undefined.length } }];' }, position: [1, 0] }
    ],
    connections: { T: { main: [[{ node: 'C', type: 'main', index: 0 }]] } },
    settings: {}
  };
  const runner = new global.PalewoodRunner.Runner(workflow, env, { staticData: {} });
  const report = runner.execute();
  assertEqual(report.status, 'error', 'the run must fail');
  assertEqual(report.lastNodeExecuted, 'C', 'and name the node that failed');
});

// ------------------------------------------------------------------ summary
console.log('\n' + '-'.repeat(68));
if (failures.length === 0) {
  console.log('ALL TESTS PASSED — ' + passed + ' of ' + passed);
  console.log('\nBroken version : ' + brokenRun.metrics.ordersLost + ' orders lost, '
    + brokenRun.metrics.duplicateEmails + ' duplicate emails, '
    + brokenRun.metrics.runsFailed + ' failed runs, ' + brokenRun.metrics.alertsRaised + ' alerts, EUR '
    + brokenRun.metrics.lostRevenueEur + ' lost');
  console.log('Repaired       : ' + fixedRun.metrics.ordersLost + ' orders lost, '
    + fixedRun.metrics.duplicateEmails + ' duplicate emails, '
    + fixedRun.metrics.runsFailed + ' failed runs, ' + fixedRun.metrics.alertsRaised + ' alerts, EUR '
    + fixedRun.metrics.lostRevenueEur + ' lost');
  process.exit(0);
} else {
  console.log(failures.length + ' TEST(S) FAILED out of ' + (passed + failures.length));
  failures.forEach((failure) => console.log('  - ' + failure.name + ': ' + failure.message));
  process.exit(1);
}
