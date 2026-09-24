/*
 * Mock versions of the four services the workflow talks to:
 * the shop API, Google Sheets, Gmail and Slack.
 *
 * They behave like the real ones in the ways that matter for this repair:
 * paging, a filter by timestamp, publishing lag, rate limits, outages and
 * permanent email bounces. Nothing leaves this file — no network calls, no
 * keys, no accounts.
 */
(function (root) {
  'use strict';

  var PAGE_SIZE = 25;

  function ServiceError(status, message) {
    var err = new Error(message);
    err.status = status;
    err.isServiceError = true;
    return err;
  }

  function activeFault(faults, nowMs) {
    for (var i = 0; i < faults.length; i++) {
      if (nowMs >= faults[i].from && nowMs < faults[i].to) return faults[i];
    }
    return null;
  }

  /*
   * A virtual clock. Retries and waits move it forward, so "retry 3 times,
   * 2 seconds apart" cannot survive a seven-minute outage — exactly as in
   * production.
   */
  function Clock(startMs) {
    this.ms = startMs;
  }
  Clock.prototype.now = function () { return this.ms; };
  Clock.prototype.advance = function (ms) { this.ms += ms; };
  Clock.prototype.set = function (ms) { this.ms = ms; };
  Clock.prototype.iso = function () { return new Date(this.ms).toISOString(); };

  function createEnvironment(options) {
    var orders = options.orders;
    var faults = options.faults;
    var clock = options.clock;

    var calls = { shopApi: 0, sheets: 0, gmail: 0, slack: 0 };
    var sheets = {};         // sheet name -> array of rows
    var emails = [];         // every accepted email
    var emailAttempts = [];  // every attempt, including failures
    var slackMessages = [];

    function shopApiGet(query) {
      calls.shopApi++;
      var now = clock.now();

      var fault = activeFault(faults.shopApi, now);
      if (fault) {
        throw ServiceError(fault.status, 'Shop API ' + fault.status + ': ' + fault.message);
      }

      if (!query.api_key && !query.__hasAuthHeader) {
        throw ServiceError(401, 'Shop API 401: missing API key');
      }

      var since = query.updated_since ? Date.parse(query.updated_since) : 0;
      var page = query.page ? parseInt(query.page, 10) : 1;
      if (!page || page < 1) page = 1;

      var visible = [];
      for (var i = 0; i < orders.length; i++) {
        var order = orders[i];
        if (order._available_at > now) continue;                  // not published by the shop yet
        var version = currentVersion(order, now);
        if (Date.parse(version.updated_at) < since) continue;     // outside the requested window
        visible.push(version);
      }

      visible.sort(function (a, b) {
        var diff = Date.parse(a.updated_at) - Date.parse(b.updated_at);
        return diff !== 0 ? diff : (a.id < b.id ? -1 : 1);
      });

      var start = (page - 1) * PAGE_SIZE;
      var slice = visible.slice(start, start + PAGE_SIZE);

      return {
        orders: slice,
        page: page,
        page_size: PAGE_SIZE,
        has_more: start + PAGE_SIZE < visible.length
      };
    }

    // The order as the shop would serve it right now: if the customer edited it
    // and the edit has been published, the same id comes back with a newer
    // updated_at — the shape of a real shop API, and the source of the duplicates.
    function currentVersion(order, now) {
      var payload = publicOrder(order);
      if (order._edit && order._edit.available_at <= now) {
        payload.updated_at = order._edit.updated_at;
        payload.revision = 2;
      } else {
        payload.revision = 1;
      }
      return payload;
    }

    // The API never exposes the internal bookkeeping fields.
    function publicOrder(order) {
      var copy = {};
      for (var key in order) {
        if (Object.prototype.hasOwnProperty.call(order, key) && key.charAt(0) !== '_') {
          copy[key] = order[key];
        }
      }
      return copy;
    }

    function sheetsAppend(sheetName, row) {
      calls.sheets++;
      if (!sheets[sheetName]) sheets[sheetName] = [];
      sheets[sheetName].push({ at: clock.iso(), row: row });
      return { updated: true, sheet: sheetName };
    }

    // Google Sheets "Append or Update": rewrite the row whose matching column
    // holds the same value, otherwise add one.
    function sheetsAppendOrUpdate(sheetName, row, matchColumn) {
      calls.sheets++;
      if (!sheets[sheetName]) sheets[sheetName] = [];
      var key = row ? row[matchColumn] : undefined;

      if (key !== undefined) {
        for (var i = 0; i < sheets[sheetName].length; i++) {
          if (sheets[sheetName][i].row && sheets[sheetName][i].row[matchColumn] === key) {
            sheets[sheetName][i] = { at: clock.iso(), row: row, replaced: true };
            return { updated: true, sheet: sheetName, matched: true };
          }
        }
      }

      sheets[sheetName].push({ at: clock.iso(), row: row });
      return { updated: true, sheet: sheetName, matched: false };
    }

    function gmailSend(message) {
      calls.gmail++;
      var now = clock.now();
      var to = String(message.to || '').trim();

      var attempt = { at: clock.iso(), to: to, subject: message.subject, order_id: message.order_id };

      if (!to || to.indexOf('@') === -1) {
        attempt.result = 'rejected';
        attempt.reason = 'Gmail 400: invalid To header "' + to + '"';
        emailAttempts.push(attempt);
        throw ServiceError(400, attempt.reason);
      }

      if (/@invalid-domain\.test$/.test(to)) {
        attempt.result = 'bounced';
        attempt.reason = 'Gmail 550: recipient address rejected (domain does not exist)';
        emailAttempts.push(attempt);
        throw ServiceError(550, attempt.reason);
      }

      var fault = activeFault(faults.gmail, now);
      if (fault) {
        attempt.result = 'rate-limited';
        attempt.reason = 'Gmail ' + fault.status + ': ' + fault.message;
        emailAttempts.push(attempt);
        throw ServiceError(fault.status, attempt.reason);
      }

      attempt.result = 'sent';
      emailAttempts.push(attempt);
      emails.push({ at: clock.iso(), to: to, subject: message.subject, body: message.body, order_id: message.order_id });
      return { id: 'gmail-' + emails.length };
    }

    function slackPost(channel, text) {
      calls.slack++;
      slackMessages.push({ at: clock.iso(), channel: channel, text: text });
      return { ok: true };
    }

    return {
      clock: clock,
      calls: calls,
      shopApiGet: shopApiGet,
      sheetsAppend: sheetsAppend,
      sheetsAppendOrUpdate: sheetsAppendOrUpdate,
      gmailSend: gmailSend,
      slackPost: slackPost,
      state: {
        sheets: sheets,
        emails: emails,
        emailAttempts: emailAttempts,
        slackMessages: slackMessages
      }
    };
  }

  root.PalewoodServices = {
    Clock: Clock,
    ServiceError: ServiceError,
    createEnvironment: createEnvironment,
    PAGE_SIZE: PAGE_SIZE
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.PalewoodServices;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
