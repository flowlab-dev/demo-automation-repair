/*
 * A small n8n runner.
 *
 * It reads the two workflow JSON files exactly as they are exported from n8n
 * and executes them: schedule trigger, HTTP request with paging and retries,
 * Code nodes (the JavaScript inside the file really runs), Split Out,
 * Remove Duplicates, IF, Google Sheets, Gmail and Slack.
 *
 * The point is that the difference between the broken and the repaired run
 * cannot be faked: both go through this same runner, the same mock services
 * and the same outages. Only the JSON differs.
 *
 * It is not n8n itself — see "What this runner does not model" in README.md.
 */
(function (root) {
  'use strict';

  var NODE_STEP_MS = 200; // virtual time one node call takes

  // ---------------------------------------------------------------- helpers

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function nowHelper(clock) {
    function make(ms) {
      return {
        minus: function (spec) {
          var delta = 0;
          if (spec) {
            if (spec.minutes) delta += spec.minutes * 60000;
            if (spec.hours) delta += spec.hours * 3600000;
            if (spec.days) delta += spec.days * 86400000;
            if (spec.seconds) delta += spec.seconds * 1000;
          }
          return make(ms - delta);
        },
        toISO: function () { return new Date(ms).toISOString(); }
      };
    }
    return make(clock.now());
  }

  // Several n8n fields are "resource locators": {__rl, mode, value} instead of
  // a plain string. Both forms are accepted here, as in n8n itself.
  function locatorValue(field) {
    if (field && typeof field === 'object' && field.__rl) return field.value;
    return field;
  }

  // n8n expressions: a value starting with "=" may contain {{ ... }} blocks.
  function resolveValue(raw, ctx) {
    if (typeof raw !== 'string') return raw;
    if (raw.charAt(0) !== '=') return raw;

    var body = raw.slice(1);
    var whole = body.match(/^\{\{([\s\S]*)\}\}$/);
    if (whole) return evaluateExpression(whole[1], ctx);

    return body.replace(/\{\{([\s\S]*?)\}\}/g, function (_, expr) {
      var value = evaluateExpression(expr, ctx);
      if (value === undefined || value === null) return '';
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    });
  }

  function evaluateExpression(expr, ctx) {
    /* eslint-disable no-new-func */
    var fn = new Function('$json', '$now', '$pageCount', '$response',
      '"use strict"; return (' + expr + ');');
    return fn(ctx.$json, ctx.$now, ctx.$pageCount, ctx.$response);
  }

  function toItems(result) {
    if (result === undefined || result === null) return [];
    var list = Array.isArray(result) ? result : [result];
    return list.map(function (entry) {
      if (entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'json')) {
        return { json: entry.json };
      }
      return { json: entry };
    });
  }

  function NodeFailure(node, error) {
    this.node = node;
    this.error = error;
    this.message = error && error.message ? error.message : String(error);
  }

  // --------------------------------------------------------------- the runner

  function Runner(workflow, env, options) {
    this.workflow = workflow;
    this.env = env;
    this.options = options || {};
    this.staticData = this.options.staticData || {};
    this.nodesByName = {};
    for (var i = 0; i < workflow.nodes.length; i++) {
      this.nodesByName[workflow.nodes[i].name] = workflow.nodes[i];
    }
  }

  Runner.prototype.getStaticData = function () {
    return this.staticData;
  };

  Runner.prototype.findTrigger = function () {
    for (var i = 0; i < this.workflow.nodes.length; i++) {
      var type = this.workflow.nodes[i].type;
      if (type === 'n8n-nodes-base.scheduleTrigger' || type === 'n8n-nodes-base.errorTrigger') {
        return this.workflow.nodes[i];
      }
    }
    return null;
  };

  /* Runs one execution of the workflow. Returns a report of what happened. */
  Runner.prototype.execute = function (input) {
    var self = this;
    var trigger = this.findTrigger();
    var report = {
      status: 'success',
      error: null,
      lastNodeExecuted: null,
      nodes: []
    };

    if (!trigger) {
      report.status = 'error';
      report.error = 'workflow has no trigger node';
      return report;
    }

    try {
      this.walk(trigger.name, input || [{ json: {} }], report);
    } catch (failure) {
      if (failure instanceof NodeFailure) {
        report.status = 'error';
        report.error = failure.message;
        report.lastNodeExecuted = failure.node.name;
      } else {
        throw failure;
      }
    }

    return report;
  };

  Runner.prototype.walk = function (nodeName, items, report) {
    var node = this.nodesByName[nodeName];
    if (!node) return;

    var outputs = this.runNode(node, items, report);
    report.lastNodeExecuted = node.name;

    var connections = (this.workflow.connections[node.name] || {}).main || [];
    for (var outputIndex = 0; outputIndex < connections.length; outputIndex++) {
      var targets = connections[outputIndex] || [];
      var produced = outputs[outputIndex] || [];
      if (produced.length === 0) continue;
      for (var t = 0; t < targets.length; t++) {
        this.walk(targets[t].node, produced, report);
      }
    }
  };

  /* Executes a single node, applying its retry and error policy. */
  Runner.prototype.runNode = function (node, items, report) {
    var self = this;
    var clock = this.env.clock;
    var maxTries = node.retryOnFail ? (node.maxTries || 3) : 1;
    var waitBetweenTries = node.waitBetweenTries === undefined ? 1000 : node.waitBetweenTries;
    var onError = node.onError || 'stopWorkflow';

    var record = { node: node.name, type: node.type, attempts: 0, errors: [] };
    report.nodes.push(record);

    // Nodes that act on every item separately: one bad item must not decide
    // the fate of the others unless the workflow says so.
    var perItem = ['n8n-nodes-base.googleSheets', 'n8n-nodes-base.gmail', 'n8n-nodes-base.slack']
      .indexOf(node.type) !== -1;

    function attempt(runOnce) {
      var lastError = null;
      for (var tryIndex = 0; tryIndex < maxTries; tryIndex++) {
        record.attempts++;
        try {
          clock.advance(NODE_STEP_MS);
          return { ok: true, value: runOnce() };
        } catch (error) {
          lastError = error;
          record.errors.push(error.message);
          if (tryIndex < maxTries - 1) clock.advance(waitBetweenTries);
        }
      }
      return { ok: false, error: lastError };
    }

    if (perItem) {
      var okItems = [];
      var errorItems = [];
      for (var i = 0; i < items.length; i++) {
        (function (item) {
          var outcome = attempt(function () { return self.executeNode(node, [item])[0]; });
          if (outcome.ok) {
            okItems = okItems.concat(outcome.value);
          } else if (onError === 'continueErrorOutput') {
            var failed = clone(item.json) || {};
            failed.error = outcome.error.message;
            errorItems.push({ json: failed });
          } else if (onError === 'continueRegularOutput') {
            okItems.push(item);
          } else {
            throw new NodeFailure(node, outcome.error);
          }
        })(items[i]);
      }
      return [okItems, errorItems];
    }

    var result = attempt(function () { return self.executeNode(node, items); });
    if (result.ok) return result.value;

    if (onError === 'continueErrorOutput') {
      return [[], [{ json: { error: result.error.message } }]];
    }
    if (onError === 'continueRegularOutput') {
      return [[{ json: { error: result.error.message } }], []];
    }
    throw new NodeFailure(node, result.error);
  };

  /* The node implementations. Each returns an array of outputs. */
  Runner.prototype.executeNode = function (node, items) {
    var self = this;
    var env = this.env;
    var params = node.parameters || {};

    switch (node.type) {
      case 'n8n-nodes-base.scheduleTrigger':
      case 'n8n-nodes-base.errorTrigger':
        return [items];

      case 'n8n-nodes-base.httpRequest':
        return [this.executeHttpRequest(node, items)];

      case 'n8n-nodes-base.code':
        return [this.executeCode(node, items)];

      case 'n8n-nodes-base.splitOut': {
        var field = params.fieldToSplitOut;
        var out = [];
        items.forEach(function (item) {
          var value = item.json ? item.json[field] : undefined;
          if (Array.isArray(value)) {
            value.forEach(function (entry) { out.push({ json: entry }); });
          } else if (value !== undefined && value !== null) {
            out.push({ json: value });
          } else {
            // n8n fails the node when the field is missing; so does this runner.
            throw new Error("Split Out: the field '" + field + "' is not present in the input");
          }
        });
        return [out];
      }

      case 'n8n-nodes-base.if': {
        var trueItems = [];
        var falseItems = [];
        items.forEach(function (item) {
          (self.evaluateIf(params, item) ? trueItems : falseItems).push(item);
        });
        return [trueItems, falseItems];
      }

      case 'n8n-nodes-base.googleSheets': {
        var sheetName = locatorValue(params.sheetName);
        if (params.operation === 'append') {
          items.forEach(function (item) {
            env.sheetsAppend(sheetName, clone(item.json));
          });
          return [items];
        }
        if (params.operation === 'appendOrUpdate') {
          var matching = (params.columns && params.columns.matchingColumns) || [];
          if (matching.length !== 1) {
            throw new Error('Append or Update needs exactly one matching column');
          }
          items.forEach(function (item) {
            env.sheetsAppendOrUpdate(sheetName, clone(item.json), matching[0]);
          });
          return [items];
        }
        throw new Error('unsupported Google Sheets operation: ' + params.operation);
      }

      case 'n8n-nodes-base.gmail': {
        items.forEach(function (item) {
          var ctx = { $json: item.json, $now: nowHelper(env.clock) };
          env.gmailSend({
            to: resolveValue(params.sendTo, ctx),
            subject: resolveValue(params.subject, ctx),
            body: resolveValue(params.message, ctx),
            order_id: item.json ? item.json.order_id : undefined
          });
        });
        return [items];
      }

      case 'n8n-nodes-base.slack': {
        items.forEach(function (item) {
          var ctx = { $json: item.json, $now: nowHelper(env.clock) };
          env.slackPost(locatorValue(params.channelId), resolveValue(params.text, ctx));
        });
        return [items];
      }

      default:
        throw new Error('unsupported node type: ' + node.type);
    }
  };

  Runner.prototype.evaluateIf = function (params, item) {
    var conditions = (params.conditions && params.conditions.conditions) || [];
    var combinator = (params.conditions && params.conditions.combinator) || 'and';
    var env = this.env;
    var results = conditions.map(function (condition) {
      var ctx = { $json: item.json, $now: nowHelper(env.clock) };
      var left = resolveValue(condition.leftValue, ctx);
      var right = resolveValue(condition.rightValue, ctx);
      var operation = condition.operator ? condition.operator.operation : 'equals';

      switch (operation) {
        case 'true': return left === true;
        case 'false': return left === false;
        case 'equals': return left === right;
        case 'notEquals': return left !== right;
        case 'exists': return left !== undefined && left !== null && left !== '';
        case 'notExists': return left === undefined || left === null || left === '';
        case 'contains': return String(left).indexOf(String(right)) !== -1;
        case 'gt': return left > right;
        case 'lt': return left < right;
        default: throw new Error('unsupported IF operation: ' + operation);
      }
    });
    return combinator === 'or'
      ? results.some(Boolean)
      : results.every(Boolean);
  };

  Runner.prototype.executeHttpRequest = function (node, items) {
    var env = this.env;
    var params = node.parameters || {};
    var inputItem = items[0] || { json: {} };
    var options = params.options || {};

    function buildQuery(pageCount, lastResponse) {
      var query = {};
      var list = (params.queryParameters && params.queryParameters.parameters) || [];
      list.forEach(function (entry) {
        query[entry.name] = resolveValue(entry.value, {
          $json: inputItem.json,
          $now: nowHelper(env.clock),
          $pageCount: pageCount,
          $response: lastResponse
        });
      });
      if (params.authentication === 'genericCredentialType' && params.genericAuthType === 'httpHeaderAuth') {
        // The key lives in an n8n credential, not in the workflow: the runner
        // only sees that an auth header was attached.
        query.__hasAuthHeader = true;
      }
      return query;
    }

    var pagination = options.pagination && options.pagination.pagination;
    if (!pagination) {
      return [{ json: env.shopApiGet(buildQuery(0, undefined)) }];
    }

    var maxRequests = pagination.limitPagesFetched ? (pagination.maxRequests || 100) : 100;
    var collected = [];
    var pageCount = 0;
    var lastResponse;

    while (pageCount < maxRequests) {
      var extra = ((pagination.parameters && pagination.parameters.parameters) || []);
      var query = buildQuery(pageCount, lastResponse);
      extra.forEach(function (entry) {
        query[entry.name] = resolveValue(entry.value, {
          $json: inputItem.json,
          $now: nowHelper(env.clock),
          $pageCount: pageCount,
          $response: lastResponse
        });
      });

      var body = env.shopApiGet(query);
      collected.push({ json: body });
      lastResponse = { body: body };
      pageCount++;

      var complete = false;
      if (pagination.paginationCompleteWhen === 'other' && pagination.completeExpression) {
        complete = resolveValue(pagination.completeExpression, {
          $json: inputItem.json,
          $now: nowHelper(env.clock),
          $pageCount: pageCount,
          $response: lastResponse
        }) === true;
      }
      if (complete) break;
    }

    return collected;
  };

  Runner.prototype.executeCode = function (node, items) {
    var env = this.env;
    var self = this;
    var params = node.parameters || {};
    var mode = params.mode || 'runOnceForAllItems';
    var getStaticData = function () { return self.getStaticData(); };

    /* eslint-disable no-new-func */
    if (mode === 'runOnceForEachItem') {
      var out = [];
      items.forEach(function (item) {
        var fn = new Function('$json', '$getWorkflowStaticData', '$now', '$input',
          '"use strict";\n' + params.jsCode);
        var result = fn(item.json, getStaticData, nowHelper(env.clock), {
          item: item,
          all: function () { return items; }
        });
        out = out.concat(toItems(result));
      });
      return out;
    }

    var fnAll = new Function('$input', '$getWorkflowStaticData', '$now', '$json',
      '"use strict";\n' + params.jsCode);
    var resultAll = fnAll({
      all: function () { return items; },
      first: function () { return items[0]; },
      last: function () { return items[items.length - 1]; }
    }, getStaticData, nowHelper(env.clock), items[0] ? items[0].json : {});
    return toItems(resultAll);
  };

  root.PalewoodRunner = {
    Runner: Runner,
    resolveValue: resolveValue,
    NodeFailure: NodeFailure
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.PalewoodRunner;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
