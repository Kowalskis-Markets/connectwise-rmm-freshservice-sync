# ConnectWise RMM → Freshservice Sync

A serverless Freshservice custom app (Freshworks FDK, platform 3.0) that imports ConnectWise RMM (Asio platform) tickets into Freshservice.

By default, each imported ticket is closed in ConnectWise, so Freshservice becomes the place it gets worked. If you turn that off, tickets stay open in ConnectWise, and the app resolves the Freshservice ticket when ConnectWise closes it.

## What it does

Every poll (5–60 minutes) runs two passes:

| Pass | Behavior |
|---|---|
| Import | Lists open ConnectWise tickets updated since the last poll and creates a Freshservice ticket for each one not yet imported. If **Close after import** is on (the default), it then moves the ConnectWise ticket to Closed. |
| Resolve | Lists ConnectWise tickets that moved into a Closed-category status since the last poll and resolves their Freshservice tickets with a private note. Tickets the app closed itself are skipped, so this only affects tickets left open in ConnectWise. |

**Open** means any status outside ConnectWise's **Closed** status category. To close a ticket, the app uses the active Closed-category status named "Closed", or the first active Closed-category status if there's no "Closed".

Imported Freshservice tickets get:
- **Subject:** `[CW <number>] <summary>`
- **Tags:** `connectwise-rmm` and `cw-<number>`
- **Description:** the ConnectWise description, plus the ticket number, company name (if permitted), priority and created date
- **Priority:** Critical/Urgent → Urgent, High → High, Medium/Normal → Medium, Low → Low, anything else → Medium
- **Requester:** the default requester email. ConnectWise tickets carry no contact email.

> **The first poll imports every open ConnectWise ticket.** With **Close after import** on, it also closes all of them in ConnectWise. If that isn't what you want, install with **Close after import** off and check the results first.

ConnectWise has no ticket delete scope, which is why the app closes tickets instead of deleting them. The Platform API also has no ticket webhooks, so everything runs on the poll. The app accepts optional ticket create/close events posted to its external event URL (logged at install) from anything else that can send them.

## Setup

1. **ConnectWise RMM:** create an API client with the **Platform - Tickets - Read** and **Platform - Tickets - Update** scopes (`platform.tickets.read platform.tickets.update`). Optionally add `platform.companies.read` to include company names. The app doesn't need the Create scope.
2. **Freshservice:** copy the API key of the agent the app will act as.
3. **Build and upload:** run `fdk pack` (see [Development](#development)) and upload `dist/connectwise-rmm-freshservice-sync.zip` as a Freshservice custom app.
4. **Install** the app and fill in the settings:

| Setting | Notes |
|---|---|
| ConnectWise RMM API region | NA, EU, or AU host |
| Client ID / secret | From step 1 |
| Token scope | Must match the API client's scopes, space separated |
| Freshservice domain | Host only, e.g. `acme.freshservice.com` (no `https://`) |
| Freshservice API key | From step 2 |
| Close tickets after import | Default **on** |
| Resolve sync | Default **on** |
| Poll interval | 5 minutes minimum (an FDK limit). Changes take effect on the next poll. |
| Default requester email | Requester for every imported ticket |
| Group ID | Optional Freshservice agent group for imported tickets |
| Webhook shared secret | Optional. When set, external event calls must send it as the `X-Webhook-Secret` header or a `secret` body field. |

Installation requests a ConnectWise token, lists one ticket, and reads from Freshservice. If any of these fail, install stops and shows the error, so a wrong region, missing scope or bad key surfaces immediately. The first poll runs about a minute after install.

Each poll logs a summary such as `ConnectWise poll: {"imported":3,"closed":3,"resolved":0,"errors":[],"stopped":null}`. Per-ticket failures appear in `errors`. Uninstalling removes the poll schedule.

## Development

```sh
npm install -g @freshworks/fdk   # FDK 10 CLI (Node 24, e.g. `nvm use 24`)
npm install                       # vitest + coverage
npm test                          # unit tests
fdk validate
fdk unit-test                     # unit tests with coverage (≥80% required by fdk pack)
fdk run                           # http://localhost:10001/custom_configs to set iparams,
                                  # http://localhost:10001/web/test to fire events from server/test_data
fdk pack                          # builds dist/connectwise-rmm-freshservice-sync.zip
```

`fdk pack` also requires at least 50% *simulation* coverage. That comes from firing events in `fdk run` and then stopping the server. Events only reach the success paths when the outbound calls succeed, so use real sandbox credentials (with **Close after import** off) or a local HTTPS mock. `fdk run` stores the settings you enter in `.fdk/` in plain text. That folder is git-ignored; keep it that way.

### FDK sandbox rules

Server code runs in FDK's sandbox, not in plain Node:
- Local modules are evaluated as `var exports = {}; …; return exports`, so they export with `Object.assign(exports, { … })`. There is no `module` object.
- `console` only has `log`, `info`, and `error`.

`tests/server.test.js` loads the app the same way, so a violation fails the tests.

### Layout

```
config/iparams.json         install settings
config/requests.json        every HTTP endpoint (ConnectWise + Freshservice request templates)
server/server.js            FDK event handlers, poll schedule
server/lib/connectwise.js   token caching, statuses, ticket list/get/close, company names, field mapping
server/lib/freshservice.js  create / resolve / note
server/lib/mapping.js       ConnectWise ticket → Freshservice payload, priority mapping
server/lib/sync.js          import and resolve passes, external events
server/lib/store.js         $db keys (ticket mappings, scan cursors, token, statuses, company names, schedule)
tests/                      unit tests with fake $db / $request backends
```

### ConnectWise API

Built against the ConnectWise Platform APIs OpenAPI spec (v3.0.4). Paths are in `config/requests.json`, and field names are in `server/lib/connectwise.js`.

| Use | Call |
|---|---|
| Token | `POST /v1/token` (JSON body) |
| Closed statuses | `GET /api/platform/v1/service/ticketing/statuses` → `category == "Closed"` (cached for an hour) |
| Open tickets | `GET /api/platform/v2/service/ticketing/tickets?statusIds=[notIn],<closed ids>&updatedAtFrom=<cursor>&sortBy=updatedAt&sortDir=asc&pageNum&pageSize` |
| Recently closed tickets | Same, with `statusIds=<closed ids>` |
| One ticket | `GET /api/platform/v2/service/ticketing/tickets/{id}` |
| Close | `PATCH /api/platform/v2/service/ticketing/tickets/{id}` with `[{"op":"replace","path":"/status","value":{"id":…,"name":…}}]` |
| Company name | `GET /api/platform/v1/company/companies/{id}` (optional) |

### Notes

- The ConnectWise client secret is a regular (not secure) install parameter. FDK only allows secure parameters in request headers, and the token call needs the secret in the request body.
- Each poll stops starting new work after 15 seconds (the FDK limit is 20). On HTTP 429 it stops and continues on the next poll.
- Both passes walk tickets oldest-first from a saved cursor. They page by `updatedAtFrom` (keyset paging), so tickets updated mid-scan can't be skipped, and they save progress as they go, so a large backlog is worked through across several polls. The cursor stops at the first ticket that fails (import, close or resolve), so that ticket is retried on the next poll. A ticket that fails every time holds the cursor there, and its error appears in each poll's log until it's fixed.
- If Freshservice requires fields on resolution (for example category), the resolve call fails and is logged. Either make those fields optional for this agent or extend `freshservice.resolveTicket`.
