# Chola MS (Cholamandalam MS General Insurance) — Health

Migrated from the standalone `novacred-insurance-integrations` service
(`src/providers/chola/*`), where the SPA reached it on its own port (4002) as
`/api/chola/*`. Follows the IFFCO Tokio, Future Generali and ICICI migrations:
the routes and the base URL move; Chola's request bodies, the normalised
responses, the error envelope, the error codes, the PolicyGeneration
send-once rules and the evidence log are unchanged on both sides of the hop.

Served under `/chola-ms/*` and the `/health` alias, as its own router. An
unconfigured deployment answers 503 on its own paths and nothing else is
affected.

OAuth2-authenticated REST/JSON. Three health products share one flow; CKYC lives
on a separate e-policy portal with its own auth.

## Files

| File | Role |
|---|---|
| `src/routes/chola.routes.js` | Route table |
| `src/controllers/chola.controller.js` | Envelopes, `cholaRequest`, audit rows, ops key guard, ops screen, config probe |
| `src/services/cholaApi.service.js` | `callChola` (Bearer, 401 refresh, evidence hook, empty-body guard) + PremiumComputation / ProposalSave / PolicySchedule |
| `src/services/cholaPolicyIssuer.service.js` | PolicyGeneration — the website's path and the backend-built (APD) one: claim, send once, outcome, schedule + PDF, evidence |
| `src/services/cholaCkyc.service.js` | CKYC Auth / Verify / Query, TokenKey cache and re-auth |
| `src/services/cholaAuth.service.js` | OAuth2 `client_credentials` token cache |
| `src/services/cholaHttp.service.js` | Retries, timeouts, request/response logging |
| `src/helpers/chola.helper.js` | Typed errors, field guards, response readers, URL rewrite, CKYC date + token-rejection rules |
| `src/helpers/cholaPolicyGeneration.helper.js` | PolicyGeneration body builder and outcome readers (pure) |
| `src/repositories/chola.repository.js` | `health_chola_proposals`, `health_chola_policy_generation_logs` |
| `src/constants/chola.constants.js` | Products, operations, payment modes, per-product field spellings |
| `src/ops/chola.html`, `src/ops/chola-ops.js` | Ops screen (`GET /chola-ms/ops`) |
| `migrations/005_create_chola_policy_generation_tables.sql` | The two tables |
| `src/config/{defaults,env,validate}.js` | `CHOLA_DEFAULTS`, `config.chola`, boot report |
| `scripts/test-chola.js` | Offline suite against a mock Chola (`npm run test:chola`) |
| `scripts/smoke-chola.js` | Read-only UAT smoke (`npm run smoke:chola [token\|quote\|all]`) |
| `scripts/uat-chola-apd.js` | One Flexi Health case end to end in APD — ⚠️ spends UAT deposit (`npm run uat:chola:apd`) |

Where the old files went:

| `novacred-insurance-integrations` | Here |
|---|---|
| `providers/chola/constants.js` | `constants/chola.constants.js` (paths → `config/defaults.js`) |
| `providers/chola/authService.js` | `services/cholaAuth.service.js` |
| `providers/chola/cholaClient.js` + `core/httpClient.js` | `services/cholaApi.service.js` `callChola` + `services/cholaHttp.service.js` |
| `providers/chola/cholaAdapter.js` | `services/cholaApi.service.js` (quote/proposal/schedule), `services/cholaPolicyIssuer.service.js` (`issuePolicy`) |
| `providers/chola/ckycService.js` | `services/cholaCkyc.service.js` (+ `toPortalDate`, `tokenRejection` in the helper) |
| `providers/chola/policyIssuer.js`, `policyGenerationBody.js` | `services/cholaPolicyIssuer.service.js`, `helpers/cholaPolicyGeneration.helper.js` |
| `providers/chola/parsers/responseParser.js`, `core/errors.js`, `core/validate.js` | `helpers/chola.helper.js` |
| `repositories/chola.repository.js`, `migrations/002_…` | `repositories/chola.repository.js`, `migrations/005_…` |
| `middleware/requireOpsKey.js` | `controllers/chola.controller.js` `requireOpsKey` |
| `ops/chola.html` | `ops/chola.html` + `ops/chola-ops.js` (helmet's CSP blocks inline scripts) |
| `index.js` Chola routes, `services/integrationService.js` registry | `routes/chola.routes.js`, `routes/index.js` `createCholaRouter`, `app.js` |
| `test/chola/*.test.js` (jest + nock) | `scripts/test-chola.js` (no framework, local mock) |
| `ENABLED_PROVIDERS` | dropped — here an insurer is on when it is configured |

## Routes

Each operation is served under Chola's own operation name (so the browser's
Network tab reads as the Chola API behind it, as the NivaBupa KYC routes do) and
under the short name the SPA's `api/chola.js` calls. Same handler.

| Method | This service | Was (`:4002`) | Chola API |
|---|---|---|---|
| GET  | `/chola-ms/config/test` | — | none (reports config, prints no values) |
| POST | `/chola-ms/PremiumComputation` · `/chola-ms/quote` | `/api/chola/PremiumComputation` · `/api/chola/quote` | `/endpoint/<product>/v1.0.0/PremiumComputation` |
| POST | `/chola-ms/CholaMS_CKYC_Verify` · `/chola-ms/ckyc/verify` | `/api/chola/CholaMS_CKYC_Verify` · `/api/chola/ckyc/verify` | CKYC `/Epolicyv3API/api/KYC/CholaMS_CKYC_Verify` |
| POST | `/chola-ms/CholaMS_CKYC_Query` · `/chola-ms/ckyc/query` | `/api/chola/CholaMS_CKYC_Query` · `/api/chola/ckyc/query` | CKYC `/Epolicyv3API/api/KYC/CholaMS_CKYC_Query` |
| POST | `/chola-ms/ProposalSave` · `/chola-ms/proposal` | `/api/chola/ProposalSave` · `/api/chola/proposal` | `/endpoint/<product>/v1.0.0/ProposalSave` (Super Topup: `CHOLA_TOPUP_PROPOSAL_URL`) |
| POST | `/chola-ms/PolicyGeneration` · `/chola-ms/issue` | `/api/chola/PolicyGeneration` · `/api/chola/issue` | `/endpoint/<product>/v1.0.0/PolicyGeneration` |
| POST | `/chola-ms/PolicySchedule` · `/chola-ms/policy/schedule` | `/api/chola/PolicySchedule` · `/api/chola/policy/schedule` | `/endpoint/<product>/v1.0.0/PolicySchedule` |
| POST | `/chola-ms/ops/PolicyGeneration` | `/api/chola/ops/PolicyGeneration` | PolicyGeneration, built by the backend |
| GET  | `/chola-ms/ops/proposals` | `/api/chola/ops/proposals` | — |
| GET  | `/chola-ms/ops/proposals/:no/PolicyGeneration` | `/api/chola/ops/proposals/:no/PolicyGeneration` | — |
| GET  | `/chola-ms/ops/PolicyGeneration/logs` | `/api/chola/ops/PolicyGeneration/logs` | — |
| GET  | `/chola-ms/ops/proposals/:no/pdf` | `/api/chola/ops/proposals/:no/pdf` | — |
| GET  | `/chola-ms/ops` | `/ops/chola` | the ops screen |

Every route is also served under `/health/chola-ms/*`. Token:
`POST /oauth2/token`; CKYC auth: `POST /epolicyv3api/api/KYC/CholaMS_CKYC_Auth`.

`<product>` by the body's `product` key (stripped before sending; default
`FLEXI_HEALTH`):

| `product` | Path segment | Label |
|---|---|---|
| `FLEXI_HEALTH` | `Health-flexiretail` | Chola Flexi Health (Retail) |
| `SUPREME` | `health-flexi-supreme` | Chola Flexi Health Supreme |
| `SUPER_TOPUP` | `Health-supertopup` | Chola Flexi Super Topup |

Only Flexi Health answers on the NovaCred credentials (Supreme 404, Super Topup
403), so the other two response shapes are unobserved; `data.raw` always carries
the untouched body.

## The flow

```
PremiumComputation ──► CKYC ──► ProposalSave ──► PolicyGeneration ──► (payment) ──► PolicySchedule
                                    │                  │                               │
                           GENCONProposalNumber ───────┘                         PolicyNumber
                           + re-priced premium (tag THIS amount)
```

1. **PremiumComputation** — pricing only. `IntermediaryCode` injected from config
   when omitted (the caller's own wins).
2. **CKYC Verify** — answers a CKYC number or an eKYC redirection URL; **Query**
   reads the hosted page's outcome by `App_Ref_No` (`Transaction_ID` is an echo,
   never a lookup key).
3. **ProposalSave** — returns `GENCONProposalNumber` (all-caps) and Chola's
   **re-priced** premium. `GENCONProposalNumber: 0` means rejected.
4. **PolicyGeneration** — ⚠️ **not idempotent** (a second call fails on
   `INS.UK_WS_PORTAL_PAY`). With `PayMode: "Chola"` it answers Chola's hosted
   payment URL; with `"Direct"` the policy number; under APD, see below.
5. **PolicySchedule** — by **policy** number. A proposal number answers HTTP 200
   with both URLs empty.

Dates are `dd/MM/yyyy` in product payloads. CKYC `DOB_DOI` must be
`DD-MMM-YYYY` — the kit documents `dd-MM-yyyy`, which the portal rejects — so
`dd-MM-yyyy`, `dd/MM/yyyy` and ISO are converted; anything ambiguous is passed
through for Chola to name.

## Payment and the return

**There is no Chola payment callback route, and none is missing.**
PolicyGeneration takes no return URL. Chola's hosted page returns the buyer to
the SPA's own `/chola-return` page, which reads whatever Chola append; Chola
publish no status API to confirm it against. The standalone service had no
callback either.

⚠️ **The PG payment URL is not reachable.** With `PayMode: "Chola"`, `URL` comes
back as `http://10.105.63.69/websales/frmTermsandCondition.aspx?SOURCE=INTEGRATION&TRANSID=<proposal>`
— an internal address no buyer's browser can resolve. PolicySchedule's links are
on the same host. `CHOLA_PUBLIC_URL_BASE` rewrites scheme/host once Chola supply
a public websales host; it is deliberately unset until then
(`uatportal.cholainsurance.com` serves the path but answers "session expired").
**Not fixable from our side — ask Chola.**

### Payment modes and APD

`CHOLA_PAYMENT_MODE` sets how the **backend** tags payment when it builds
PolicyGeneration itself: `PG_CHOLA` (default), `PG_DIRECT` or `APD`. Under
`PG_CHOLA` and `PG_DIRECT` the website sends its own PG request, and the website
route accepts `TaggingMode` PG only.

Under `APD` the website route ignores the browser's tagging fields and issues
through the backend, exactly as the ops route does, taking only `product`,
`GenconProposalNumber` and `Amount`. The answer keeps the website envelope and
adds `paymentMode: "APD"`, `outcome` and `schedule`; on success
`genconPolicyNumber` is set and `paymentUrl` is null. The browser can never ask
for APD itself: `TaggingMode: "APD"` is refused.

**APD** (Advance Premium Deposit) debits NovaCred's deposit with Chola — no
payment page, no redirect, policy number on the same call. It works on UAT for
NovaCred's intermediary code (see *UAT evidence* below). APD is refused when
`NODE_ENV=production`.

**Sent once.** The backend path claims the proposal in `health_chola_proposals`
before sending, sends with **no transport retry** and a 120 s budget
(`CHOLA_POLICY_GENERATION_TIMEOUT_MS`). The outcome is one of:

- `POLICY_ISSUED` — Success with a policy number. PolicySchedule is fetched and
  the PDF stored if its host is reachable.
- `PAYMENT_FAILED` — Chola refused it (APD not mapped, insufficient balance,
  invalid tagging mode), or it was never sent. The only state a person can
  re-send from.
- `NEEDS_REVIEW` — a timeout, a 5xx, or Success without a policy number. Chola
  may have debited the deposit; reconcile with them and never re-send.

**Evidence.** Every PolicyGeneration exchange, website and ops alike, is written
to `health_chola_policy_generation_logs`: request and response bodies exactly as
sent and received, product, proposal number, millisecond timestamp; the bearer
token masked. Needs `npm run migrate` (migration 005).

⚠️ **The website's PG path keeps the standalone service's retries.** It is not
claimed, and `CHOLA_MAX_RETRIES` still applies to it on transport failures and
HTTP 502/503/504 — preserved because the migration does not change business
behaviour. Chola refuse a duplicate with `INS.UK_WS_PORTAL_PAY`, so a replay
fails rather than double-tags, but whether to run that path with no retry is a
decision worth making deliberately; it has not been made here.

**Field spellings per product** live in `CHOLA_POLICY_GENERATION_FIELDS`, the
same map the website's PG builder uses. Flexi Health sends `"ChequeorDDnumber "`
(trailing space), `BTAdvicenumber` and `Dateoftransaction`; Supreme
`ChequeOrDDNumber`, `BTAdviceNumber` (0) and `Dateoftransaction`; Super Topup
`ChequeOrDDNumber`, `BTAdviceNumber` ("0") and `DateOfTransaction`.

### Ops

`POST /chola-ms/ops/PolicyGeneration` with header `X-Ops-Key: $CHOLA_OPS_KEY`
and `{ product, GenconProposalNumber, Amount }` issues in the configured mode.
The ops routes answer 503 while `CHOLA_OPS_KEY` is unset and 401 without the
right key. The screen at `GET /chola-ms/ops` (or `/health/chola-ms/ops`) lists
tagged proposals, their evidence and stored PDFs.

## Responses

Success — the standalone service's envelope, unchanged:

```json
{ "ok": true, "provider": "chola", "operation": "createProposal", "product": "FLEXI_HEALTH",
  "data": { "succeeded": true, "genconProposalNumber": "2890476265318", "premium": 20490, "raw": { "…": "…" } },
  "meta": { "httpStatus": 200, "correlationId": "chola-…" },
  "cholaRequest": { "url": "…", "method": "POST", "requestHeaders": { "Authorization": "***set (… chars)***" }, "…": "…" } }
```

- `getQuote.data` → `{ succeeded, status, message, totalPremium, netPremium, tax, modalPremium, …, raw }`
- `createProposal.data` → `{ succeeded, status, message, genconProposalNumber, customerId, premium, …, raw }`
- `issuePolicy.data` → `{ succeeded, status, message, genconPolicyNumber, paymentUrl, payzappId, raw }` (+ `paymentMode`, `outcome`, `schedule` under APD)
- `policySchedule.data` → `{ succeeded, scheduleUrl, customerInformationSheetUrl, raw }`
- CKYC → `{ ok, provider, operation: "ckyc.verify" | "ckyc.query", data: <Chola's body> }`

Business failures are **data, not errors**: HTTP 200, `data.succeeded: false`
(or CKYC `data.Status: "Failure"`) with Chola's own wording.

`cholaRequest` is additive (like `iciciRequest`) and is **omitted** from CKYC.

Failure:

```json
{ "ok": false, "error": { "code": "UPSTREAM_ERROR", "message": "Chola ProposalSave returned HTTP 400", "provider": "chola", "details": { "httpStatus": 400, "body": "…" } } }
```

| `error.code` | HTTP | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | a required field is missing, unknown product, a non-PG `TaggingMode`, or a PolicyGeneration already sent (`provider` is `null`, as before) |
| `UNAUTHORIZED` | 401 | ops route without the right `X-Ops-Key` |
| `NOT_FOUND` | 404 | ops PDF not stored |
| `CONFIG_ERROR` | 503 | `CHOLA_*` not set (`details.missing`), ops routes off, APD in production |
| `AUTH_ERROR` | 502 | OAuth2 or CKYC TokenKey refused — our credential |
| `UPSTREAM_ERROR` | 502 | non-2xx, or 502/503/504 after retries |
| `TIMEOUT_ERROR` | 504 | no answer within `CHOLA_API_TIMEOUT_MS` |
| `PARSE_ERROR` | 502 | empty or `null` body |
| `INTERNAL_ERROR` / a driver code | 500 | a bug here, or the database on the ops routes |

The codes are deliberately **not** prefixed: the SPA's `api/cholaClient.js` maps
exactly these bare codes.

## Configuration

No bundled host, client id/secret, intermediary code or CKYC key. The names are
the standalone service's, so its `CHOLA_*` block copies across.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `CHOLA_BASE_URL` | ✅ | — | UAT `https://developeruat.cholainsurance.com`. Startup refuses production on a UAT host. |
| `CHOLA_CLIENT_ID` | ✅ | — | OAuth2 client |
| `CHOLA_CLIENT_SECRET` | ✅ | — | |
| `CHOLA_INTERMEDIARY_CODE` | ✅ | — | injected into quote/proposal |
| `CHOLA_TOPUP_PROPOSAL_URL` | for Super Topup | — | absolute; UAT `http://genconpreprod.cholainsurance.com/Portalservice/HealthService/SuperTopUp.svc/ProposalSave` (needs Chola-side IP whitelisting) |
| `CHOLA_CKYC_BASE_URL` | for CKYC | — | UAT `https://uatportal.cholainsurance.com` |
| `CHOLA_CKYC_PRIVATE_KEY` | for CKYC | — | |
| `CHOLA_CKYC_USER_ID` | | `''` | |
| `CHOLA_PAYMENT_MODE` | | `PG_CHOLA` | `PG_DIRECT`, `APD` (UAT only) |
| `CHOLA_OPS_KEY` | for ops | — | unset = ops routes off |
| `CHOLA_PUBLIC_URL_BASE` | | — | see *Payment and the return* |
| `CHOLA_TOKEN_SKEW_SECONDS` | | `60` | |
| `CHOLA_MAX_RETRIES` | | `2` | product calls; token/CKYC use 1, backend PolicyGeneration 0 |
| `CHOLA_RETRY_BASE_DELAY_MS` | | `500` | doubles per attempt |
| `CHOLA_API_TIMEOUT_MS` | | `30000` | per attempt, token and CKYC included |
| `CHOLA_POLICY_GENERATION_TIMEOUT_MS` | | `120000` | backend-built PolicyGeneration only |
| `CHOLA_JSON_BODY_LIMIT` | | `5mb` | |
| `CHOLA_DEBUG` | | `0` | full bodies to stdout (never the token or CKYC auth call) |
| `CHOLA_CORS_ORIGINS` | | shared list | |
| `CHOLA_*_PATH` | | kit paths | contract; leave unset |

UAT → production is the variables above plus the production credentials. No
source change.

## Database

`npm run migrate` (or `npm run db:setup` on a server) applies
`005_create_chola_policy_generation_tables.sql`: `health_chola_proposals` and
`health_chola_policy_generation_logs`, additive and idempotent. The names are the
standalone service's own, so where both services share a schema the existing
tables — and the proposals already claimed in them — are kept, and a proposal
claimed there is still never sent twice from here.

Every call is also audited into `nivabupa_api_transactions` with `api_name`
`CHOLA_*`, `correlation_id` the Gencon proposal/policy number (or `App_Ref_No`
for CKYC). CKYC rows record which identifier *type* was used, never the PAN,
Aadhaar, passport or CKYC number.

## Logging

One line per request (operation, URL, attempt, product, proposal/policy number)
and per response (status, duration), a parsed summary per operation, and a
failure block whenever a call is refused or given up on. Bodies only under
`CHOLA_DEBUG=1`. Never logged: the token, `CHOLA_CLIENT_SECRET`, the Basic pair,
`CHOLA_CKYC_PRIVATE_KEY`, the CKYC TokenKey, `CHOLA_OPS_KEY`.
`npm run test:chola` asserts it.

## Frontend changes needed

Not applied — the SPA is a separate repository. Two files, no page, util,
request body or response reader changes:

1. `api/cholaClient.js` — base URL from the health-insurance backend's variable,
   as `fgClient.js` / `itgiClient.js` already do, instead of the integrations
   service's variable (`…INTEGRATIONS_API_URL`) and its port-4002 fallback.
2. `api/chola.js` — the six paths: `/api/chola/quote` → `/chola-ms/quote`,
   `/api/chola/proposal` → `/chola-ms/proposal`, `/api/chola/issue` →
   `/chola-ms/issue`, `/api/chola/policy/schedule` → `/chola-ms/policy/schedule`,
   `/api/chola/ckyc/verify` → `/chola-ms/ckyc/verify`, `/api/chola/ckyc/query` →
   `/chola-ms/ckyc/query`. (Or Chola's own names — `/chola-ms/PremiumComputation`
   etc. — which answer identically.)

The `/chola-return` page needs no change.

## Troubleshooting

- **`AUTH_ERROR` on token** — wrong `CHOLA_CLIENT_ID` / `CHOLA_CLIENT_SECRET`, or
  the Basic header was not accepted.
- **`CONFIG_ERROR` "CHOLA_TOPUP_PROPOSAL_URL is not set"** — only Super Topup's
  ProposalSave needs it.
- **`UPSTREAM_ERROR` on ProposalSave / PremiumComputation, HTTP 400** — usually a
  missing member of Chola's WCF contract; `details.body` carries the ASP.NET page
  naming it. Every member must be present, empty or zero included, and Int64
  members are `0`, never `""`.
- **CKYC token expiry** — the portal never uses 401/403 for it: a stale TokenKey
  is HTTP 200 with `ErrorMsg` "Invalid Token Key", "Enter CKYC Token Key" or
  "Session Expired, please check timestamp.". The service re-auths once and
  retries; if the rejection survives, `AUTH_ERROR`. Persistent failure means a
  wrong `CHOLA_CKYC_PRIVATE_KEY`. Other `Status: "Failure"` bodies (e.g. "No
  record found") are KYC outcomes and pass through as data.
- **Rate limiting** — Chola's UAT gateway answers 429 to bursts (eight concurrent
  premium calls on 2026-09-09). Not retried; the SPA tells the buyer to retry.
- **Super Topup ProposalSave times out** — `genconpreprod` is not reachable from
  every network; it needs Chola-side IP whitelisting.

## UAT evidence — APD

`npm run uat:chola:apd` on 28 Sep 2026 (standalone service, identical code
path): Flexi Health, Self, SI ₹5,00,000, 1 year; proposal `2890476880887`;
premium ₹8,856 incl. GST; **policy `2890/00175370/000/00`** issued on the same
PolicyGeneration call (HTTP 200, 23.8 s), no payment URL. PolicySchedule answered
both links on `http://10.105.63.69`; the PDF download timed out.

Open with Chola: a public host for the schedule/CIS and websales pages;
confirmation that the ₹8,856 was debited from the UAT APD account; the expected
upper bound on PolicyGeneration response time.

## Verified

- `npm run test:chola` — offline checks against a mock speaking Chola's wire
  format, carrying the standalone service's three Chola suites
  (`cholaAdapter`, `cholaAllApis`, `cholaApd`) plus the migration checks.
- `npm run verify` — every `/chola-ms` route registered at both mounts.
