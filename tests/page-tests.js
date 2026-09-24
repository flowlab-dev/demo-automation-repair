/*
 * Page tests without a browser.
 *
 * assets/app.js only uses a small slice of the DOM, so the slice is emulated
 * here. This catches what matters from the command line: the page builds, the
 * defect list is generated from the workflow files, pressing the button really
 * runs both workflows, and the numbers that land in the panels are the numbers
 * the simulation produced. Rendering itself is still checked by eye in a browser.
 *
 * Run: node tests/page-tests.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

global.PalewoodScenario = require(path.join(ROOT, 'engine', 'scenario.js'));
global.PalewoodServices = require(path.join(ROOT, 'engine', 'services.js'));
global.PalewoodRunner = require(path.join(ROOT, 'engine', 'runner.js'));
const Simulation = require(path.join(ROOT, 'engine', 'simulation.js'));
const workflows = require(path.join(ROOT, 'engine', 'workflows.embedded.js'));

// ------------------------------------------------------------------ mini DOM

function Element(tag) {
  this.tagName = tag;
  this.children = [];
  this.attributes = {};
  this.listeners = {};
  this.className = '';
  this.ownText = '';
  this.html = '';
  this.disabled = false;
}

Element.prototype.appendChild = function (child) {
  this.children.push(child);
  return child;
};

Object.defineProperty(Element.prototype, 'textContent', {
  get: function () {
    if (this.ownText) return this.ownText;
    return this.children.map(function (child) { return child.textContent; }).join('');
  },
  set: function (value) {
    this.ownText = String(value);
    this.children = [];
  }
});

Object.defineProperty(Element.prototype, 'innerHTML', {
  get: function () { return this.html; },
  set: function (value) {
    this.html = String(value);
    this.children = [];
    this.ownText = '';
  }
});

Element.prototype.setAttribute = function (name, value) { this.attributes[name] = String(value); };
Element.prototype.getAttribute = function (name) { return this.attributes[name]; };
Element.prototype.addEventListener = function (type, handler) {
  (this.listeners[type] = this.listeners[type] || []).push(handler);
};
Element.prototype.click = function () {
  (this.listeners.click || []).forEach(function (handler) { handler(); });
};
// The page only ever asks a freshly built row for its ".why" cell.
Element.prototype.querySelector = function () { return new Element('span'); };

Element.prototype.allText = function () {
  var text = this.ownText + ' ' + this.html;
  this.children.forEach(function (child) { text += ' ' + child.allText(); });
  return text;
};

Element.prototype.find = function (predicate, found) {
  found = found || [];
  if (predicate(this)) found.push(this);
  this.children.forEach(function (child) { child.find(predicate, found); });
  return found;
};

const byId = {};
['theme-toggle', 'run-button', 'run-status', 'metrics-broken', 'metrics-fixed', 'headline',
  'defects', 'log-body', 'log-broken', 'log-fixed', 'log-filter'].forEach(function (id) {
  byId[id] = new Element('div');
});

const documentStub = {
  documentElement: new Element('html'),
  getElementById: function (id) { return byId[id] || null; },
  createElement: function (tag) { return new Element(tag); }
};

const storage = {};
const localStorageStub = {
  getItem: function (key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
  setItem: function (key, value) { storage[key] = String(value); }
};

const timers = [];
const windowStub = {
  location: { search: '', hash: '' },
  PalewoodWorkflows: workflows,
  PalewoodSimulation: Simulation,
  matchMedia: function () { return { matches: false }; },
  setTimeout: function (fn) { timers.push(fn); return timers.length; }
};

const performanceStub = { now: function () { return Date.now(); } };

// ------------------------------------------------------------------- harness

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name + ': ' + error.message);
    console.log('  FAIL ' + name + '\n       ' + error.message);
  }
}

function assert(condition, message) { if (!condition) throw new Error(message); }
function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(message + ' — expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}

console.log('\nPage behaviour (emulated DOM)');

const appSource = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');
const runApp = new Function('window', 'document', 'localStorage', 'performance', 'setTimeout', appSource);

check('the page script initialises without throwing', function () {
  runApp(windowStub, documentStub, localStorageStub, performanceStub, windowStub.setTimeout);
  assert(timers.length === 0, 'nothing should be scheduled before the button is pressed');
});

check('a theme is applied on load and the toggle switches it', function () {
  const theme = documentStub.documentElement.getAttribute('data-theme');
  assert(theme === 'light' || theme === 'dark', 'a theme must be set, got ' + theme);
  byId['theme-toggle'].click();
  assert(documentStub.documentElement.getAttribute('data-theme') !== theme, 'the toggle must change the theme');
  assert(storage['palewood-theme'], 'the choice must be remembered');
});

check('the defect list is built from the workflow files', function () {
  const cards = byId['defects'].children;
  assertEqual(cards.length, 6, 'six defects');
  const text = byId['defects'].allText();
  ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'].forEach(function (tag) {
    assert(text.indexOf(tag) !== -1, 'defect ' + tag + ' must be present');
  });
  assert(text.indexOf('undefined') === -1, 'no snippet may render as undefined');
  assert(text.indexOf('retryOnFail') !== -1, 'snippets must quote the real fields');
  assert(text.indexOf('appendOrUpdate') !== -1, 'the dedupe fix must be quoted from the file');
  assert(text.indexOf('matchingColumns') !== -1, 'the matching column must be quoted from the file');
  assert(text.indexOf('pk_live_EXAMPLE_NOT_A_REAL_KEY_7f3c2a') !== -1, 'the fake key is shown as the defect it is');
});

check('before the run, the panels show no numbers at all', function () {
  const text = byId['metrics-broken'].allText() + byId['metrics-fixed'].allText();
  assert(text.indexOf('—') !== -1, 'placeholders must be dashes');
  assert(!/\b\d{2,}\b/.test(text), 'no figures may be shown before a run: ' + text.slice(0, 120));
});

check('pressing the button runs both workflows and fills the panels', function () {
  byId['run-button'].click();
  assertEqual(timers.length, 1, 'the run is deferred so the browser can paint');
  timers[0]();

  const expectedBroken = Simulation.run({ workflow: workflows['order-intake-BROKEN.json'] });
  const expectedFixed = Simulation.run({
    workflow: workflows['order-intake-FIXED.json'],
    errorWorkflow: workflows['error-handler.json']
  });

  const brokenText = byId['metrics-broken'].allText();
  const fixedText = byId['metrics-fixed'].allText();

  assert(brokenText.indexOf(String(expectedBroken.metrics.ordersLost)) !== -1,
    'the broken panel must show the orders it lost');
  assert(brokenText.indexOf(expectedBroken.metrics.lostRevenueEur.toLocaleString('en-GB')) !== -1,
    'the broken panel must show the money lost');
  assert(fixedText.indexOf(String(expectedFixed.metrics.alertsRaised)) !== -1,
    'the repaired panel must show the alerts raised');

  const headline = byId['headline'].allText();
  assert(headline.indexOf(expectedBroken.metrics.ordersLost + ' → 0') !== -1,
    'the headline must show the before → after figure, got: ' + headline.slice(0, 120));

  const status = byId['run-status'].textContent;
  assert(/Done in \d+ ms/.test(status), 'the status line must report the run, got: ' + status);
});

check('the run log is filled and can be switched between versions', function () {
  const brokenRows = byId['log-body'].children.length;
  assertEqual(brokenRows, 60, 'every scheduled run is listed');

  byId['log-filter'].click();
  const problemRows = byId['log-body'].children.length;
  assert(problemRows > 0 && problemRows < 60, 'the filter must narrow the log, got ' + problemRows);

  byId['log-fixed'].click();
  assertEqual(byId['log-fixed'].getAttribute('aria-pressed'), 'true', 'the pressed state must follow the view');
  const fixedProblemRows = byId['log-body'].children.length;
  assert(fixedProblemRows > 0, 'the repaired version still reports the outage it survived');
  assert(fixedProblemRows < problemRows, 'the repaired version must have fewer problem runs');

  byId['log-filter'].click();
  assertEqual(byId['log-body'].children.length, 60, 'unfiltered, all runs are listed again');
});

check('the address can ask for a particular view', function () {
  // A fresh page with ?run=1&theme=dark&log=fixed&problems=1#log must land on the
  // failed runs of the repaired version, in dark mode, already run.
  const fresh = {};
  ['theme-toggle', 'run-button', 'run-status', 'metrics-broken', 'metrics-fixed', 'headline',
    'defects', 'log-body', 'log-broken', 'log-fixed', 'log-filter'].forEach(function (id) {
    fresh[id] = new Element('div');
  });
  const doc = {
    documentElement: new Element('html'),
    getElementById: function (id) { return fresh[id] || null; },
    createElement: function (tag) { return new Element(tag); },
    querySelector: function () { return null; }
  };
  const queued = [];
  const win = {
    location: { search: '?run=1&theme=dark&log=fixed&problems=1', hash: '#log' },
    PalewoodWorkflows: workflows,
    PalewoodSimulation: Simulation,
    matchMedia: function () { return { matches: false }; },
    setTimeout: function (fn) { queued.push(fn); return queued.length; }
  };

  runApp(win, doc, localStorageStub, performanceStub, win.setTimeout);
  assertEqual(doc.documentElement.getAttribute('data-theme'), 'dark', 'theme from the address');
  assertEqual(fresh['log-fixed'].getAttribute('aria-pressed'), 'true', 'the repaired version is selected');
  assertEqual(fresh['log-filter'].getAttribute('aria-pressed'), 'true', 'the problem filter is on');
  assertEqual(queued.length, 1, 'the run was started by the address');
  queued[0]();
  assert(/Done in \d+ ms/.test(fresh['run-status'].textContent), 'the run finished');
  const rows = fresh['log-body'].children.length;
  assert(rows > 0 && rows < 60, 'the log shows only the runs with a problem, got ' + rows);
});

console.log('\n' + '-'.repeat(68));
if (failures.length === 0) {
  console.log('ALL PAGE TESTS PASSED — ' + passed + ' of ' + passed);
  process.exit(0);
}
console.log(failures.length + ' PAGE TEST(S) FAILED out of ' + (passed + failures.length));
failures.forEach(function (failure) { console.log('  - ' + failure); });
process.exit(1);
