/*
 * Runs one workflow through the whole 5-hour shift and counts what the owner
 * of the shop actually cares about: orders that reached the sheet, duplicate
 * rows, confirmation emails, and failures nobody was told about.
 */
(function (root) {
  'use strict';

  var Scenario = root.PalewoodScenario || (typeof require === 'function' ? require('./scenario.js') : null);
  var Services = root.PalewoodServices || (typeof require === 'function' ? require('./services.js') : null);
  var RunnerLib = root.PalewoodRunner || (typeof require === 'function' ? require('./runner.js') : null);

  var ALERT_CHANNEL = '#ops-alerts';

  function uniqueOrderIds(rows) {
    var set = {};
    rows.forEach(function (entry) {
      var id = entry.row && entry.row.order_id;
      if (id) set[id] = true;
    });
    return set;
  }

  function countKeys(object) {
    return Object.keys(object).length;
  }

  function run(config) {
    var workflow = config.workflow;
    var errorWorkflow = config.errorWorkflow || null;

    var orders = Scenario.buildOrders();
    var faults = Scenario.buildFaults();
    var runTimes = Scenario.buildRuns();

    var clock = new Services.Clock(runTimes[0]);
    var env = Services.createEnvironment({ orders: orders, faults: faults, clock: clock });
    var staticData = {};

    var runLog = [];
    var failedRuns = 0;
    var silentFailures = 0;

    runTimes.forEach(function (startMs, index) {
      clock.set(startMs);

      var before = {
        orderRows: (env.state.sheets['Orders'] || []).length,
        reviewRows: (env.state.sheets['Needs review'] || []).length,
        emails: env.state.emails.length,
        slack: env.state.slackMessages.length,
        alerts: env.state.slackMessages.filter(function (m) { return m.channel === ALERT_CHANNEL; }).length
      };

      var runner = new RunnerLib.Runner(workflow, env, { staticData: staticData });
      var report = runner.execute();

      var after = {
        orderRows: (env.state.sheets['Orders'] || []).length,
        reviewRows: (env.state.sheets['Needs review'] || []).length,
        emails: env.state.emails.length,
        slack: env.state.slackMessages.length,
        alerts: env.state.slackMessages.filter(function (m) { return m.channel === ALERT_CHANNEL; }).length
      };

      var alertedByWorkflow = after.alerts > before.alerts;

      if (report.status === 'error') {
        failedRuns++;
        if (errorWorkflow && workflow.settings && workflow.settings.errorWorkflow) {
          var handler = new RunnerLib.Runner(errorWorkflow, env, { staticData: {} });
          handler.execute([{
            json: {
              workflow: { name: workflow.name },
              execution: {
                id: 'exec-' + (index + 1),
                lastNodeExecuted: report.lastNodeExecuted,
                error: { message: report.error }
              }
            }
          }]);
          alertedByWorkflow = true;
        }
        if (!alertedByWorkflow) silentFailures++;
      }

      runLog.push({
        index: index + 1,
        at: new Date(startMs).toISOString(),
        status: report.status,
        error: report.error,
        lastNode: report.lastNodeExecuted,
        ordersSaved: after.orderRows - before.orderRows,
        ordersParked: after.reviewRows - before.reviewRows,
        emailsSent: after.emails - before.emails,
        alerts: after.alerts - before.alerts,
        silent: report.status === 'error' && !alertedByWorkflow
      });
    });

    var orderRows = env.state.sheets['Orders'] || [];
    var reviewRows = env.state.sheets['Needs review'] || [];
    var savedIds = uniqueOrderIds(orderRows);
    var parkedIds = uniqueOrderIds(reviewRows);

    var handled = {};
    Object.keys(savedIds).forEach(function (id) { handled[id] = true; });
    Object.keys(parkedIds).forEach(function (id) { handled[id] = true; });

    var lostOrders = orders.filter(function (order) { return !handled[order.id]; });

    var emailsByOrder = {};
    env.state.emails.forEach(function (mail) {
      if (!mail.order_id) return;
      emailsByOrder[mail.order_id] = (emailsByOrder[mail.order_id] || 0) + 1;
    });
    var duplicateEmails = 0;
    Object.keys(emailsByOrder).forEach(function (id) {
      if (emailsByOrder[id] > 1) duplicateEmails += emailsByOrder[id] - 1;
    });

    var alerts = env.state.slackMessages.filter(function (m) { return m.channel === ALERT_CHANNEL; });

    var lostRevenue = lostOrders.reduce(function (sum, order) { return sum + order.total_eur; }, 0);
    var totalRevenue = orders.reduce(function (sum, order) { return sum + order.total_eur; }, 0);

    return {
      workflowName: workflow.name,
      metrics: {
        ordersPlaced: orders.length,
        ordersSaved: countKeys(savedIds),
        ordersParkedForReview: countKeys(parkedIds),
        ordersLost: lostOrders.length,
        duplicateRows: orderRows.length - countKeys(savedIds),
        confirmationEmails: env.state.emails.length,
        duplicateEmails: duplicateEmails,
        customersWithoutConfirmation: countKeys(savedIds) - countKeys(emailsByOrder),
        runsTotal: runTimes.length,
        runsFailed: failedRuns,
        silentFailures: silentFailures,
        alertsRaised: alerts.length,
        lostRevenueEur: lostRevenue,
        totalRevenueEur: totalRevenue
      },
      lostOrders: lostOrders.map(function (order) {
        return {
          id: order.id,
          total: order.total_eur,
          created_at: order.created_at,
          cause: order._published_late ? 'publishing lag' : 'failed run',
          reason: order._published_late
            ? 'published late by the shop queue, the fixed window had already moved on'
            : 'the run that should have picked it up stopped with an error'
        };
      }),
      lostByCause: lostOrders.reduce(function (tally, order) {
        var cause = order._published_late ? 'publishing lag' : 'failed run';
        tally[cause] = (tally[cause] || 0) + 1;
        return tally;
      }, {}),
      updatedOrders: orderRows.filter(function (row) { return row.replaced; }).length,
      duplicates: Object.keys(emailsByOrder).filter(function (id) { return emailsByOrder[id] > 1; }),
      runLog: runLog,
      slackMessages: env.state.slackMessages,
      emails: env.state.emails,
      emailAttempts: env.state.emailAttempts,
      sheets: env.state.sheets,
      calls: env.calls
    };
  }

  root.PalewoodSimulation = { run: run, ALERT_CHANNEL: ALERT_CHANNEL };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.PalewoodSimulation;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
