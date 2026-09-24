# Palewood — broken n8n order intake, repaired

> **Self-initiated demo by [Flow Lab](https://flowlab-dev.github.io) - not client work.** The company in it is invented.
> Live demo: https://flowlab-dev.github.io/demo/automation-repair/ · Case study: https://flowlab-dev.github.io/work/automation-repair/ · License: MIT


A repair demo: a real-shaped n8n automation that quietly lost orders, the root cause of each
failure, and the repaired version — with both replayed over the same shift so the difference
can be counted instead of claimed.

**Palewood Ceramics is an invented company.** The orders, customers and outages come from
`engine/scenario.js`. No network calls, no accounts, no keys: the API key in the broken
workflow is literally `pk_live_EXAMPLE_NOT_A_REAL_KEY_7f3c2a`.

## Open it

Double-click `index.html`. No internet, no install, no build step. Press **Run both versions**.

## What is in here

| Path | What it is |
|---|---|
| `index.html` | the repair report, with the replay |
| `workflows/order-intake-BROKEN.json` | the automation as it arrived, in n8n's export format |
| `workflows/order-intake-FIXED.json` | the repaired version |
| `workflows/error-handler.json` | the error workflow the repaired version points at |
| `engine/runner.js` | a small n8n runner: it executes the JSON files above |
| `engine/services.js` | mock shop API, Google Sheets, Gmail and Slack, with scripted outages |
| `engine/scenario.js` | the shift: 120 orders, 60 runs, the outages and the awkward orders |
| `engine/simulation.js` | runs one workflow over the whole shift and counts the result |
| `engine/workflows.embedded.js` | generated copy of the three JSON files, so the page works over `file://` |
| `tests/run-tests.js` | 38 checks: the defects are really in the file, the fixes are really in the file, and both runs produce exactly the numbers quoted in the documents |
| `tests/page-tests.js` | 7 checks of the page itself, with an emulated DOM |
| `build-embedded.js` | regenerates `engine/workflows.embedded.js` after editing a workflow |

## Run the checks

```
node tests/run-tests.js     # workflows + both runs
node tests/page-tests.js    # page logic
node build-embedded.js      # after changing any workflow JSON
```

## How the replay works, and what it does not do

The runner walks the nodes and connections of the JSON files, evaluates the same `{{ … }}`
expressions and actually executes the JavaScript inside the Code nodes. Both versions get an
identical shift: same orders, same timestamps, same outages, same virtual clock — so a retry
two seconds apart cannot escape a seven-minute outage.

It is **not** n8n. It covers the nine node types these workflows use — Schedule Trigger, Error
Trigger, HTTP Request, Code, Split Out, IF, Google Sheets, Gmail and Slack — and does not
reproduce n8n's queue mode, concurrency or UI.

Two things to be exact about:

- The workflow files are **written in n8n's export format and have not been opened inside a
  running n8n instance** for this demo. Import them with *Workflows → Import from file*; treat
  the canvas as untested and the logic as tested. After importing, repoint
  `settings.errorWorkflow` at your own copy of `error-handler.json`.
- The runner **retries the item that failed**, while n8n retries the whole node and can repeat
  items that already succeeded. For nodes with a side effect — sending email — the production
  build should loop over orders one at a time; that is listed as remaining work in
  `../REPAIR-REPORT.md`, not something this replay claims to have proven.

One n8n quirk worth knowing before testing it there: the cursor and the memory of handled
orders live in the workflow's static data, which n8n keeps for production executions of an
active workflow, not for manual runs from the editor.

## Numbers from the last run

| | Broken (v3) | Repaired (v4) |
|---|---|---|
| Orders lost for good | 14 of 120 | 0 |
| Revenue in the lost orders | EUR 2,504 | EUR 0 |
| Customers emailed twice | 6 | 0 |
| Duplicate rows in the sheet | 6 | 0 |
| Rows rewritten after a customer edit | 0 | 4 |
| Runs that stopped with an error | 10 | 0 |
| Failures nobody was told about | 10 | 0 |
| Alerts raised in Slack | 0 | 4 |

Re-run `node tests/run-tests.js` to reproduce them; the scenario is deterministic.
