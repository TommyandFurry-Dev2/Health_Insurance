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
| `src/services/cholaFreechargePayment.service.js` | Freecharge flow: checkout, callback, verification, issuance, ops (see *Freecharge*) |
| `src/services/cholaFreecharge.service.js` | Freecharge OAuth2 token cache + one call per collection request |
| `src/helpers/cholaFreecharge.helper.js` | Freecharge request builders, response readers, payment verdict (pure) |
| `src/repositories/cholaFreecharge.repository.js` | `health_chola_freecharge_payments` |
| `migrations/007_create_chola_freecharge_payments.sql` | The Freecharge payments table |
| `src/config/{defaults,env,validate}.js` | `CHOLA_DEFAULTS`, `CHOLA_FREECHARGE_DEFAULTS`, `config.chola`, boot report |
| `scripts/test-chola.js` | Offline suite against a mock Chola (`npm run test:chola`) |
| `scripts/test-chola-freecharge.js` | Offline Freecharge suite against a mock gateway (`npm run test:chola:freecharge`) |
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
| POST | `/chola-ms/freecharge/initiate` | — | Freecharge `crypto/encrypt` (checkout) |
| ALL  | `/chola-ms/freecharge/return` | — | ⚠️ FCPG's callback; `crypto/decrypt` + `checkout/txn/status` |
| GET  | `/chola-ms/freecharge/result/:ref` | — | — (reads the payment row) |
| POST | `/chola-ms/freecharge/status` | — | `checkout/txn/status` ("check again") |
| GET  | `/chola-ms/ops/freecharge/payments[/:merchantTxnId]` | — | — |
| POST | `/chola-ms/ops/freecharge/payments/:merchantTxnId/status` | — | `checkout/txn/status` |
| POST | `/chola-ms/ops/freecharge/payments/:merchantTxnId/issue` | — | PolicyGeneration (PG_DIRECT) |
| POST | `/chola-ms/ops/freecharge/payments/:merchantTxnId/refund` | — | Freecharge `refund` |
| POST | `/chola-ms/ops/freecharge/paylink` · `…/paylink/status` | — | Freecharge `paylinkqr/create` · `payment/link/status` |

Every route is also served under `/health/chola-ms/*`. Token:
`POST /oauth2/token`; CKYC auth: `POST /epolicyv3api/api/KYC/CholaMS_CKYC_Auth`;
Freecharge token: `CHOLA_FREECHARGE_TOKEN_URL` (its own OAuth2 client).

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

Two ways to collect the premium: Chola's own hosted page (PolicyGeneration with
`PayMode: "Chola"`, below — blocked by the unreachable URL), or **Freecharge**,
where Chola's merchant collects it on FCPG and the policy is issued afterwards
(see *Freecharge* — the one Chola payment callback this service has).

With `PayMode: "Chola"`, PolicyGeneration takes no return URL. Chola's hosted
page returns the buyer to the SPA's own `/chola-return` page, which reads
whatever Chola append; Chola publish no status API to confirm it against.

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

## Freecharge

Chola collect premium through the **Freecharge payment gateway (FCPG)**, under
Chola's own merchant (UAT `MER6dca324492`), via Chola's WSO2 gateway. Sources:
Chola's *Free Charge APIs* Postman collection (every request body below), and
FCPG's public developer docs (freechargepg.in/developer) for what the
collection leaves out — the hosted-checkout form POST, the callback envelope
and the status-code table.

Chola's wrapper does FCPG's signing and JWS+JWE encryption with the merchant's
keys: this service holds no Freecharge key, sends the collection's plain JSON
to `crypto/encrypt`, and reads plain JSON back from `crypto/decrypt`.

**Its own OAuth2 client.** The product client (`CHOLA_CLIENT_ID`) is refused on
every `/endpoint/free-charge/*` path with WSO2 `900908` "API Subscription
validation failed" (UAT, 2026-11-17). `CHOLA_FREECHARGE_CLIENT_ID` /
`_CLIENT_SECRET` (or `CHOLA_FREECHARGE_BASIC_AUTH`, the Basic value as issued)
are a separate client; the token URL is its own variable because Chola are to
share the final one separately.

### The flow

```
ProposalSave ──► initiate ──► FCPG checkout ──► return (callback) ──► txn/status ──► PolicyGeneration (PG_DIRECT) ──► result
  premium          encrypt      browser POSTs     decrypt              decides          PGID = txnReferenceId          page polls
                                clientId+encData
```

1. **`POST /chola-ms/freecharge/initiate`** `{ product?, GenconProposalNumber,
   Amount, frontendReturnUrl }` — `Amount` is ProposalSave's re-priced
   premium; `frontendReturnUrl` the buyer's `/chola-return` page on an allowed
   origin (refused otherwise — a buyer who has paid must land where the result
   can be read). Earlier checkouts for the proposal are settled first (below).
   A payment row is written (fails closed), then `crypto/encrypt` seals the
   collection's checkout body:
   `{ merchantId, merchantTxnId, merchantTxnAmount, timestamp, merchantOrderId, callbackUrl, currency }`
   — `merchantTxnId` fresh per attempt (`NC<proposal>-<time><rand>`, FCPG's
   `^[a-zA-Z0-9_-]{1,30}$`), `merchantOrderId` the proposal, `timestamp` epoch
   seconds, `callbackUrl` = `CHOLA_FREECHARGE_CALLBACK_URL?ref=<opaque ref>`.
   Answers `data.checkout = { url: CHOLA_FREECHARGE_CHECKOUT_URL, method: "POST",
   fields: { clientId, encData } }` and `data.ref`.
2. The browser form-POSTs `clientId` + `encData` to FCPG's hosted checkout
   (`…/payment/v1/checkout`, `application/x-www-form-urlencoded`).
3. **`ALL /chola-ms/freecharge/return?ref=…`** — FCPG send the buyer back with
   `{ clientId, encData }`. `crypto/decrypt` opens it; the row is found by `ref`
   (or the decrypted `merchantTxnId`); the raw callback is stored;
   **`checkout/txn/status`** `{ merchantId, merchantTxnId, txnReferenceId? }`
   decides. 303 to the row's `/chola-return` page with `?ref=` only — no payment
   detail in a URL. A callback matching nothing goes to
   `CHOLA_FREECHARGE_FRONTEND_RETURN_URL?error=callback`.
4. On a confirmed SUCCESS, **PolicyGeneration** goes out in the background
   through the existing send-once path (`cholaPolicyIssuer.issue`, mode
   `PG_DIRECT` whatever `CHOLA_PAYMENT_MODE` says, `PGID` = FCPG's
   `txnReferenceId`, `source` `freecharge` in the evidence log), then
   PolicySchedule.
5. **`GET /chola-ms/freecharge/result/:ref`** is what the return page reads;
   **`POST /chola-ms/freecharge/status { ref }`** ("check again") re-asks FCPG
   about a payment not yet settled — the callback may never have come — and
   starts issuance for a paid one not yet tried.

### What decides a payment

The callback is never trusted alone; `txn/status` decides, by FCPG's table:

| txn/status says | Row becomes |
|---|---|
| `SPG-0000`, same `merchantTxnId`, amount = premium to the paisa, a `txnReferenceId` | `SUCCESS` → issuance |
| `SPG-0000` but another transaction, a different amount, no amount or no `txnReferenceId` | `NEEDS_REVIEW` — never issued automatically |
| a FAILED code while the callback said `SPG-0000` | `NEEDS_REVIEW` |
| a FAILED code (incl. `SPG-0025` "Transaction does not exist", `SPG-0150` cancelled) | `FAILED` |
| a PENDING code (`SPG-0002`, `SPG-5218`, `SPG-8000`, …) | `PENDING` |
| a code that only refuses **our request** (`SPG-0005` signature, `SPG-0010` fields, `SPG-0041` merchant not authorised, …), no code, or no answer | `PENDING` — proves nothing about the money |

`SUCCESS` is never undone by a later check. `NEEDS_REVIEW` changes only through
the ops status route.

**A proposal is paid once.** Before a new checkout every earlier one must be
known to have failed: a paid one refuses (and gets its issuance started); one
`INITIATED`/`PENDING` is asked about first and refuses unless FCPG now say it
failed — an abandoned checkout answers `SPG-0025`.

**Issuance** (`issue_status`): `IN_PROGRESS` → `POLICY_ISSUED` | `ISSUE_FAILED`
(Chola refused, or it never left — ops may re-send) | `NEEDS_REVIEW` (outcome
unknown — never re-sent). The `health_chola_proposals` claim still refuses a
second PolicyGeneration for one proposal; if one already went out, its outcome
is mirrored.

### Ops

Behind `X-Ops-Key`, by `merchantTxnId`:

- `GET /chola-ms/ops/freecharge/payments` · `…/payments/:merchantTxnId` (with
  the raw and decrypted callback and FCPG's answers)
- `POST …/payments/:id/status` — re-ask FCPG (`NEEDS_REVIEW` included); issues if paid
- `POST …/payments/:id/issue` — re-send PolicyGeneration from `ISSUE_FAILED`
- `POST …/payments/:id/refund` `{ refundAmount?, refundType? OFFLINE|ONLINE }` —
  the collection's refund body (`merchantRefundTxnId` `RF…`), sent once; refused
  while a policy is issued or being issued against the payment
- `POST /chola-ms/ops/freecharge/paylink` · `…/paylink/status` — the
  collection's pay-link requests, passed through with merchant, timestamp and
  currency filled in. **Not tied to issuance**: the pay-link callback and the
  link-status success response are not documented yet.

### Pending from Chola / to confirm on UAT

- The Freecharge OAuth2 client (or its Basic value) and the **final token URL**.
- `crypto/encrypt` and `crypto/decrypt` **response shapes** — the collection
  saved none. Read as FCPG's `{ clientId, encData }` envelope (then a `data`
  wrapper, then a bare JWS); anything else is a `PARSE_ERROR` naming the keys.
- That FCPG keep the `?ref=` on `callbackUrl`, and whether the callback is the
  documented form POST (the route takes any method, query or body).
- PolicyGeneration for a Freecharge payment: `PayMode: "Direct"`,
  `PGID` = `txnReferenceId`, `BankName` `3719`, `PaymentID` empty — the existing
  `PG_DIRECT` body. Chola to confirm the tagging fields they expect.
- Whether FCPG can also post a server-to-server webhook (none is in the
  collection); today a buyer who closes the tab before the redirect is found by
  "check again" or ops status.

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
| `CHOLA_FREECHARGE_BASE_URL` | | `CHOLA_BASE_URL` | Chola's gateway for the Freecharge APIs |
| `CHOLA_FREECHARGE_TOKEN_URL` | | base + `/oauth2/token` | absolute; **set when Chola share the final token URL** |
| `CHOLA_FREECHARGE_CLIENT_ID` / `_CLIENT_SECRET` | ✅ for Freecharge | — | the Freecharge OAuth2 client (not the product one) |
| `CHOLA_FREECHARGE_BASIC_AUTH` | or ↑ | — | the Basic value as Chola issued it; wins over the pair |
| `CHOLA_FREECHARGE_MERCHANT_ID` | ✅ for Freecharge | — | UAT `MER6dca324492` |
| `CHOLA_FREECHARGE_CHECKOUT_URL` | ✅ for Freecharge | — | UAT `https://sandbox-axispg.freecharge.in/payment/v1/checkout`, live `https://secure-axispg.freecharge.in/payment/v1/checkout` |
| `CHOLA_FREECHARGE_CALLBACK_URL` | ✅ for Freecharge | — | public `https://<this service>/health/chola-ms/freecharge/return` |
| `CHOLA_FREECHARGE_FRONTEND_RETURN_URL` | | — | where an unmatched callback sends the buyer (a `/chola-return` page) |
| `CHOLA_FREECHARGE_FRONTEND_RETURN_ORIGINS` | | `NIVABUPA_FRONTEND_RETURN_ORIGINS` | origins whose `/chola-return` page a checkout may name |
| `CHOLA_FREECHARGE_CURRENCY` | | `INR` | |
| `CHOLA_FREECHARGE_*_PATH` | | collection paths | contract; leave unset |

UAT → production is the variables above plus the production credentials. No
source change. Startup refuses production with a UAT/sandbox Freecharge host.

## Database

`npm run migrate` (or `npm run db:setup` on a server) applies
`005_create_chola_policy_generation_tables.sql`: `health_chola_proposals` and
`health_chola_policy_generation_logs`, additive and idempotent. The names are the
standalone service's own, so where both services share a schema the existing
tables — and the proposals already claimed in them — are kept, and a proposal
claimed there is still never sent twice from here.

`007_create_chola_freecharge_payments.sql` adds `health_chola_freecharge_payments`:
one row per Freecharge checkout, written before the buyer is sent to pay —
`merchant_txn_id`, the opaque `return_token`, proposal, amount, FCPG's verdict
(`status`, `status_code`, `txn_reference_id`, `paid_amount`), the raw callback
ciphertext and its decryption, the last `txn/status` answer, `issue_status` and
policy number, and any refund. Additive and idempotent.

Every call is also audited into `nivabupa_api_transactions` with `api_name`
`CHOLA_*`, `correlation_id` the Gencon proposal/policy number (or `App_Ref_No`
for CKYC). CKYC rows record which identifier *type* was used, never the PAN,
Aadhaar, passport or CKYC number.

## Logging

One line per request (operation, URL, attempt, product, proposal/policy number)
and per response (status, duration), a parsed summary per operation, and a
failure block whenever a call is refused or given up on. Bodies only under
`CHOLA_DEBUG=1`. Never logged: the token, `CHOLA_CLIENT_SECRET`, the Basic pair,
`CHOLA_CKYC_PRIVATE_KEY`, the CKYC TokenKey, `CHOLA_OPS_KEY`, the Freecharge
token, `CHOLA_FREECHARGE_CLIENT_SECRET` or `CHOLA_FREECHARGE_BASIC_AUTH`.
`npm run test:chola` and `npm run test:chola:freecharge` assert it.

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
- **Freecharge `AUTH_ERROR` "API Subscription validation failed" (900908)** — the
  client is not subscribed to the Freecharge APIs. The product client
  (`CHOLA_CLIENT_ID`) is not; set `CHOLA_FREECHARGE_CLIENT_ID`/`_SECRET` (or
  `_BASIC_AUTH`) to the Freecharge client Chola issued.
- **Freecharge `PARSE_ERROR` "encrypt answered no encData"** — `crypto/encrypt`
  answered a shape this service does not read; `details.keys` names its keys.
- **A buyer paid but the page says pending** — "check again" (`POST
  /chola-ms/freecharge/status`) or the ops status route asks FCPG again;
  `NEEDS_REVIEW` rows are never issued automatically — see the ops payment
  detail for the reason.

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
- `npm run test:chola:freecharge` — the Freecharge flow end to end against a
  mock of Chola's gateway: the collection's bodies, every payment verdict,
  send-once issuance, ops, and no credential in the logs.
- `npm run verify` — every `/chola-ms` route registered at both mounts.
- **Not yet run against UAT**: the Freecharge OAuth2 client has not been issued
  to us (2026-11-17), so no live encrypt/checkout/callback has been made.
