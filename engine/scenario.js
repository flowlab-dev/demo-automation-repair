/*
 * Palewood Ceramics — one 5-hour shift of real-looking shop traffic.
 *
 * Everything here is deterministic: the same seed always produces the same
 * orders, the same timestamps and the same outages. Both versions of the
 * workflow are run against this identical scenario, so any difference in the
 * results comes from the workflows themselves.
 *
 * The company, the customers and the orders are invented for this demo.
 */
(function (root) {
  'use strict';

  var SHIFT_START = Date.parse('2026-09-15T08:00:00.000Z'); // Monday, start of shift
  var RUN_INTERVAL_MS = 5 * 60 * 1000;                      // schedule trigger: every 5 minutes
  var RUN_COUNT = 60;                                       // 5 hours
  var ORDER_COUNT = 120;

  // Deterministic pseudo-random generator (mulberry32).
  function rng(seed) {
    return function () {
      seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var FIRST_NAMES = ['Mara', 'Tobias', 'Ines', 'Noor', 'Jonas', 'Alba', 'Henrik', 'Sofia',
    'Emil', 'Clara', 'Ruben', 'Lena', 'Otto', 'Nadia', 'Kasper', 'Elif', 'Pia', 'Milan'];
  var LAST_NAMES = ['Vester', 'Holm', 'Barros', 'Kaya', 'Lindqvist', 'Moreau', 'Dahl', 'Rossi',
    'Berger', 'Novak', 'Okafor', 'Sandberg', "O'Neill", 'Werner', 'Falk', 'Duarte'];
  var PRODUCTS = [
    { sku: 'PW-MUG-STONE', name: 'Stoneware mug', price: 28 },
    { sku: 'PW-BOWL-ASH', name: 'Ash-glazed bowl', price: 46 },
    { sku: 'PW-PLATE-SAND', name: 'Sand dinner plate', price: 39 },
    { sku: 'PW-VASE-SMOKE', name: 'Smoke-fired vase', price: 124 },
    { sku: 'PW-JUG-MILK', name: 'Milk jug', price: 52 },
    { sku: 'PW-SET-TEA4', name: 'Tea set for four', price: 168 }
  ];

  /*
   * Orders that reproduce the four complaints the owner reported.
   * Index = position in the generated order list (0-based).
   */
  var EDITED_BY_CUSTOMER = [11, 38, 62, 97];   // customer changed the delivery address a few minutes later
  var PUBLISHED_LATE = [27, 54, 88];           // the shop's queue exposed them to the API 7-9 minutes late
  var MISSING_LAST_NAME = 46;                  // single-name customer
  var MISSING_PHONE = 63;                      // phone is an optional field in the checkout
  var MISSING_EMAIL = 101;                     // typo swallowed the address
  var HARD_BOUNCE_EMAIL = 74;                  // address exists in the order but bounces permanently

  function buildOrders() {
    var rand = rng(20260915);
    var orders = [];

    for (var i = 0; i < ORDER_COUNT; i++) {
      // Orders arrive unevenly across the shift, as real shop traffic does.
      var offset = Math.floor((i + rand()) * ((RUN_COUNT * RUN_INTERVAL_MS) / (ORDER_COUNT + 6)));
      var createdAt = SHIFT_START + offset + Math.floor(rand() * 45000);

      var itemCount = 1 + Math.floor(rand() * 3);
      var lineItems = [];
      var total = 0;
      for (var k = 0; k < itemCount; k++) {
        var product = PRODUCTS[Math.floor(rand() * PRODUCTS.length)];
        var qty = 1 + Math.floor(rand() * 2);
        lineItems.push({ sku: product.sku, name: product.name, qty: qty, price_eur: product.price });
        total += product.price * qty;
      }

      var first = FIRST_NAMES[Math.floor(rand() * FIRST_NAMES.length)];
      var last = LAST_NAMES[Math.floor(rand() * LAST_NAMES.length)];
      var id = 'PC-' + (10001 + i);

      // The shop's queue publishes an order to the API a few seconds after it is
      // written — how long varies with load. This ordinary jitter is what makes a
      // fixed "last N minutes" window unsafe in both directions.
      var availableAt = createdAt + Math.floor((5 + rand() * 50) * 1000);
      var publishedLate = PUBLISHED_LATE.indexOf(i) !== -1;
      if (publishedLate) {
        availableAt = createdAt + (7 + Math.floor(rand() * 3)) * 60 * 1000; // 7-9 minutes late
      }

      // Some customers change their delivery address minutes after ordering. The
      // shop then exposes the same order id again with a newer updated_at — which
      // is where duplicate rows and duplicate emails come from.
      var edit = null;
      if (EDITED_BY_CUSTOMER.indexOf(i) !== -1) {
        var editedAt = createdAt + (2 + Math.floor(rand() * 3)) * 60 * 1000;
        edit = {
          updated_at: new Date(editedAt).toISOString(),
          available_at: editedAt + Math.floor((5 + rand() * 50) * 1000)
        };
      }

      var email = (first + '.' + last).toLowerCase().replace(/[^a-z.]/g, '') + i + '@example.com';
      var phone = '+49 30 ' + (1000000 + Math.floor(rand() * 8999999));

      var customer = {
        first_name: first,
        last_name: last,
        email: email,
        phone: phone
      };

      if (i === MISSING_LAST_NAME) { delete customer.last_name; }
      if (i === MISSING_PHONE) { delete customer.phone; }
      if (i === MISSING_EMAIL) { customer.email = ''; }
      if (i === HARD_BOUNCE_EMAIL) { customer.email = 'bounce.' + customer.email.replace('@example.com', '@invalid-domain.test'); }

      orders.push({
        id: id,
        customer: customer,
        line_items: lineItems,
        total_eur: total,
        currency: 'EUR',
        created_at: new Date(createdAt).toISOString(),
        updated_at: new Date(createdAt).toISOString(),
        // Not part of the API payload — the mock shop uses these to decide when the
        // order becomes visible and which version it serves. Stripped before the
        // order is handed to a workflow.
        _available_at: availableAt,
        _edit: edit,
        _published_late: publishedLate
      });
    }

    return orders;
  }

  /*
   * Outages injected into the mock services. Windows are absolute virtual time,
   * so a retry that waits two seconds does not escape a seven-minute outage.
   */
  function buildFaults() {
    return {
      shopApi: [
        {
          from: Date.parse('2026-09-15T08:50:00.000Z'),
          to: Date.parse('2026-09-15T08:57:00.000Z'),
          status: 503,
          message: 'Service Unavailable — shop host restarting',
          label: 'Shop hosting restarted (7 minutes)'
        },
        {
          from: Date.parse('2026-09-15T09:35:00.000Z'),
          to: Date.parse('2026-09-15T09:35:04.000Z'),
          status: 429,
          message: 'Too Many Requests — shop API rate limit',
          label: 'Shop API rate limit (4 seconds)'
        },
        {
          from: Date.parse('2026-09-15T11:20:00.000Z'),
          to: Date.parse('2026-09-15T11:20:03.000Z'),
          status: 502,
          message: 'Bad Gateway — shop API hiccup',
          label: 'Shop API hiccup (3 seconds)'
        }
      ],
      gmail: [
        {
          from: Date.parse('2026-09-15T08:25:00.000Z'),
          to: Date.parse('2026-09-15T08:25:03.000Z'),
          status: 429,
          message: 'Gmail API quota exceeded, retry later',
          label: 'Gmail quota (3 seconds)'
        },
        {
          from: Date.parse('2026-09-15T10:40:00.000Z'),
          to: Date.parse('2026-09-15T10:40:06.000Z'),
          status: 429,
          message: 'Gmail API quota exceeded, retry later',
          label: 'Gmail quota (6 seconds)'
        }
      ]
    };
  }

  function buildRuns() {
    var runs = [];
    for (var i = 0; i < RUN_COUNT; i++) {
      runs.push(SHIFT_START + i * RUN_INTERVAL_MS);
    }
    return runs;
  }

  root.PalewoodScenario = {
    SHIFT_START: SHIFT_START,
    RUN_INTERVAL_MS: RUN_INTERVAL_MS,
    RUN_COUNT: RUN_COUNT,
    ORDER_COUNT: ORDER_COUNT,
    buildOrders: buildOrders,
    buildFaults: buildFaults,
    buildRuns: buildRuns,
    marked: {
      editedByCustomer: EDITED_BY_CUSTOMER,
      publishedLate: PUBLISHED_LATE,
      missingLastName: MISSING_LAST_NAME,
      missingPhone: MISSING_PHONE,
      missingEmail: MISSING_EMAIL,
      hardBounceEmail: HARD_BOUNCE_EMAIL
    }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.PalewoodScenario;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
