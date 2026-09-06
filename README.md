# nivabupa-api

Standalone Node.js service for the **Niva Bupa Reassure 3.0 partner API**.

It is the integration layer between the Tommy & Furry health-insurance SPA and
Niva Bupa: quote, underwrite, take payment, push the proposal, track it to
issuance, and download the policy — plus a journey break/resume feature so a
buyer who closes their browser mid-purchase can pick up where they left off.

This project was separated out of the `tf-api` process, where it ran as a
mounted module. **Its behaviour is unchanged.** See
[Relationship to tf-api](#relationship-to-tf-api) for what was and was not
altered, and how that was verified.

---

## Quick start

```bash
cd nivabupa-api
npm install
cp .env.example .env        # UAT values; fill in the two Case API credentials
npm run migrate             # create the journey tables (needs MySQL)
npm run verify              # self-test: config, routes, logic, HTTP, database
npm start                   # http://localhost:4000
```

| Command | What it does |
| --- | --- |
| `npm start` | Run the server. |
| `npm run dev` | Same, with `node --watch` auto-restart. |
| `npm run migrate` | Apply pending SQL migrations (idempotent). |
| `npm run migrate:status` | List migrations without applying any. |
| `npm run migrate:verify` | Dump the resulting schema (tables, FKs, indexes). |
| `npm run verify` | Self-test. No Niva Bupa calls — safe anywhere. |
| `npm run verify:live` | The above, plus one real call to each read-only Niva Bupa endpoint. |
| `npm run smoke:premium` | Token + Premium straight to Niva Bupa, no server in between. |
| `npm run smoke:journey` | End-to-end journey break/resume against a running server. |
| `npm run smoke:payment` | Payment initiate → gateway callback → correlation → policy row. |
| `npm run replay:decresp` | Replay a captured payment callback ciphertext against `decResp` with each candidate key. |

The service **runs without MySQL**: the eight Niva Bupa pass-through endpoints
keep working, journeys simply are not saved or resumable. `/readyz` reports
`503 DEGRADED` in that state while `/healthz` stays `200`, so an orchestrator
does not restart a process that is serving correctly.

---

## Project structure

```
nivabupa-api/
├── src/
│   ├── server.js                  HTTP entrypoint: validate → listen → boot → graceful shutdown
│   ├── app.js                     Express app: helmet, both insurer routers, the /health alias, probes
│   ├── index.js                   Module boundary: router factories + start/stop lifecycle
│   │
│   ├── config/
│   │   ├── env.js                 THE config object. Nothing else reads process.env.
│   │   ├── defaults.js            The only file containing a literal Niva Bupa URL, credential
│   │   │                          or key — and, for IFFCO Tokio, deliberately none of those.
│   │   └── validate.js            Startup report; refuses unsafe production config.
│   │
│   ├── routes/
│   │   ├── index.js               Composed router + CORS/body-parser/log stack + probes
│   │   ├── auth.routes.js         /nivabupa/token/test
│   │   ├── quote.routes.js        /nivabupa/premium
│   │   ├── proposal.routes.js     /nivabupa/uw-decision, /nivabupa/datapush
│   │   ├── payment.routes.js      /nivabupa/payment/initiate, /nivabupa/payment/return
│   │   ├── case.routes.js         /nivabupa/proposal-status, /nivabupa/policy-download
│   │   ├── journey.routes.js      /nivabupa/journey/*
│   │   └── itgi.routes.js         /iffcotokio/*  (IFFCO Tokio — see docs/iffco-tokio.md)
│   │
│   ├── controllers/               auth · quote · proposal · payment · case · journey · itgi
│   │
│   ├── services/
│   │   ├── nivabupaAuth.service.js   OAuth client_credentials → Bearer token
│   │   ├── caseApiAuth.service.js    UserID + Client_id → JWT (access_token header)
│   │   ├── genericApi.service.js     Premium / UW / Data Push transport, retry, tracing
│   │   ├── caseApi.service.js        Proposal Status / Policy Download transport
│   │   ├── soap.service.js           encResp / decResp payment crypto (WCF SOAP)
│   │   ├── journey.service.js        Journey persistence orchestration
│   │   ├── itgiApi.service.js        IFFCO Tokio transport (HTTP Basic) + operations
│   │   └── itgiCkyc.service.js       IFFCO Tokio CKYC fetch / create
│   │
│   ├── repositories/              Raw SQL, one file per journey table
│   ├── middleware/                journeyContext · requestLogger · errorHandler
│   ├── helpers/                   payment querystring · proposal defaults · XML primitives
│   │                              · ITGI request prep, parsing and validation
│   ├── constants/                 journey step machine · payment fields · proposal constants
│   │                              · ITGI masters, medical questions, CKYC vocabulary
│   ├── utils/                     token cache · JWT exp decode · redaction/coercion
│   └── db/                        mysql2 pool + transaction runner
│
├── migrations/                    001_create_journey_schema.sql, 002_add_mobile_to_users.sql
├── scripts/                       migrate · verify · smoke-* · replay-decresp
├── docs/journey-resume.md         Journey break/resume design notes
├── docs/iffco-tokio.md            IFFCO Tokio integration guide
├── .env / .env.example
├── .gitignore
└── package.json
```

**Layering:** `routes → controllers → services → (providers | repositories)`.
Controllers never call `axios` and services never touch `req`/`res`.

---

## Niva Bupa APIs used

Nine upstream calls across three separate auth mechanisms.

| # | Niva Bupa API | Auth | Called from |
| --- | --- | --- | --- |
| 1 | **Common Token** `/api/generic/token` | `client_id` + `client_secret` (OAuth client_credentials) | `nivabupaAuth.service.js` |
| 2 | **Premium** `/api/generic/premium` | Bearer (#1) + `clientId` header | `POST /nivabupa/premium` |
| 3 | **UW Decision** `/api/generic/uwDecision` | Bearer (#1) + `clientId` header | `POST /nivabupa/uw-decision` |
| 4 | **Data Push** `/api/generic/datapush` | Bearer (#1) + `clientId` header | `POST /nivabupa/datapush` |
| 5 | **Case API Token** `/caseapi/api/auth/v1/getauthtoken` | `UserID` + `Client_id` → JWT | `caseApiAuth.service.js` |
| 6 | **Proposal Status** `/caseapi/api/common/getpreissuancestatus` | `access_token` header (#5) | `POST /nivabupa/proposal-status` |
| 7 | **Policy Download** `/caseapi/api/document/getalldocument` | `access_token` header (#5) | `POST /nivabupa/policy-download` |
| 8 | **Payment encrypt** SOAP `encResp` | Encryption key in the envelope | `POST /nivabupa/payment/initiate` |
| 9 | **Payment decrypt** SOAP `decResp` | Decryption key in the envelope | `POST /nivabupa/payment/return` |

Plus one **outbound redirect**, not an API call: the payment gateway page
(`getPaymentValues.aspx`), which the frontend reaches by auto-submitting an HTML
form POST carrying the `encparam` from #8.

### The three auth mechanisms are not interchangeable

| | Generic API | Case API | Payment SOAP |
| --- | --- | --- | --- |
| Credential | `client_id` + `client_secret` | `UserID` + `Client_id` | a shared key, no token |
| Grant | `client_credentials`, form-encoded | JSON POST | — |
| Token header | `Authorization: Bearer …` | `access_token: …` | — |
| Expiry source | `expires_in` in the response | the JWT's own `exp` claim | — |
| Cache | in-process, refresh 30s early | in-process, refresh 30s early | — |

### Data Push is deliberately not retried

Premium is a pure read, so replaying it is free. Data Push **creates a
proposal**, and it runs *after* money has moved. A timeout there means the
outcome is unknown, not that it failed — a blind replay is how one payment
becomes two proposals. It gets a longer timeout (55s) instead, and reconciliation
goes through `POST /nivabupa/proposal-status` on the `SOURCING_APPNO`.

Premium/UW **are** retried, but only on HTTP 429 — and that is not rate
limiting. Measurement showed every 429 arriving after ~7.4s of Kong-reported
upstream latency while successes returned in 2.7–5.5s, with no `Retry-After`
header and Niva Bupa's own premium envelope in the body. It is an internal
timeout on their side surfacing under a misleading status code, so the retry is
jittered and generous (1s, 3s) rather than tight.

---

## API routes

Base URL: `http://<host>:<port>`

Every `/nivabupa/*` route is **also** served under `/health/nivabupa/*`
(compatibility alias for frontend builds whose base URL still ends in `/health`;
disable with `NIVABUPA_ALIAS_PREFIX=`).

The service also carries a second insurer, **IFFCO Tokio**, under `/iffcotokio/*`
(and the same `/health` alias). It is entirely separate — its own router, its own
config, its own credentials — and is optional: leave `ITGI_BASE_URL` and friends
unset and those endpoints answer `503` while everything below is unaffected. See
**[docs/iffco-tokio.md](docs/iffco-tokio.md)**.

⚠️ The `/health` alias is not optional for IFFCO Tokio: the payment response URL
registered with them goes through it
(`…/health/iffcotokio/payment/return`), and that redirect is the only channel by
which an ITGI policy number reaches this service.

### Journey identity (optional, on every pass-through route)

Send either header pair on the eight pass-through endpoints to attach the call
to a saved journey:

```
X-Journey-Id: <journey uuid>
X-Resume-Token: <64 hex chars>
```

`journeyId` / `resumeToken` in the JSON body also work, but are **deleted from
the body before it is forwarded upstream** — Niva Bupa is entitled to reject an
undocumented field. Headers avoid the problem, which is why they are preferred.

Without journey context every endpoint behaves exactly as it did before journey
persistence existed. Extra response fields appear only when a journey is in
context; nothing is ever removed.

---

### Probes

#### `GET /healthz`
Liveness. Deliberately does **not** touch MySQL.

```json
{ "status": "OK", "service": "nivabupa-backend", "env": "uat", "timestamp": "…" }
```
*Env:* none. *Upstream:* none. *Always 200 while the process is alive.*

#### `GET /readyz`
Readiness — checks MySQL, `200 READY` / `503 DEGRADED`.

```json
{ "status": "READY", "database": { "connected": true, "schema": "policy_db", "version": "…" },
  "journeyPersistence": "ENABLED" }
```
*Env:* `DB_*`. *Upstream:* none.

---

### 1. Auth

#### `GET /nivabupa/token/test`
Forces a fresh OAuth token. Use it to confirm credentials before debugging
anything downstream.

*Body:* none.
*Env:* `NIVABUPA_TOKEN_URL`, `NIVABUPA_CLIENT_ID`, `NIVABUPA_CLIENT_SECRET`, `NIVABUPA_SCOPE`, `NIVABUPA_IDENTIFIER_CODE`.
*Upstream:* **#1 Common Token**.

```json
{ "status": "SUCCESS", "message": "NivaBupa token acquired", "token_preview": "eyJ4NXQjUzI1…" }
```
Only a 12-character preview is ever returned or logged. `502` on failure with
`nivabupa_response` carrying Niva Bupa's own body.

---

### 2. Premium (quote)

#### `POST /nivabupa/premium`
Pass-through. The caller sends the exact Reassure 3.0 premium request shape; the
service attaches auth and forwards it unchanged.

*Body:* the Premium Data Dictionary shape —
```jsonc
{
  "policyTerm": "1", "city": "MUMBAI", "premiumCalculationDate": "11/AUG/2026",
  "paymentFrequency": "A", "isPort": "N", "yearlyQuotation": "N",
  "otherFrequencyAdjustmentRequire": "Y", "coverageType": "I",
  "sumInsured": "1000000", "adultCovered": "1", "childCovered": "0",
  "productCode": "REASSURE30", "premiumCalculation": "New",
  "policyNumberIfRenewal": "", "productVariant": "Diamond",
  "state": "MAHARASHTRA", "flexiPayment": "N",
  "policyAdjustmentList": [ { "adjustmentCode": "…", "adjustmentValue": "…" } ],
  "member": [ { "dateOfBirth": "06/Aug/1998", "gender": "M", "insuredType": "A",
                "mbrShpNo": "1", "diaPedTenure": "0", "htnPedTenure": "0",
                "portCoverageYears": "0", "uwLoading": [] } ]
}
```
*Env:* `NIVABUPA_PREMIUM_URL` + the token variables.
*Upstream:* **#2 Premium** (via #1).

```jsonc
{
  "status": "SUCCESS",
  "data": { "premiumResponse": { … } },     // Niva Bupa's envelope, unchanged
  "nivabupaRequest": {                       // exactly what went upstream
    "url": "…/api/generic/premium", "method": "POST",
    "requestHeaders": { "Authorization": "Bearer eyJ4…NqG2mQ (len=2122)", "clientId": "…" },
    "requestBody": { … }, "requestBodyBytes": 641, "attempts": 1,
    "responseStatus": 200, "responseHeaders": { … }, "responseBody": { … }
  },
  "quoteId": "<uuid>", "journeyId": "<uuid>"   // only with a journey in context
}
```
`nivabupaRequest` exists so the exact outbound call is readable in the browser's
Network tab beside the reply — the bearer token is always fingerprinted, never
shown in full. `502` on failure, with `nivabupaRequest` still populated.

---

### 3. Proposal

#### `POST /nivabupa/uw-decision`
Underwriting. Runs **before** payment.

*Body:* the UW request shape — `{ "Proposal": { "POLICY": {…}, "PROPOSER": {…}, "MEMBER": [...], "NOMINEE": {…} } }`.
*Env:* `NIVABUPA_UW_DECISION_URL`, the token variables, and the channel constants
(`NIVABUPA_LOGIN_BRANCH_CODE`, `NIVABUPA_NOC_BRANCH_CODE`, `NIVABUPA_AGENT_CODE`,
`NIVABUPA_PAYMENT_COLLECT_MODE`).
*Upstream:* **#3 UW Decision** (via #1).

Before forwarding, the service asserts the channel constants on the payload — but
**not** `PAYMENT_RECEIVED_FLAG`, because no money has moved at this point.

```jsonc
{ "status": "SUCCESS", "payload": { … }, "data": { … },
  "nivabupaRequest": { … }, "uwStatus": "APPROVED", "journeyId": "<uuid>" }
```

#### `POST /nivabupa/datapush`
Creates the proposal at Niva Bupa. Runs **after** a successful payment.

*Body:* the full proposal payload (data push dictionary).
*Env:* `NIVABUPA_DATAPUSH_URL`, `NIVABUPA_DATAPUSH_TIMEOUT_MS`, the token
variables, and all the channel constants including
`NIVABUPA_PAYMENT_RECEIVED_FLAG`.
*Upstream:* **#4 Data Push** (via #1).

Before forwarding it:
* asserts every channel constant, including `PAYMENT_RECEIVED_FLAG=Y`;
* resolves `PAYMENT_INFO.TRANSACTION_NUMBER` — from the payload if the caller
  stamped it, otherwise from this service's own payments row matched on
  `SOURCING_APPNO`. **Never fabricated**: with no real value the field is
  *omitted*, not blanked;
* drops `ADJUSTMENT_DETAILS` entries for unselected riders (`A_COPAY` with value
  `0` reads to their engine as an explicit election of 0% copay, not "none");
* prints a masked field audit and the full traced request/response.

```jsonc
{ "status": "SUCCESS",
  "data": { "RESPONSE": { "STATUS": "…", "POLICY_CODE": "…", "STATUS_MESSAGE": [ … ] } },
  "nivabupaRequest": { … }, "applicationNumber": "…", "datapushStatus": "…", "journeyId": "<uuid>" }
```

---

### 4. Payment

#### `POST /nivabupa/payment/initiate`
Builds the pipe-separated payment querystring, encrypts it via SOAP `encResp`,
and returns the `encparam`. **The frontend then auto-submits an HTML form POST to
`gatewayUrl`** — `getPaymentValues.aspx` is a redirect-based payment page, not a
JSON API.

*Body:* (defaults for `paymentType` / `isjuspay` / `returnPath` are applied first)
```jsonc
{
  "unqPolicyNumber": "APP-0001",   // required — the correlation key for the callback
  "premiumValue": "18432",         // required
  "additionalComment": "…",        // required
  "channel": "WEB",                // required
  "subchannel": "DIRECT",          // required
  "sourcingsystem": "Novacred",    // required
  "productname": "REASSURE30",     // required
  "mobile": "9876500001",          // required
  "email": "buyer@example.com",    // required
  "suminsured": "1000000", "tenure": "1", "zone": "ZONE1",
  "policynumber": "", "otherParam": "", "agentid": ""   // optional — sent blank, never omitted
}
```
All 18 fields go out in a fixed order, every one present — "blank" in Niva Bupa's
spec means present-but-empty.

*Env:* `NIVABUPA_SOAP_URL`, `NIVABUPA_PAYMENT_ENCRYPTION_KEY`,
`NIVABUPA_PAYMENT_GATEWAY_URL`, `NIVABUPA_PAYMENT_RETURN_URL`,
`NIVABUPA_PAYMENT_TYPE`, `NIVABUPA_PAYMENT_ISJUSPAY`, `NIVABUPA_SOAP_TIMEOUT_MS`.
*Upstream:* **#8 SOAP `encResp`**.

```jsonc
{ "status": "SUCCESS", "encparam": "…", "gatewayUrl": "https://paymbhid.nivabupa.com/…",
  "method": "POST", "journeyId": "<uuid>", "paymentAttempt": 1, "unqPolicyNumber": "APP-0001" }
```
`400` with the missing field names if the body is incomplete — no upstream call
is made. `502` on SOAP failure.

#### `POST /nivabupa/payment/return`
**Called by Niva Bupa's gateway, not by the frontend.** This is the URL
registered with them as `returnPath`, so it must stay publicly reachable at a
stable address.

*Body:* form-encoded, `returnMessage=<encrypted>` (also accepts `encResp` /
`cipherText`, in body or query).
*Env:* `NIVABUPA_SOAP_URL`, `NIVABUPA_PAYMENT_DECRYPTION_KEY`, `FRONTEND_URL`,
`FRONTEND_RETURN_PATH`.
*Upstream:* **#9 SOAP `decResp`**.

**Responds `302`, never JSON.** The request is the buyer's own browser being
carried back from the payment page, so it has to be a redirect into the SPA:

```
302 → {FRONTEND_URL}{FRONTEND_RETURN_PATH}
        ?status=SUCCESS&policyNumber=…&premium=…&paymentTxnId=…&paymentDate=…
        &journeyId=…&resumeToken=…
```
`paymentTxnId` and `paymentDate` are what the return page stamps onto Data Push
as `TRANSACTION_NUMBER` / `PAYMENT_DATE`. `journeyId` + `resumeToken` let the SPA
rehydrate even if browser storage was lost during the gateway round-trip. On
failure the redirect carries `status=ERROR` and a **generic** message — the real
exception goes to the server log only.

If decryption fails on the parsed body, it retries with the raw request bytes:
form-encoding turns an unescaped `+` into a space, which corrupts base64
ciphertext. `req.rawBody` is captured by a `verify` hook for exactly this.

---

### 5. Case API

#### `POST /nivabupa/proposal-status`
*Body:* `{ "ApplicationNumber": "…", "MobileNumber": "…" }` — with a journey in
context, both are filled in from the stored proposal when omitted.
*Env:* `NIVABUPA_PROPOSAL_STATUS_URL`, `NIVABUPA_CASEAPI_TOKEN_URL`,
`NIVABUPA_CASEAPI_USER_ID`, `NIVABUPA_CASEAPI_CLIENT_ID`.
*Upstream:* **#6 Proposal Status** (via #5).

```jsonc
{ "status": "SUCCESS", "data": { "Status": "…", "preIssuanceStatusData": [ … ] },
  "nivabupaRequest": { … }, "policyStatus": "…", "policyNumber": "…" }
```
`400` if no application number can be resolved. Niva Bupa answer `403` for
several distinct causes (unknown application number, mismatched mobile,
unentitled Case API identity) — `nivabupaRequest` is what tells them apart.

#### `POST /nivabupa/policy-download`
*Body:* `{ "PolicyNumber": "…", "forceRefresh": false }` — `PolicyNumber` falls
back to the journey's stored policy. `Document_Head`/`Document_Type` are fixed
per the spec, not caller-supplied.
*Env:* `NIVABUPA_POLICY_DOWNLOAD_URL` + the Case API credentials.
*Upstream:* **#7 Policy Download** (via #5) — **skipped** when the document is
already stored, unless `forceRefresh: true`.

```jsonc
{ "status": "SUCCESS", "source": "CACHE" | "NIVABUPA", "data": { … },
  "documentStored": true, "downloadedAt": "…" }
```

---

### 6. Journey (break / resume)

No Niva Bupa call. All MySQL; all require `DB_*` and a migrated schema.

| Method | Endpoint | Body | Response |
| --- | --- | --- | --- |
| `POST` | `/nivabupa/journey` | `{ mobile, email?, … }` — `mobile` required | `201` `{ journeyId, resumeToken, currentStep, expiresAt, user }` |
| `POST` | `/nivabupa/journey/resume` | `{ resumeToken }` (or `X-Resume-Token`) | `200` full snapshot + `resumeRoute`; `404` if unknown/expired |
| `POST` | `/nivabupa/journey/resume-by-mobile` | `{ mobile }` | `200` `{ user, journeys: [ … ] }`, each with its own resume token |
| `GET` | `/nivabupa/journey/:journeyId` | — | `200` full snapshot |
| `PATCH` | `/nivabupa/journey/:journeyId/step` | `{ step?, stepData?, …fields }` | `200` `{ currentStep, lastCompletedStep }` |
| `POST` | `/nivabupa/journey/:journeyId/select-quote` | `{ quoteId }` | `200` `{ currentStep, selectedQuote }` |
| `PUT` | `/nivabupa/journey/:journeyId/proposal` | `{ step?, …proposer/member/nominee }` | `200` `{ proposalId, uwStatus, datapushStatus }` |
| `PUT` | `/nivabupa/journey/:journeyId/kyc` | `{ status, method?, referenceId? }` | `200` `{ kyc: { status, method, referenceId, attemptCount } }` |
| `GET` | `/nivabupa/journey/:journeyId/policy-document` | — | `200` stored base64 PDF; `404` if not downloaded yet |
| `GET` | `/nivabupa/journey/:journeyId/timeline` | — | `200` `{ events, apiCalls }` |
| `POST` | `/nivabupa/journey/:journeyId/abandon` | — | `200` — still resumable until expiry |

`stepData` is **merged**, not replaced, so saving one form section never wipes
another's draft. `last_completed_step` never moves backwards: a buyer who
resumes at payment and re-opens the quote screen does not lose their proposal.

---

## Environment variables

`src/config/env.js` is the only file that reads `process.env`;
`src/config/defaults.js` is the only file containing a literal URL, credential or
key. Everything else reads the config object, so **UAT → production is a `.env`
change and nothing else**.

Legend — **UAT?** = the bundled default is a UAT value.
**Prod?** = must be changed for production.

### Runtime

| Variable | Default | UAT? | Prod? | Purpose |
| --- | --- | :-: | :-: | --- |
| `NODE_ENV` | `development` | | ✅ | `development` picks localhost URLs; `production` refuses UAT endpoints. |
| `PORT` | `4000` | | | HTTP listen port. |
| `STRICT_ENV` | `0` | | | `1` = refuse to start on any missing/fallback value. |
| `TRUST_PROXY` | *(unset)* | | ⚠️ | Set behind nginx/ELB so `req.ip` is the buyer's, not the proxy's. |

### This service's own URLs

| Variable | Default | UAT? | Prod? | Purpose |
| --- | --- | :-: | :-: | --- |
| `FRONTEND_URL` | `http://localhost:5173` (dev) / `https://insurance.tommyandfurry.com` | | ✅ | Where the payment callback redirects the buyer. |
| `FRONTEND_RETURN_PATH` | `/nivabupa-return` | | | SPA route appended to `FRONTEND_URL`. |
| `NIVABUPA_CORS_ORIGINS` | `*` | | ⚠️ | Allow-list. Must permit PATCH and PUT. |
| `NIVABUPA_ALIAS_PREFIX` | `/health` | | | Second mount point. Empty disables it. |

### Niva Bupa — generic API

| Variable | Default | UAT? | Prod? |
| --- | --- | :-: | :-: |
| `NIVABUPA_CLIENT_ID` | `cdceaca2…` | ✅ | ✅ |
| `NIVABUPA_CLIENT_SECRET` | `idcscs-914…` | ✅ | ✅ |
| `NIVABUPA_IDENTIFIER_CODE` | `BR08860001` | ✅ | ✅ |
| `NIVABUPA_SCOPE` | `https://uat.nbhi.ohi.ocs.oraclecloud.com/uat/…` | ✅ | ✅ |
| `NIVABUPA_TOKEN_URL` | `https://digitaluat.nivabupa.com/api/generic/token` | ✅ | ✅ |
| `NIVABUPA_PREMIUM_URL` | `…/api/generic/premium` | ✅ | ✅ |
| `NIVABUPA_UW_DECISION_URL` | `…/api/generic/uwDecision` | ✅ | ✅ |
| `NIVABUPA_DATAPUSH_URL` | `…/api/generic/datapush` | ✅ | ✅ |
| `NIVABUPA_DEBUG` | `0` | | | Dumps full upstream bodies (PII) to stdout. Leave off. |

### Niva Bupa — Case API

| Variable | Default | UAT? | Prod? |
| --- | --- | :-: | :-: |
| `NIVABUPA_CASEAPI_TOKEN_URL` | `https://digitaluat.nivabupa.com/caseapi/api/auth/v1/getauthtoken` | ✅ | ✅ |
| `NIVABUPA_PROPOSAL_STATUS_URL` | `…/caseapi/api/common/getpreissuancestatus` | ✅ | ✅ |
| `NIVABUPA_POLICY_DOWNLOAD_URL` | `…/caseapi/api/document/getalldocument` | ✅ | ✅ |
| `NIVABUPA_CASEAPI_USER_ID` | **none — required** | | ✅ |
| `NIVABUPA_CASEAPI_CLIENT_ID` | **none — required** | | ✅ |

Those last two are the only variables with **no bundled fallback**. Niva Bupa
ship no sample values ("Partner specific to be shared separately on mail"), so
the service fails loudly rather than sending `undefined` credentials. Without
them, `/nivabupa/proposal-status` and `/nivabupa/policy-download` fail with a
named error and everything else keeps working.

### Niva Bupa — payment

| Variable | Default | UAT? | Prod? |
| --- | --- | :-: | :-: |
| `NIVABUPA_PAYMENT_GATEWAY_URL` | `https://paymbhid.nivabupa.com/Pages/getPaymentValues.aspx` | ✅ | ✅ |
| `NIVABUPA_SOAP_URL` | `https://uat-transactions.nivabupa.com/websiteService/Service1.svc` | ✅ | ✅ |
| `NIVABUPA_PAYMENT_ENCRYPTION_KEY` | `nivabupauat@…` | ✅ | ✅ |
| `NIVABUPA_PAYMENT_DECRYPTION_KEY` | `!max#bupa@` | ✅ | ✅ |
| `NIVABUPA_PAYMENT_RETURN_URL` | `http://localhost:4000/nivabupa/payment/return` (dev) / the registered public URL | | ✅ |
| `NIVABUPA_PAYMENT_TYPE` | `mxbpofflinewithoutemi` | | ⚠️ |
| `NIVABUPA_PAYMENT_ISJUSPAY` | `yes` | | |

### Niva Bupa — proposal channel identity

| Variable | Default | Prod? | Field it sets |
| --- | --- | :-: | --- |
| `NIVABUPA_LOGIN_BRANCH_CODE` | `511101` | ⚠️ | `POLICY.POLICY_OTHER_DETAILS.LOGIN_BRANCH_CODE` |
| `NIVABUPA_NOC_BRANCH_CODE` | `511101` | ⚠️ | `POLICY.POLICY_OTHER_DETAILS.NOC_BRANCH_CODE` |
| `NIVABUPA_AGENT_CODE` | `BR08860001` | ⚠️ | `POLICY.SOURCING_INFO.AGENT_INFO.AGENT_CODE` |
| `NIVABUPA_PAYMENT_COLLECT_MODE` | `OL` | | `POLICY.PAYMENT_INFO.PAYMENT_COLLECT_MODE` |
| `NIVABUPA_PAYMENT_RECEIVED_FLAG` | `Y` | | `POLICY.PAYMENT_INFO.PAYMENT_RECEIVED_FLAG` (Data Push only) |

### IFFCO Tokio (optional — leave unset and the `/iffcotokio` routes answer 503)

**No bundled fallbacks.** Unlike every Niva Bupa variable above, none of these
has a default in `defaults.js` — there is no ITGI host, credential or partner
code anywhere in the source. Full detail in
**[docs/iffco-tokio.md](docs/iffco-tokio.md)**.

| Variable | Default | Prod? | Notes |
| --- | --- | :-: | --- |
| `ITGI_BASE_URL` | *(none)* | ⚠️ | The ITGI host. Every path is appended to it, so this one value moves the integration between environments. `NODE_ENV=production` refuses to start on a UAT/staging value. |
| `ITGI_USERNAME` | *(none)* | ⚠️ | HTTP Basic. |
| `ITGI_PASSWORD` | *(none)* | ⚠️ | HTTP Basic. |
| `ITGI_PARTNER_CODE` | *(none)* | ⚠️ | Sent as `partnerDetail.partnerCode`; the key ITGI hold the return URL against. |
| `ITGI_PAYMENT_RETURN_URL` | *(none)* | ⚠️ | **Ours.** The URL ITGI redirect buyers to, registered on *their* side. Must end in `/iffcotokio/payment/return`; checked at boot. |
| `ITGI_FRONTEND_RETURN_PATH` | `/iffcotokio-return` | | SPA route the callback 302s to, appended to `FRONTEND_URL`. |
| `ITGI_CONTRACT_TYPE` | `FHP` | | `FHP` (floater) or `IHP` (per member), when a request sends none. |
| `ITGI_API_TIMEOUT_MS` | `60000` | | Per attempt. |
| `ITGI_CKYC_CREATE_TIMEOUT_MS` | `120000` | | CKYC create was measured at 44s against ~1s for the health calls. |
| `ITGI_MAX_RETRIES` | `2` | | Transport failures and 502/503/504 only. Proposal, payment confirmation and CKYC create are never retried. |
| `ITGI_JSON_BODY_LIMIT` | `6mb` | | CKYC create carries base64 document uploads. |
| `ITGI_DEBUG` | `0` | | Dumps full bodies. They carry PAN, Aadhaar, DOB and document scans. |
| `ITGI_CORS_ORIGINS` | *(NivaBupa's)* | | Only to diverge from the shared list. |
| `ITGI_PAYMENT_GATEWAY_URL` | *(from base URL)* | | Only if ITGI host the gateway off the API base. |
| `ITGI_*_PATH` (×7) | *(contract paths)* | | The API contract, identical in UAT and production. Overridable so an ITGI-side path change stays a `.env` edit. |

### Timeouts, database, journey

| Variable | Default | Notes |
| --- | --- | --- |
| `NIVABUPA_TOKEN_TIMEOUT_MS` | `15000` | |
| `NIVABUPA_API_TIMEOUT_MS` | `20000` | Premium / UW / Case API, per attempt. |
| `NIVABUPA_SOAP_TIMEOUT_MS` | `20000` | |
| `NIVABUPA_DATAPUSH_TIMEOUT_MS` | `55000` | Must stay under the frontend's 60s axios timeout. |
| `DB_CONNECTION` / `DB_HOST` / `DB_PORT` / `DB_DATABASE` / `DB_USERNAME` / `DB_PASSWORD` | `mysql` / `127.0.0.1` / `3306` / `policy_db` / `root` / *(empty)* | `NIVABUPA_DB_*` overrides `DB_*` if both are set. |
| `DB_POOL_SIZE` / `DB_CONNECT_TIMEOUT_MS` | `10` / `10000` | |
| `JOURNEY_TTL_DAYS` | `7` | How long a broken journey stays resumable. |
| `JOURNEY_ABANDON_AFTER_HOURS` | `48` | Idle journeys swept to `ABANDONED`. |
| `JOURNEY_SWEEP_INTERVAL_MINUTES` | `60` | In-process sweeper interval. |

---

## UAT → production

Change `.env`. Nothing else.

```env
NODE_ENV=production

NIVABUPA_CLIENT_ID=<prod>
NIVABUPA_CLIENT_SECRET=<prod>
NIVABUPA_IDENTIFIER_CODE=<prod>
NIVABUPA_SCOPE=<prod scope>
NIVABUPA_TOKEN_URL=<prod>/api/generic/token
NIVABUPA_PREMIUM_URL=<prod>/api/generic/premium
NIVABUPA_UW_DECISION_URL=<prod>/api/generic/uwDecision
NIVABUPA_DATAPUSH_URL=<prod>/api/generic/datapush

NIVABUPA_CASEAPI_TOKEN_URL=<prod>/caseapi/api/auth/v1/getauthtoken
NIVABUPA_PROPOSAL_STATUS_URL=<prod>/caseapi/api/common/getpreissuancestatus
NIVABUPA_POLICY_DOWNLOAD_URL=<prod>/caseapi/api/document/getalldocument
NIVABUPA_CASEAPI_USER_ID=<prod>
NIVABUPA_CASEAPI_CLIENT_ID=<prod>

NIVABUPA_PAYMENT_GATEWAY_URL=<prod gateway>
NIVABUPA_SOAP_URL=<prod SOAP>
NIVABUPA_PAYMENT_ENCRYPTION_KEY=<prod>
NIVABUPA_PAYMENT_DECRYPTION_KEY=<prod>
NIVABUPA_PAYMENT_RETURN_URL=https://<your-domain>/nivabupa/payment/return

FRONTEND_URL=https://insurance.tommyandfurry.com
NIVABUPA_CORS_ORIGINS=https://insurance.tommyandfurry.com
TRUST_PROXY=1

DB_HOST=<prod> ; DB_DATABASE=<prod> ; DB_USERNAME=<prod> ; DB_PASSWORD=<prod>
```

**`NODE_ENV=production` refuses to start** if any Niva Bupa endpoint still points
at a UAT host, or if a production-critical variable fell back to the bundled UAT
default. That check exists because the failure it prevents is silent: real buyers
transacting against a UAT tenant.

For IFFCO Tokio it is four variables plus the registered return URL:

```env
ITGI_BASE_URL=<prod host>
ITGI_USERNAME=<prod>
ITGI_PASSWORD=<prod>
ITGI_PARTNER_CODE=<prod>
ITGI_PAYMENT_RETURN_URL=https://<your-domain>/health/iffcotokio/payment/return
```

`NODE_ENV=production` refuses to start on an `ITGI_BASE_URL` that still looks
like UAT/staging, exactly as it does for the Niva Bupa endpoints. Unlike them,
ITGI has **no bundled fallbacks at all** — no host, credential or partner code
exists in `defaults.js` — so a production deployment cannot silently transact
against ITGI staging; it simply cannot reach ITGI until it is told how.

Three things are **not** purely `.env`:

* **`NIVABUPA_PAYMENT_RETURN_URL` must be registered with Niva Bupa.** Their
  gateway may validate `returnPath` against what they hold, so pointing it at a
  new host requires telling them. Setting the variable alone is not enough.
* **`ITGI_PAYMENT_RETURN_URL` must be registered with IFFCO Tokio**, against the
  partner code. Setting the variable tells this service what to expect; ITGI
  must be asked to change what they actually redirect to. Startup reports a
  mismatch between it and the route served, because a wrong value means a paid
  buyer lands on a 404 and the policy number — which reaches us nowhere else —
  is lost.
* **The database schema** must exist in the production MySQL — run
  `npm run migrate` once against it.

---

## Configuration validation

`src/config/validate.js` runs before the socket opens and prints a report:
every resolved endpoint (protocol + host + path), every credential by **name and
length only**, and the payment/frontend URLs.

* **MISSING** — no value at all. Warned in dev/UAT, **fatal** in production or under `STRICT_ENV=1`.
* **FALLBACK** — came from `defaults.js`, not the environment. Fine in UAT; **fatal** in production for the endpoint/credential set.
* **UAT-in-production** — `NODE_ENV=production` with a `uat`/`localhost` host in any endpoint. **Always fatal.**

---

## Logging

Every upstream call is logged with method, URL, headers, body size and response.
What is **never** logged:

* **Bearer and `access_token` values** — fingerprinted as `eyJ4NXQj…NqG2mQ (len=2122)`.
  Enough to answer "did these two calls use the same credential?", useless to an
  attacker.
* **Client secrets, passwords, encryption/decryption keys, API keys** — replaced
  with `***REDACTED***` by `utils/sanitize.js` at every nesting level before
  anything reaches the `api_transactions` audit table.
* **Base64 policy PDFs** — truncated at 4KB in the audit table; the document
  itself is stored once, on `journey_policies`.

Two deliberate exceptions, both documented in code:

* **`NIVABUPA_DEBUG=1`** dumps full request/response bodies. Those carry PAN,
  Aadhaar, DOB and medical answers. Off by default; it is a temporary diagnostic,
  not a setting to leave on.
* **The Data Push trace** is always on — that payload is the one that has to be
  diffed field-by-field against Niva Bupa's dictionary when they reject a
  proposal, and it runs once per policy. It carries the same PII, so **rotate or
  delete those logs once a payload comparison is done.** The masked field audit
  printed beside it is the line safe to paste into a ticket.

---

## Database

The journey tables live in `policy_db` — the **host Laravel application's**
schema, which owns the `users` table journeys attach to. This service is a guest
there: it adds its own `nivabupa_*` tables and ALTERs exactly one pre-existing
table (`002_add_mobile_to_users.sql`).

```bash
npm run migrate:status   # what's pending
npm run migrate          # apply
npm run migrate:verify   # tables, foreign keys, indexes
```

Migrations are applied once each, tracked in `nivabupa_schema_migrations`, and
every statement is idempotent — a partially applied file can be re-run safely.
They are **not** wrapped in transactions, because MySQL DDL is not transactional.

---

## Dependencies

Six runtime dependencies, no dev dependencies.

| Package | Why |
| --- | --- |
| `express` | HTTP server and routing. |
| `cors` | Per-router CORS (the journey endpoints need PATCH/PUT). |
| `helmet` | Security headers. |
| `axios` | Every upstream HTTP and SOAP call. |
| `mysql2` | The journey database pool. |
| `dotenv` | `.env` loading. Never overrides an already-set variable, so injected production config wins. |

No ORM: the repositories use raw parameterised SQL against a schema this service
does not own. No XML parser: `encResp`/`decResp` results are opaque cipher
strings, and a real parser would entity-decode and whitespace-normalise them —
`helpers/xml.helper.js` returns the tag body byte-for-byte.

---

## Relationship to tf-api

This project was extracted from `tf-api/src/nivabupa/`, where it ran as a module
mounted into that process. **`tf-api` was not modified** — it still contains and
serves the integration, so both can run side by side for comparison.

The extraction was clean because the module already imported nothing outside its
own folder. **No file in this project references `tf-api`.**

### What changed

| | Files | Change |
| --- | :-: | --- |
| Byte-identical | 28 | — |
| Comments only | 8 | Rewritten where they described the tf-api mount. Zero code difference. |
| Code changed | 6 | See below. |
| New | 4 | `app.js`, `server.js`, `config/defaults.js`, `config/validate.js`. |
| Dropped | 1 | `index.d.ts` — a TypeScript boundary that only existed for tf-api's `tsc`. |

The six with code changes:

* **`config/env.js`** — loads dotenv, reads fallbacks from `defaults.js` instead
  of inline literals, records which variables fell back, and adds env vars for
  the previously-hardcoded timeouts, payment defaults and channel constants.
  *Every resolved value is unchanged.*
* **`constants/payment.constants.js`**, **`constants/proposal.constants.js`** —
  read their values from config instead of `process.env` at import time.
* **`controllers/payment.controller.js`** — the redirect path `/nivabupa-return`
  became `config.frontendReturnPath`, which defaults to the same string.
* **`index.js`** — startup banner text (`npm run migrate`, alias prefix).
* **`services/journey.service.js`** — one debug-verbosity check read
  `process.env.NODE_ENV` directly; it now reads `config.env`, which is defined as
  `process.env.NODE_ENV || 'development'`. Same comparison, and it makes
  `config/env.js` the only file in the project that touches `process.env`.

### How equivalence was verified

**1. Differential harness** — both module trees loaded into one process with the
same environment, fed identical inputs, outputs byte-compared:
**88 comparisons, 0 differences.** Including the outbound calls, intercepted at
the axios adapter so nothing reached Niva Bupa:

| Call | URL | Headers | Timeout | Body |
| --- | :-: | :-: | :-: | :-: |
| token | ✅ | ✅ | ✅ 15000ms | ✅ 266 bytes |
| premium | ✅ | ✅ | ✅ 20000ms | ✅ 641 bytes |
| uwDecision | ✅ | ✅ | ✅ 20000ms | ✅ 641 bytes |
| datapush | ✅ | ✅ | ✅ 55000ms | ✅ 929 bytes |
| SOAP `encResp` | ✅ | ✅ | — | ✅ 762 bytes, key included |
| SOAP `decResp` | ✅ | ✅ | — | ✅ key included |

Plus: the payment querystring (397 chars, byte-identical), `parseReturnMessage`
across three samples, `applyBusinessDefaults` across all three modes (mutated
payload **and** change log), all constants, all 19 routes in declaration order,
`forAudit` redaction, and every date/decimal coercion.

**2. HTTP comparison** — both servers booted (`tf-api` on `:4000`,
`nivabupa-api` on `:4001`), the same request sent to each:
**15 endpoints, 0 differences** in status, content-type, redirect location or
body. Covering probes, 404 envelopes, local validation rejections, journey
lookups, and live Niva Bupa round-trips (token, premium, payment encryption)
through both servers. The only fields that differed were per-request values from
Niva Bupa's own gateway — a fresh bearer token, Kong correlation IDs,
`set-cookie`, `Date`, measured upstream latency. Those *must* differ; identical
values would mean a cached response.

**3. Self-test** — `npm run verify:live`: **46 passed, 0 failed**, including live
Token, Premium (`STATUS=SUCCESS`), Case API token, and a full SOAP
`encResp`→`decResp` round-trip.

**4. Smoke tests** — against the standalone server:
`smoke:journey` **28 passed, 0 failed** (create → autosave → quote select →
proposal → KYC → break → resume by token → resume by mobile → timeline);
`smoke:payment` **20 passed, 0 failed** (initiate → gateway callback →
correlation → policy row → unmatched-callback logging).

### Not verified end-to-end

Two paths have no read-only form and were **not** exercised live, in either
project:

* **`POST /nivabupa/uw-decision`** — underwrites a real person.
* **`POST /nivabupa/datapush`** — creates a real proposal, and normally runs only
  after money has moved.

Both are covered by everything short of the send: their payload construction,
business defaults, headers, URL and timeout are byte-compared against the
original in the differential harness above, and both are exercised end-to-end by
`npm run smoke:journey`. Confirming them against live UAT needs a real test
proposal.
