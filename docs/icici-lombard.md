# ICICI Lombard — "Elevate" Health

Migrated from the standalone `novacred-insurance-integrations` service
(`src/providers/elevate/*`), where the SPA reached it on `localhost:4002` as
`/api/icici_*`. Follows the IFFCO Tokio and Future Generali migrations: the
routes and the base URL move; ICICI's request bodies, the normalised responses,
the error envelope and the error codes are unchanged on both sides of the hop.

Served under `/icici-lombard/*` and the `/health` alias, as its own router. An
unconfigured deployment answers 503 on its own paths and nothing else is
affected.

## Files

| File | Role |
|---|---|
| `src/routes/icici.routes.js` | Route table |
| `src/controllers/icici.controller.js` | Envelopes, `iciciRequest`, audit rows |
| `src/services/iciciApi.service.js` | `callIcici` (Bearer, 401 refresh, `Success:false`) + quote / proposal / sync / status / EMI / COI / zone |
| `src/services/iciciCkyc.service.js` | CKYC and OVD |
| `src/services/iciciAuth.service.js` | JWT token cache |
| `src/services/iciciHttp.service.js` | Retries, timeouts, request/response logging |
| `src/helpers/icici.helper.js` | Typed errors, field guards, premium/proposal parsers, header masking |
| `src/helpers/iciciCrypto.helper.js` | AES password encryption, RSA `encKey` helpers |
| `src/constants/icici.constants.js` | Operations, Status Master, product codes, OVD proof lists |
| `src/config/{defaults,env,validate}.js` | `ICICI_DEFAULTS`, `config.icici`, boot report |
| `scripts/test-icici.js` | Offline suite against a mock ICICI (`npm run test:icici`) |
| `scripts/smoke-icici.js` | Read-only UAT smoke (`npm run smoke:icici [token\|zone\|quote\|status\|all]`) |

No database migration: calls are audited into the existing
`nivabupa_api_transactions` table, `api_name` `ICICI_*`.

## Routes

| Method | This service | Was (`:4002`) | ICICI API |
|---|---|---|---|
| GET  | `/icici-lombard/config/test` | — | none (reports config, prints no values) |
| POST | `/icici-lombard/quote` | `/api/icici_quote` | `/health-fresh/elevate/generic/premium` |
| POST | `/icici-lombard/ckyc` | `/api/icici_ckyc` | `/generic/common/ckyc/generic/health/ckyc` |
| POST | `/icici-lombard/ckyc/ovd` | `/api/icici_ckyc_ovd` | `/generic/common/ckyc/generic/health/ovdinitiate` |
| POST | `/icici-lombard/proposal` | `/api/icici_proposal` | `/health-fresh/elevate/generic/proposal-payment` |
| POST | `/icici-lombard/policy/status` | `/api/icici_policy_status` | `/health-servicing/proposal/generic/status` |
| POST | `/icici-lombard/issue` | `/api/icici_issue` | `/health-servicing/payment/generic/sync` |
| GET  | `/icici-lombard/coi/:transactionId` | `/api/icici_coi/:transactionId` | `/generic/common/customer/{clientname}/certificate/health/{transactionId}` |
| POST | `/icici-lombard/emi/due` | `/api/icici_emi_due` | `/health-servicing/emi/generic/getdue` |
| POST | `/icici-lombard/emi/process` | `/api/icici_emi_process` | `/health-servicing/emi/generic/process` |
| POST | `/icici-lombard/zone` | `/api/icici_zone` | `/Generic/Health/Zone` |

Every route is also served under `/health/icici-lombard/*`. Token:
`POST /auth-api/access/token`.

There is no payment callback route, and none is missing: ICICI's hosted gateway
returns the buyer straight to the SPA on the `SuccessUrl` the proposal carries,
and the SPA confirms the outcome through `/policy/status`.

## The flow and its IDs

```
quote ──► CKYC ──► proposal ──► ICICI hosted payment ──► policy/status ──► coi
  │         │          │                                      │
  └─ bnc_ ──┴──── bnc_ ┴──────────────── bnc_ ────────────────┴── bnc_
```

| ID | Minted by | Carried as |
|---|---|---|
| `bnc_…` | **Premium** (`TransactionId`) | `TransactionId` on proposal / sync / status / EMI; `transactionId` on CKYC; `quoteTransactionId` on OVD; the COI path |
| `kyc_…` | CKYC (`KycID`) | the proposal's `KYCRefNo` |
| `txn_…` | Policy sync (PGI id) | — |
| uuid | every call (`CorelationId`) | per call, not per journey |

Nothing in this service generates, rewrites or substitutes any of them. The
audit row's `correlation_id` is the `bnc_` id wherever the call has one.

ICICI-side rules the kit does not document (from the UAT QA runs):

- **CKYC is a hard gate** — proposal-payment answers `458 KYC PENDING` until CKYC
  has resolved against the quote's `TransactionId`.
- **`SuccessUrl` is mandatory** despite the kit marking it optional.
- **`PaymentDetails[].Amount` must equal the quoted premium** to the rupee.
- **Premium needs `AddOns: []`** on each insured; omitting it fails with `errorCode -1`.
- **Proposal commits even when ICICI's gateway times out at 9s** — recover the
  `ProposalId` from `/policy/status` on the same `TransactionId` rather than proposing again.
- **Policy sync is for partner-collected payment only.** On the hosted gateway
  ICICI issue the policy themselves; UAT answers sync with
  `merchant mapping does not exists` for this partner.

## Responses

Success — the working implementation's envelope, unchanged:

```json
{ "ok": true, "provider": "elevate", "operation": "getQuote",
  "data": { "transactionId": "bnc_…", "totalPremium": 7065, "…": "…" },
  "meta": { "corelationId": "…", "httpStatus": 200 },
  "iciciRequest": { "url": "…", "method": "POST", "requestHeaders": { "Authorization": "***set (507 chars)***" }, "…": "…" } }
```

`iciciRequest` is additive (like `fgRequest` / `itgiRequest`) and is **omitted**
from `/ckyc`, `/ckyc/ovd` and `/coi`.

A CKYC that ICICI decline is an **outcome, not an error** — HTTP 200 with
`data.isKycSuccess: false`, their `displayMessage`, `statusCode` and any
`ovdLink`. OVD documents ICICI decline are treated the same way: HTTP 200,
`data.isKycSuccess: false`, their `errorMessage`.

KYC follows ICICI's kit (CKYC_API_Kit_V2), not another insurer's flow:

1. **CKYC** — one of `panNumber` / `ckycNumber` / `aadhaarNumber`, plus
   `dateOfBirth` (dd-MMM-yyyy) and the quote's `transactionId`. With Aadhaar,
   `nameAsPerAadhaar` and `gender` are mandatory; `gender` goes upstream as the
   kit's `M`/`F` (`Male`/`Female` are mapped).
2. **OVD** — ICICI's fallback when CKYC declines: `proofOfIdentityType`
   (`AADHAAR`, `PAN`, `VOTERID`, `PASSPORT`, `DL`), `proofOfAddressType`
   (`AADHAAR`, `VOTER`, `PASSPORT`, `DL`), and each proof as
   `{ base64, filename, contentType }` (or `{ value, options }` server-side).
   Rebuilt here as the kit's multipart upload.
3. **Proposal** — carries CKYC's `KycID` back as `KYCRefNo` when there is one.
   A nominee under 18 needs `AppointeeName`, `AppointeeDOB` and
   `AppointeeRelationship`; ICICI refuse the proposal without them
   (`errorCode 612`).

Failure:

```json
{ "ok": false, "error": { "code": "UPSTREAM_ERROR", "message": "Elevate policyStatus failed: …", "provider": "elevate", "details": { "…": "…" } } }
```

| `error.code` | HTTP | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | a required field is missing (`provider` is `null`, as before) |
| `CONFIG_ERROR` | 503 | `EL_*` not set — `details.missing` names them |
| `AUTH_ERROR` | 502 | token refused — our credential |
| `UPSTREAM_ERROR` | 502 | non-2xx, `Success:false`, or 502/503/504 after retries |
| `TIMEOUT_ERROR` | 504 | no answer within `EL_API_TIMEOUT_MS` |
| `PARSE_ERROR` | 502 | empty body; COI neither PDF nor JSON |
| `INTERNAL_ERROR` | 500 | a bug here |

The codes are deliberately **not** prefixed `ICICI_` (unlike `ITGI_*` / `FG_*`):
the SPA's `api/elevateClient.js` maps exactly these bare codes.

## Configuration

No bundled host, login, password, key or client name. The names are the
standalone service's, so its `EL_*` block copies across.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `EL_BASE_URL` | ✅ | — | UAT `https://ilesbapigee.insurancearticlez.com`. Production is `EL_PROD_BASE_URL` (`https://janus.icicilombard.com`), never this — an `icicilombard.com` host here is refused at request time. |
| `EL_LOGIN` | ✅ | — | |
| `EL_PASSWORD` | ✅ | — | as issued by IL |
| `EL_PASSWORD_PRE_ENCRYPTED` | | `false` | `true` for the credential IL actually issue |
| `EL_AES_KEY` | ✅ unless pre-encrypted | — | base64 or raw |
| `EL_AES_MODE` | | `aes-128-ecb` | `aes-256-ecb`, `aes-256-cbc` |
| `EL_AES_IV` | | — | CBC only |
| `EL_CLIENT_NAME` | for COI | — | `novacred` |
| `EL_TOKEN_SKEW_SECONDS` | | `60` | |
| `EL_MAX_RETRIES` | | `2` | see **Retries** |
| `EL_RETRY_BASE_DELAY_MS` | | `500` | doubles per attempt |
| `EL_API_TIMEOUT_MS` | | `30000` | per attempt, token included |
| `EL_JSON_BODY_LIMIT` | | `6mb` | two base64 OVD proofs of up to 2 MB each |
| `EL_DEBUG` | | `0` | full bodies to stdout (never the token call) |
| `EL_CORS_ORIGINS` | | shared list | |
| `EL_*_PATH` | | kit paths | contract; leave unset |

`EL_IMID_CODE` was declared by the standalone service but never read; it is not
read here either.

Production is the separate `EL_PROD_*` block plus `EL_PRODUCTION_ENABLED`, on
the same server — see **Going to production**.

## Going to production

Production ICICI runs on the **existing backend**
(`healthinsurance.tommyandfurry.com/health`) beside UAT, because that one
process serves both SPAs. It does not replace the `EL_*` (UAT) values; it has
its own `EL_PROD_*` block (see `.env.example`), and each request picks one:

| `X-App-Env` on the request | ICICI reached | Who sends it |
|---|---|---|
| absent, or `uat` | UAT — `EL_*`, unchanged | the UAT SPA, the New UI, any old build |
| `prod` | production — `EL_PROD_*`, only while `EL_PRODUCTION_ENABLED=true`; otherwise 403 | the production SPA (`elevateClient.js`) |
| anything else | 403 | — |

The two SPAs share an origin, so CORS cannot do this. `NODE_ENV` stays `uat`;
no other insurer reads any of it.

What enforces the split (middleware/iciciClientEnvironment.js,
helpers/iciciEnvironment.helper.js, `iciciEnvironmentRefusal` in config/env.js):

- Host, credential, every path, the client name and the cached token are taken
  from the request's environment; the two token caches are separate.
- `EL_PROD_*` has **no defaults**. An operation ICICI have not issued a
  production path for (EMI) answers 503 naming `EL_PROD_*_PATH`, never the UAT
  path. `GET /icici-lombard/config/test` reports `production.pathsNotSet`.
- The UAT profile is refused if `EL_BASE_URL` is an `icicilombard.com` host
  ("replacing" UAT in place would put UAT testers on production); the
  production profile is refused if `EL_PROD_BASE_URL` is ICICI's UAT host.
- Production log lines carry `env=production`.

Audit rows for production calls land in the same `nivabupa_api_transactions`
table as UAT (the shared database), told apart by the endpoint host.

First live checks, each a read, on the server after the `EL_PROD_*` lines are
in its `.env`: `ICICI_SMOKE_ENV=production npm run smoke:icici token`, then
`… zone`. The script refuses anything else on production: a premium mints a
TransactionId at ICICI — run it only once ICICI confirm it creates no
transaction. CKYC, proposal and payment verify a real identity and
move real money — only with an approved buyer.

## Retries

Quote, status, CKYC, OVD, zone, EMI due and COI are retried on a transport
failure or HTTP 502/503/504, `EL_MAX_RETRIES` times.

**Proposal-payment, policy sync and EMI process are never retried** (since
2026-10-30, ahead of production; the standalone service retried them). Each
commits something at ICICI, and ICICI's proposal is known to commit even when
their gateway times out — so a timeout means the outcome is **unknown** and a
replay can raise a second proposal or take a payment twice, which is why IFFCO
Tokio and Future Generali never retry theirs either. The outcome is read back
with `/policy/status` on the same TransactionId. A 401 is still refreshed and
replayed once: ICICI refused it before doing anything.

## Logging

One line per request (operation, method, URL, attempt, `transactionId` /
`requestId`) and per response (status, duration), a parsed summary per
operation, and a failure block whenever a call is refused or given up on.
Bodies only under `EL_DEBUG=1`. Never logged: the token, `EL_PASSWORD`, the
encrypted password, `EL_LOGIN`, `EL_AES_KEY`. `npm run test:icici` asserts it.

Audit rows store the request and normalised response, except: CKYC stores only
which identifier type was used (never the PAN / CKYC / Aadhaar number) and the
outcome; OVD stores the proof types, never the files; COI stores size and
filename, never the document.

## Frontend changes needed

Not applied. In `tommyandfurryapp---frontend`, and only these two files — no
page, util, request body or response reader changes:

1. `src/Components/HealthInsurance/api/elevateClient.js` — base URL from
   `REACT_APP_HEALTH_NIVABUPA_API_URL`, as `fgClient.js` / `itgiClient.js`
   already do, instead of
   `REACT_APP_HEALTH_INTEGRATIONS_API_URL || REACT_APP_HEALTH_FG_API_URL || 'http://localhost:4002'`.
2. `src/Components/HealthInsurance/api/elevate.js` — the ten paths:
   `/api/icici_quote` → `/icici-lombard/quote`, `/api/icici_proposal` →
   `/icici-lombard/proposal`, `/api/icici_issue` → `/icici-lombard/issue`,
   `/api/icici_policy_status` → `/icici-lombard/policy/status`,
   `/api/icici_ckyc` → `/icici-lombard/ckyc`, `/api/icici_ckyc_ovd` →
   `/icici-lombard/ckyc/ovd`, `/api/icici_coi/:id` → `/icici-lombard/coi/:id`,
   `/api/icici_emi_due` → `/icici-lombard/emi/due`, `/api/icici_emi_process` →
   `/icici-lombard/emi/process`, `/api/icici_zone` → `/icici-lombard/zone`.

## Verified

- `npm run test:icici` — 43 checks against a mock speaking ICICI's wire format,
  including all 17 tests of the standalone service.
- Live UAT (2026-09-16): token ✅; premium ✅ (`bnc_…` minted, priced); proposal
  status reached ICICI ✅ (`Proposal details not found` for an unproposed quote,
  as expected); through the HTTP stack on the `/health` alias with the SPA's own
  request shape ✅; CORS preflight from the production origin ✅.
- Zone answers **HTTP 404** on the UAT host. The standalone service gets the
  identical 404 from the same URL, so it is an ICICI-side entitlement/path issue,
  not a migration defect.
- Not run live, because each writes at ICICI: CKYC (verifies a real identity),
  proposal-payment, policy sync, EMI process, OVD. Covered by the mock suite.
