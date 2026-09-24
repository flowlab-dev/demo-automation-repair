/*
 * Page logic: runs both workflows on demand, fills the comparison panels,
 * builds the defect list out of the workflow files themselves, and renders
 * the run log.
 */
(function () {
  'use strict';

  var WF = window.PalewoodWorkflows;
  var BROKEN = WF['order-intake-BROKEN.json'];
  var FIXED = WF['order-intake-FIXED.json'];
  var ERROR_HANDLER = WF['error-handler.json'];

  var results = { broken: null, fixed: null };
  var logView = 'broken';
  var logOnlyProblems = false;

  // ------------------------------------------------------------------ theme

  var root = document.documentElement;
  var toggle = document.getElementById('theme-toggle');

  function prefersDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function storedTheme() {
    try { return localStorage.getItem('palewood-theme'); } catch (error) { return null; }
  }

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    toggle.textContent = theme === 'dark' ? 'Light' : 'Dark';
  }

  applyTheme(storedTheme() || (prefersDark() ? 'dark' : 'light'));

  toggle.addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('palewood-theme', next); } catch (error) { /* private window: ignore */ }
  });

  // ---------------------------------------------------------------- metrics

  var METRIC_ROWS = [
    { key: 'ordersPlaced', label: 'Orders placed in the shop', tone: 'neutral' },
    { key: 'ordersSaved', label: 'Orders saved to the sheet', tone: 'neutral' },
    { key: 'ordersParkedForReview', label: 'Parked for a human to check', tone: 'neutral' },
    { key: 'ordersLost', label: 'Orders lost for good', tone: 'lowerIsBetter' },
    { key: 'lostRevenueEur', label: 'Revenue in the lost orders', tone: 'lowerIsBetter', money: true },
    { key: 'duplicateEmails', label: 'Customers emailed twice', tone: 'lowerIsBetter' },
    { key: 'customersWithoutConfirmation', label: 'Saved orders with no confirmation sent', tone: 'lowerIsBetter' },
    { key: 'runsFailed', label: 'Runs that stopped with an error', tone: 'lowerIsBetter' },
    { key: 'silentFailures', label: 'Failures nobody was told about', tone: 'lowerIsBetter' },
    { key: 'alertsRaised', label: 'Alerts raised in Slack', tone: 'neutral' }
  ];

  function formatValue(row, metrics) {
    var value = metrics[row.key];
    if (row.money) return 'EUR ' + value.toLocaleString('en-GB');
    return String(value);
  }

  function renderMetrics(containerId, metrics) {
    var container = document.getElementById(containerId);
    container.innerHTML = '';
    METRIC_ROWS.forEach(function (row) {
      var line = document.createElement('div');
      line.className = 'metric-row';

      var label = document.createElement('span');
      label.className = 'metric-label';
      label.textContent = row.label;

      var value = document.createElement('span');
      value.className = 'metric-value';

      if (!metrics) {
        value.className += ' is-idle';
        value.textContent = '—';
      } else {
        value.textContent = formatValue(row, metrics);
        if (row.tone === 'lowerIsBetter') {
          value.className += metrics[row.key] > 0 ? ' is-bad' : ' is-good';
        }
      }

      line.appendChild(label);
      line.appendChild(value);
      container.appendChild(line);
    });
  }

  function renderHeadline() {
    var box = document.getElementById('headline');
    if (!results.broken || !results.fixed) {
      box.innerHTML = '<div><div class="big">—</div><div class="cap">Run the comparison to see the difference over one shift.</div></div>';
      return;
    }

    var b = results.broken.metrics;
    var f = results.fixed.metrics;
    var share = Math.round((b.ordersLost / b.ordersPlaced) * 1000) / 10;

    box.innerHTML = '';
    [
      { big: b.ordersLost + ' → ' + f.ordersLost, cap: 'orders lost per shift (' + share + '% of all orders before the repair)' },
      { big: 'EUR ' + b.lostRevenueEur.toLocaleString('en-GB') + ' → 0', cap: 'revenue sitting in orders that never reached the sheet' },
      { big: b.silentFailures + ' → ' + f.silentFailures, cap: 'failures nobody was told about' }
    ].forEach(function (entry) {
      var cell = document.createElement('div');
      var big = document.createElement('div');
      big.className = 'big';
      big.textContent = entry.big;
      var cap = document.createElement('div');
      cap.className = 'cap';
      cap.textContent = entry.cap;
      cell.appendChild(big);
      cell.appendChild(cap);
      box.appendChild(cell);
    });
  }

  // ---------------------------------------------------------------- defects

  function node(workflow, name) {
    for (var i = 0; i < workflow.nodes.length; i++) {
      if (workflow.nodes[i].name === name) return workflow.nodes[i];
    }
    return null;
  }

  function queryParam(workflow, nodeName, paramName) {
    var target = node(workflow, nodeName);
    var list = (target.parameters.queryParameters && target.parameters.queryParameters.parameters) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].name === paramName) return list[i].value;
    }
    return null;
  }

  function field(workflow, nodeName, key, fallbackComment) {
    var target = node(workflow, nodeName);
    if (target[key] === undefined) return '// "' + key + '" is not set' + (fallbackComment ? ' — ' + fallbackComment : '');
    return '"' + key + '": ' + JSON.stringify(target[key]);
  }

  function codeLinesMatching(workflow, nodeName, patterns) {
    var target = node(workflow, nodeName);
    var lines = target.parameters.jsCode.split('\n');
    var picked = [];
    lines.forEach(function (line) {
      patterns.forEach(function (pattern) {
        if (line.indexOf(pattern) !== -1 && picked.indexOf(line) === -1) picked.push(line.trim());
      });
    });
    return picked.join('\n');
  }

  var DEFECTS = [
    {
      tag: 'D1',
      title: 'A short outage threw away a whole run',
      symptom: 'Orders vanished in small groups, always around the time the shop’s host had a hiccup.',
      cause: 'The HTTP node had no retry and no error branch, so any non-200 from the shop stopped the '
        + 'execution. The next run asked only for the last five minutes — the orders from the failed '
        + 'window were never requested again. Eleven of the fourteen lost orders went this way.',
      fix: 'Three attempts two seconds apart, and an error output that alerts the team instead of killing the run.',
      before: function () {
        return [
          '"name": "Fetch new orders",',
          field(BROKEN, 'Fetch new orders', 'retryOnFail', 'one bad response is fatal') + ',',
          field(BROKEN, 'Fetch new orders', 'onError', 'defaults to stopping the workflow')
        ].join('\n');
      },
      after: function () {
        return [
          '"name": "Fetch new orders",',
          field(FIXED, 'Fetch new orders', 'retryOnFail') + ',',
          field(FIXED, 'Fetch new orders', 'maxTries') + ',',
          field(FIXED, 'Fetch new orders', 'waitBetweenTries') + ',',
          field(FIXED, 'Fetch new orders', 'onError')
        ].join('\n');
      }
    },
    {
      tag: 'D2',
      title: '“The last five minutes” is not a safe way to ask for new orders',
      symptom: 'A handful of orders never appeared, with no failed run to explain them. Others were '
        + 'processed twice after someone widened the window to stop the losses.',
      cause: 'The shop publishes an order to its API a few seconds to a few minutes after it is written. '
        + 'A fixed window that starts at “now minus five minutes” misses anything published late; widening '
        + 'the window by 40 seconds re-reads whatever falls into the overlap and duplicates it.',
      fix: 'A cursor stored in the workflow’s own data, deliberately overlapped by ten minutes — more '
        + 'than the worst publishing delay this shop shows — so late publications are read again. What '
        + 'the overlap repeats is dropped by D5. The cursor moves only after an order has been stored, '
        + 'so a crash cannot skip past it.',
      before: function () {
        return '"name": "updated_since",\n"value": ' + JSON.stringify(queryParam(BROKEN, 'Fetch new orders', 'updated_since'));
      },
      after: function () {
        return '"name": "updated_since",\n"value": ' + JSON.stringify(queryParam(FIXED, 'Fetch new orders', 'updated_since'))
          + '\n\n// Load cursor:\n' + codeLinesMatching(FIXED, 'Load cursor', ['overlapMinutes =', 'const from'])
          + '\n\n// Remember what was stored (runs after the row exists):\n'
          + codeLinesMatching(FIXED, 'Remember what was stored', ['store.cursor = newest', 'delete store.handled']);
      }
    },
    {
      tag: 'D3',
      title: 'The shop API key was sitting in the workflow',
      symptom: 'Not a failure the owner could see — but the key travelled in every export, every backup '
        + 'and every screenshot of the workflow.',
      cause: 'The key was a plain query parameter on the HTTP node instead of an n8n credential.',
      fix: 'Header auth through a credential. The workflow no longer contains the key, so it can be '
        + 'exported and shared safely. (The key in this demo is a fake string, not a real one.)',
      before: function () {
        return '"queryParameters": ' + JSON.stringify(node(BROKEN, 'Fetch new orders').parameters.queryParameters.parameters, null, 2);
      },
      after: function () {
        var target = node(FIXED, 'Fetch new orders');
        return '"authentication": ' + JSON.stringify(target.parameters.authentication) + ',\n'
          + '"genericAuthType": ' + JSON.stringify(target.parameters.genericAuthType) + ',\n'
          + '"credentials": ' + JSON.stringify(target.credentials, null, 2);
      }
    },
    {
      tag: 'D4',
      title: 'One customer without a surname took the whole batch down',
      symptom: 'Every few days an entire run failed, taking all the orders in that window with it.',
      cause: 'The Code node ran once over the whole batch and read fields that are optional at checkout '
        + '(<code>last_name</code>, <code>phone</code>). One missing value threw a TypeError and the '
        + 'batch — good orders included — never reached the sheet.',
      fix: 'The node runs per item with safe defaults, and anything genuinely unusable is flagged for a '
        + 'human instead of being dropped: it goes to a “Needs review” tab with a Slack message, and no '
        + 'email is sent to a broken address.',
      before: function () {
        return '"mode": ' + JSON.stringify(node(BROKEN, 'Format order').parameters.mode) + '\n\n'
          + codeLinesMatching(BROKEN, 'Format order', ['last_name', 'phone.replace']);
      },
      after: function () {
        return '"mode": ' + JSON.stringify(node(FIXED, 'Validate and normalise').parameters.mode) + '\n\n'
          + codeLinesMatching(FIXED, 'Validate and normalise', ['const last', 'const phone', 'problems.push', 'needs_review:']);
      }
    },
    {
      tag: 'D5',
      title: 'Nothing checked whether an order had already been handled',
      symptom: 'Duplicate rows in the sheet and duplicate confirmation emails — six customers in a '
        + 'single shift, several of them people who had simply corrected their delivery address.',
      cause: 'The workflow trusted the time window to deliver every order exactly once and appended '
        + 'blindly. Any overlap, any manual re-run and any edit by the customer produced a second row '
        + 'and a second email.',
      fix: 'The workflow now remembers which orders it has stored, together with the timestamp it '
        + 'stored. An identical repeat is dropped; the same order with a newer timestamp is treated as '
        + 'an update — the existing row is rewritten (Append or Update, matched on the order id), the '
        + 'team is told what changed, and the customer is not emailed twice. The memory is written only '
        + 'after the row exists, and entries older than three days are forgotten so it cannot grow for ever.',
      before: function () {
        return '"operation": ' + JSON.stringify(node(BROKEN, 'Save to Google Sheets').parameters.operation) + '\n'
          + '// No memory of previous runs anywhere in the workflow:\n'
          + '// nodes: ' + BROKEN.nodes.map(function (n) { return n.name; }).join(', ');
      },
      after: function () {
        var save = node(FIXED, 'Save to Google Sheets');
        return '"operation": ' + JSON.stringify(save.parameters.operation) + ',\n'
          + '"matchingColumns": ' + JSON.stringify(save.parameters.columns.matchingColumns) + '\n\n'
          + '// Skip orders already handled:\n'
          + codeLinesMatching(FIXED, 'Skip orders already handled',
              ['const storedAt', 'if (storedAt &&', 'order.is_update']);
      }
    },
    {
      tag: 'D6',
      title: 'When it broke, nobody was told',
      symptom: '“Sometimes Slack goes quiet for an hour.” The automation had stopped and waited for '
        + 'someone to open n8n and look.',
      cause: 'A failing Gmail call stopped the run, so the Slack notification after it never happened — '
        + 'the one place the team would have noticed. No error workflow was configured either.',
      fix: 'Email failures retry, then leave through an error output that alerts the team; the order '
        + 'itself is already stored. Everything that needs a person — an unreachable shop, an order '
        + 'with no usable email, a row that could not be written, a bounced confirmation — goes to one '
        + '#ops-alerts channel. On top of that, an error workflow turns any remaining crash into a '
        + 'Slack message naming the node and the execution.',
      before: function () {
        return '"name": "Email customer",\n'
          + field(BROKEN, 'Email customer', 'retryOnFail', 'a quota block is fatal') + ',\n'
          + field(BROKEN, 'Email customer', 'onError', 'the Slack step after it never runs') + '\n\n'
          + '"settings": ' + JSON.stringify(BROKEN.settings, null, 2) + '  // no errorWorkflow';
      },
      after: function () {
        return '"name": "Email customer",\n'
          + field(FIXED, 'Email customer', 'retryOnFail') + ',\n'
          + field(FIXED, 'Email customer', 'maxTries') + ',\n'
          + field(FIXED, 'Email customer', 'onError') + '\n\n'
          + '"settings": ' + JSON.stringify({ errorWorkflow: FIXED.settings.errorWorkflow }, null, 2) + '\n'
          + '// error-handler.json: ' + ERROR_HANDLER.nodes.map(function (n) { return n.name; }).join(' → ');
      }
    }
  ];

  function renderDefects() {
    var container = document.getElementById('defects');
    container.innerHTML = '';

    DEFECTS.forEach(function (defect) {
      var card = document.createElement('article');
      card.className = 'defect';
      card.id = 'defect-' + defect.tag.toLowerCase();

      var head = document.createElement('div');
      head.className = 'defect-head';
      var tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = defect.tag;
      var title = document.createElement('h3');
      title.textContent = defect.title;
      head.appendChild(tag);
      head.appendChild(title);
      card.appendChild(head);

      var list = document.createElement('dl');
      [
        ['Symptom', defect.symptom],
        ['Root cause', defect.cause],
        ['What I changed', defect.fix]
      ].forEach(function (pair) {
        var dt = document.createElement('dt');
        dt.textContent = pair[0];
        var dd = document.createElement('dd');
        dd.innerHTML = pair[1];
        list.appendChild(dt);
        list.appendChild(dd);
      });
      card.appendChild(list);

      var pair = document.createElement('div');
      pair.className = 'code-pair';
      pair.appendChild(codeBlock('before', 'Before — v3', defect.before()));
      pair.appendChild(codeBlock('after', 'After — v4', defect.after()));
      card.appendChild(pair);

      container.appendChild(card);
    });
  }

  function codeBlock(kind, label, text) {
    var block = document.createElement('div');
    block.className = 'code-block ' + kind;
    var header = document.createElement('header');
    header.textContent = label;
    var pre = document.createElement('pre');
    pre.textContent = text;
    block.appendChild(header);
    block.appendChild(pre);
    return block;
  }

  // -------------------------------------------------------------------- log

  function describeRun(entry, which) {
    if (entry.status === 'error') {
      var text = 'Run stopped at “' + entry.lastNode + '”: ' + entry.error;
      if (entry.silent) text += ' — no message to anyone.';
      return text;
    }
    if (entry.alerts > 0) {
      return entry.ordersSaved + ' saved, ' + entry.alerts + ' alert' + (entry.alerts > 1 ? 's' : '')
        + ' raised — the problem was handled and reported.';
    }
    if (entry.ordersSaved === 0 && entry.ordersParked === 0) {
      return which === 'broken' ? 'No new orders in this window.' : 'No new orders in this window.';
    }
    return entry.ordersSaved + ' order' + (entry.ordersSaved === 1 ? '' : 's') + ' saved'
      + (entry.ordersParked ? ', ' + entry.ordersParked + ' parked for review' : '')
      + (entry.emailsSent ? ', ' + entry.emailsSent + ' emailed' : '') + '.';
  }

  function renderLog() {
    var body = document.getElementById('log-body');
    var result = results[logView];

    if (!result) {
      body.innerHTML = '<tr><td colspan="8" class="empty-log">Run the comparison above to fill the log.</td></tr>';
      return;
    }

    var rows = result.runLog.filter(function (entry) {
      if (!logOnlyProblems) return true;
      return entry.status === 'error' || entry.alerts > 0;
    });

    body.innerHTML = '';

    if (rows.length === 0) {
      body.innerHTML = '<tr><td colspan="8" class="empty-log">No run had a problem in this version.</td></tr>';
      return;
    }

    rows.forEach(function (entry) {
      var tr = document.createElement('tr');
      if (entry.status === 'error') tr.className = 'row-error';
      else if (entry.alerts > 0) tr.className = 'row-alert';

      var status = entry.status === 'error'
        ? '<span class="status-chip err">error</span>'
        : '<span class="status-chip ok">success</span>';

      tr.innerHTML = '<td class="num">' + entry.index + '</td>'
        + '<td class="num">' + entry.at.slice(11, 16) + '</td>'
        + '<td>' + status + '</td>'
        + '<td class="num">' + entry.ordersSaved + '</td>'
        + '<td class="num">' + entry.ordersParked + '</td>'
        + '<td class="num">' + entry.emailsSent + '</td>'
        + '<td class="num">' + entry.alerts + '</td>'
        + '<td><span class="why"></span></td>';
      tr.querySelector('.why').textContent = describeRun(entry, logView);
      body.appendChild(tr);
    });
  }

  function wireLogControls() {
    var brokenButton = document.getElementById('log-broken');
    var fixedButton = document.getElementById('log-fixed');
    var filterButton = document.getElementById('log-filter');

    function sync() {
      brokenButton.setAttribute('aria-pressed', String(logView === 'broken'));
      fixedButton.setAttribute('aria-pressed', String(logView === 'fixed'));
      filterButton.setAttribute('aria-pressed', String(logOnlyProblems));
      renderLog();
    }

    brokenButton.addEventListener('click', function () { logView = 'broken'; sync(); });
    fixedButton.addEventListener('click', function () { logView = 'fixed'; sync(); });
    filterButton.addEventListener('click', function () { logOnlyProblems = !logOnlyProblems; sync(); });
  }

  // -------------------------------------------------------------------- run

  function runBoth(afterRun) {
    var button = document.getElementById('run-button');
    var status = document.getElementById('run-status');

    button.disabled = true;
    status.textContent = 'Replaying 60 scheduled runs through both workflows…';

    // Let the browser paint the disabled state before the (synchronous) run.
    window.setTimeout(function () {
      var started = performance.now();
      results.broken = window.PalewoodSimulation.run({ workflow: BROKEN });
      results.fixed = window.PalewoodSimulation.run({ workflow: FIXED, errorWorkflow: ERROR_HANDLER });
      var took = Math.max(1, Math.round(performance.now() - started));

      renderMetrics('metrics-broken', results.broken.metrics);
      renderMetrics('metrics-fixed', results.fixed.metrics);
      renderHeadline();
      renderLog();

      status.textContent = 'Done in ' + took + ' ms — 120 orders, 60 runs, both versions, same shift.';
      button.disabled = false;
      button.textContent = 'Run again';

      if (typeof afterRun === 'function') afterRun();
    }, 30);
  }

  // ------------------------------------------------------------------ start

  renderMetrics('metrics-broken', null);
  renderMetrics('metrics-fixed', null);
  renderHeadline();
  renderDefects();
  wireLogControls();
  document.getElementById('run-button').addEventListener('click', runBoth);

  // The address can ask for a particular view, so a link can point straight at
  // the comparison, at the failed runs, or at the report in dark mode:
  //   index.html?run=1&log=fixed#log
  applyAddressOptions();

  function applyAddressOptions() {
    var query = String(window.location.search || '');
    function asked(name, value) {
      return new RegExp('[?&]' + name + '=' + value + '(&|$)').test(query);
    }

    if (asked('theme', 'dark') || asked('theme', 'light')) {
      applyTheme(asked('theme', 'dark') ? 'dark' : 'light');
    }
    if (asked('log', 'fixed')) { document.getElementById('log-fixed').click(); }
    if (asked('problems', '1')) { document.getElementById('log-filter').click(); }
    if (asked('run', '1')) { runBoth(scrollToAnchor); } else { scrollToAnchor(); }
  }

  function scrollToAnchor() {
    if (!window.location.hash) return;
    var target = document.querySelector(window.location.hash);
    if (target) target.scrollIntoView({ block: 'start' });
  }
})();
