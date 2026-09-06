# IFFCO Tokio (ITGI) — Partner Health

A second insurer alongside Niva Bupa, in the same service and under the same
architecture. HTTP Basic REST/JSON, two contract types (FHP and IHP) sharing one
set of endpoints, and issuance that completes through **ITGI's own hosted
payment page** rather than an API call of ours.

Everything under `/iffcotokio/*` is also served under `/health/iffcotokio/*`
(the same compatibility alias the Niva Bupa routes use). For ITGI that alias is
load-bearing — see [The payment redirect](#the-payment-redirect-read-this-one).

---

## Contents

- [Configuration](#configuration)
- [Routes](#routes)
- [The flow](#the-flow)
- [The payment redirect](#the-payment-redirect-read-this-one)
- [Request rules worth knowing](#request-rules-worth-knowing)
- [CKYC](#ckyc)
- [How failures arrive](#how-failures-arrive)
- [UAT → production](#uat--production)
- [Troubleshooting](#troubleshooting)
- [Files](#files)

---

## Configuration

**Four variables decide everything.** There are no bundled fallbacks: no ITGI
host, credential or partner code exists anywhere in the source, and a process
that was not given them cannot reach ITGI at all — the endpoints answer `503`
naming what is missing, and Niva Bupa is unaffected.

| Variable | What it is |
| --- | --- |
| `ITGI_BASE_URL` | The ITGI host. Every path is appended to it, so this one value moves the integration between UAT and production. |
| `ITGI_USERNAME` | HTTP Basic user, issued by ITGI. |
| `ITGI_PASSWORD` | HTTP Basic password, issued by ITGI. |
| `ITGI_PARTNER_CODE` | Our partner code. Sent as `partnerDetail.partnerCode` on every request, and the key ITGI hold the payment response URL against. |

Plus one that is **ours**, not theirs:

| Variable | What it is |
| --- | --- |
| `ITGI_PAYMENT_RETURN_URL` | The URL ITGI redirect the buyer to after payment, registered on **their** side. This service never sends it — it is checked at boot against the route actually served, and a mismatch is reported loudly. |

Everything else has a working default and is listed in `.env.example`:
`ITGI_FRONTEND_RETURN_PATH`, `ITGI_CONTRACT_TYPE`, `ITGI_MAX_RETRIES`,
`ITGI_API_TIMEOUT_MS`, `ITGI_CKYC_CREATE_TIMEOUT_MS`, `ITGI_JSON_BODY_LIMIT`,
`ITGI_DEBUG`, `ITGI_CORS_ORIGINS`, `ITGI_PAYMENT_GATEWAY_URL`, and the seven
`ITGI_*_PATH` contract paths.

`GET /iffcotokio/config/test` reports whether this process can reach ITGI,
without calling them and without printing a single value.

---

## Routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/iffcotokio/config/test` | Is ITGI configured? Prints no values. |
| `POST` | `/iffcotokio/premium` | Quote. |
| `POST` | `/iffcotokio/proposal` | Submit → `orderNo` + the payment form. |
| `POST` | `/iffcotokio/payment/initiate` | Rebuild the gateway form from an `orderNo`. No upstream call. |
| `GET`/`POST` | `/iffcotokio/payment/return` | **ITGI's redirect.** Registered with them. |
| `POST` | `/iffcotokio/payment/confirmation` | Partner-collected payment. Disabled for our partner code. |
| `POST` | `/iffcotokio/policy-download` | Policy document link. |
| `POST` | `/iffcotokio/kyc/fetch` | CKYC search — the only source of `itgiKYCReferenceNo`. |
| `POST` | `/iffcotokio/kyc/create` | CKYC create. **Writes** to ITGI and CERSAI. |

Every response carries `itgiRequest`: the URL, headers (credential
fingerprinted, never printed) and the complete body that went upstream — the
same treatment the Niva Bupa routes give `nivabupaRequest`, and for the same
reason. ITGI's rejections routinely name a field that is perfectly correct, so
the rejection is only actionable next to the payload that produced it.

Failures answer:

```json
{ "status": "ERROR", "code": "ITGI_VALIDATION_ERROR", "message": "…",
  "field": "health.nominee[0].nomineeRelationship",
  "itgi_response": { "errors": [ … ] }, "itgiRequest": { … } }
```

| `code` | HTTP | Meaning |
| --- | --- | --- |
| `ITGI_VALIDATION_ERROR` | 400 | Refused locally, before any round trip. `field` names it. |
| `ITGI_CONFIG_ERROR` | 503 | Not configured. `itgi_response.missing` lists the variables. |
| `ITGI_AUTH_ERROR` | 502 | 401/403 — credentials, or an unwhitelisted IP. |
| `ITGI_UPSTREAM_ERROR` | 502 | ITGI rejected it. `itgi_response` carries their own message. |
| `ITGI_TIMEOUT_ERROR` | 504 | No answer inside the budget. |

---

## The flow

1. **`POST /iffcotokio/kyc/fetch`** → `itgiUniqueReferenceId` (the IURN). No
   record? `POST /iffcotokio/kyc/create`.
2. **`POST /iffcotokio/premium`** → `premiumPayable`.
3. **`POST /iffcotokio/proposal`** (carrying that premium as
   `health.premiumPayble` and the IURN as `itgiKYCReferenceNo`) → `orderNo`,
   `traceNo`, `ptnrTransactionLogId`, and a ready-to-submit `payment` block.
4. **The browser POSTs that form to ITGI's hosted gateway.** The buyer pays
   there; **ITGI issue the policy themselves**.
5. **ITGI redirect the buyer to `/iffcotokio/payment/return`**, carrying the
   policy number. This service records it and 302s into the SPA.
6. **`POST /iffcotokio/policy-download`** with that **policy** number.

`contractType` (`FHP` floater / `IHP` per-member) and `partnerDetail.partnerCode`
are filled from config, so a caller sends neither.

---

## The payment redirect (read this one)

> **Partner-end payment collection is disabled for our partner code.** With
> every mandatory field supplied, `/payment/confirmation` answers
> `partnerDetails: "Payment at partner end is not allowed for this product."`
> (verified on staging 2026-08-21, `ITGIHLT073`, FHP). It is a product
> entitlement, not a payload fault.

So ITGI take the money and issue the policy, and the **only** channel by which a
policy number reaches this service is their redirect:

```
{ITGI_PAYMENT_RETURN_URL}?ITGIResponse=product|orderNo|traceNo|policyNo|premium|message
```

e.g. `IHP|IHP20260826U20|087610|H1622549|5539|SUCCESS`. `message` is one of
`SUCCESS`, `FAIL`, `DECLINED`, `PENDING`, `RESPONSE_MISMATCH`.

Three consequences:

* **The URL is registered on ITGI's side**, keyed to the partner code. Changing
  where this service lives means asking ITGI to update it. Startup checks
  `ITGI_PAYMENT_RETURN_URL` against the route actually served and complains when
  they disagree.
* **The `/health` alias is not optional here.** The registered UAT URL is
  `https://healthinsurance.tommyandfurry.com/health/iffcotokio/payment/return`,
  which goes through it. Setting `NIVABUPA_ALIAS_PREFIX=` would take the payment
  callback offline.
* **The handler must never 429 or 404.** In the August 2026 UAT run, six live
  payments redirected to a host with no handler for this path; every one
  answered `Route not found` and every policy number was lost. That is the
  failure this route exists to prevent, and why it keeps the policy number in
  the redirect to the SPA even on a `FAIL`.

The SPA lands on `FRONTEND_URL + ITGI_FRONTEND_RETURN_PATH` with
`status`, `policyNumber`, `orderNo`, `traceNo`, `premium`, `product`, and
`message` on a non-success.

---

## Request rules worth knowing

Everything below is enforced locally, before the round trip, because ITGI answer
a malformed health request with **HTTP 200 and a generic `error[]`**.

| Rule | Detail |
| --- | --- |
| `itgiKYCReferenceNo` | **Always required**, including when `ignoreCkyc` is `"true"` — that flag turns off the *validation* of the reference, not the need to send one. |
| ITGI check it against the **proposer** | `205 / Invalid KYC details` does not mean "fake reference", it means "not this person's". Check the pair, not the reference. |
| Member `relationship` | Full words — `Self`, `Spouse`, `Daughter`… |
| `nomineeRelationship` | **Short codes** — `SELF`, `SPOU`, `BRO`, `FATR`, `MOTR`. A different master. The FHP sample in the kit gets this wrong. |
| `nomineePercentageShare` | Each > 0, summing to exactly 100. |
| Dates | `dd/MM/yyyy` on the health endpoints. `inceptionDate` not before today; `expirationDate` after it. |
| Lifestyle | `alcohol`/`smoke`/`tobacco` = `Y` makes the matching per-week/per-day field mandatory. |
| Medical | All five qids (Q1, Q2, Q11, Q98, Q99) per member. `true` on **Q98 or Q99** means ITGI will not sell online — refused locally. |
| Medical `question` | The question **text** must be present and non-null on every entry. Callers may send `{qid, answer}`: the service fills it. See below. |
| Sum insured | FHP: one floater `health.sumInsured`. IHP: one per member. Checked against the workbook master. |
| IHP only | `health.kycDocument` + `health.kycDocumentNo` (max 12). |
| Policy download | Takes `policyDownloadNo` — the **policy** number, not the `orderNo`. |

### `medicalHistoryQuestions[].question` is load-bearing

ITGI dereference `question` while deserializing the proposal. An entry carrying
only `{ qid, answer }` — the shape the field dictionary describes — kills the
**whole** proposal with `errorField: "runtime"`, which names nothing and reads
exactly like the missing-`itgiKYCReferenceNo` fault, so it sends you checking
KYC. Isolated on staging 2026-08-24 against byte-identical payloads: present and
non-null passes, absent or `null` fails; `""` and arbitrary text both pass. It
is their NPE, not a rule. `helpers/itgi.helper.js` fills any gap from the kit's
own wording without touching a caller's own text.

### Product bands are narrower than the master, and are not encoded here

On UAT for `ITGIHLT073` (2026-08-18): FHP accepted ₹5L–₹30L and IHP ₹3L–₹20L;
below that, `sumInsured: Invalid value from sum insured.` FHP also requires **at
least two members**. Those are ITGI's product configuration, differ per
environment and partner code, and are deliberately left to ITGI to answer —
hardcoding a UAT band would reject values a production product may well sell.

---

## CKYC

Documented in ITGI's *Partner CKYC Kit v1.4.1*, a separate kit from the v3.5
health one — which is why no health workbook mentions it. Two things the kit
gets wrong for this host, both confirmed by byte-identical requests:

* **Basic auth is required** (the kit shows none and assumes IP whitelisting).
* **`/kyc/fetch-validate-otp` answers 404**, so the OTP leg of the documented
  flow is not callable and is deliberately not implemented.

Dates here are **`DD-MM-YYYY` with hyphens** — not the health endpoints' slashes.

`fetch` judges a record by whether it carries an IURN, not by matching a known
status label: on 2026-08-26 a live search answered `CKYCInProgress` — a value in
no ITGI kit — carrying a perfectly good reference, and a label allow-list
reported `verified: false`, discarded it, and pushed the customer to create a
record they already had.

`create` writes to ITGI and CERSAI, takes ~44 seconds, and is not idempotent —
never retried, and given its own timeout. Its `idName` vocabulary is
**undocumented**; the accepted values come from staging observation plus one
value ITGI gave by email:

> Aadhaar is `"AADHAR CARD NUMBER"` — single `A`, with the trailing words.
> `AADHAAR`, `AADHAAR CARD`, `AADHAAR_CARD` and `UID` are all refused, and the
> refusal names the *idType* rather than the document, so it reads as a bad
> upload. The service points straight at the right spelling.

`idNumber` accepts letters, digits and `/ [ ] { } ( ) -` — no spaces, no commas,
not empty.

---

## How failures arrive

ITGI report a failure in **four** places, and three of them arrive with HTTP
200. `services/itgiApi.service.js` checks all four:

| # | Where | Shape |
| --- | --- | --- |
| 1 | HTTP status | transport and auth failures only |
| 2 | `error[]` (health) | `{errorField, errorMessage}` |
| 3 | `errors[]` (CKYC) | `{objectName, field, message}` — plural, different shape |
| 4 | body `status` (CKYC) | a rejection is HTTP 200 carrying `"status": "400"` |

Checking only the health shape made every CKYC refusal read as a success whose
`result` happened to be missing.

**Retries:** transport failures and 502/503/504 only, never a 4xx and never a
200 carrying `error[]`. `proposal`, `payment/confirmation` and `kyc/create` are
**never** retried on anything — a timeout there means the outcome is unknown,
not that it failed, and a blind replay is how one buyer becomes two proposals.

---

## UAT → production

Change `.env`. Nothing else.

```env
ITGI_BASE_URL=<production host>
ITGI_USERNAME=<production>
ITGI_PASSWORD=<production>
ITGI_PARTNER_CODE=<production>
ITGI_PAYMENT_RETURN_URL=https://<your-domain>/health/iffcotokio/payment/return
```

`NODE_ENV=production` **refuses to start** when `ITGI_BASE_URL` still looks like
UAT/staging — the same rail the Niva Bupa endpoints have, and for the same
reason: real buyers transacting against a UAT tenant is a silent failure.

One thing is **not** purely `.env`: `ITGI_PAYMENT_RETURN_URL` is registered on
ITGI's side against the partner code. Setting the variable tells this service
what to expect; **ITGI must be asked to update what they actually redirect to.**

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `503 ITGI_CONFIG_ERROR` | One of the four variables is unset. `itgi_response.missing` names them. |
| `502 ITGI_AUTH_ERROR` | Wrong credentials — or an unwhitelisted server IP. ITGI's Annexure II asks partners to register their public IP; UAT was reachable without it, production may not be. |
| `errorField: "runtime"`, "technical fault" | ITGI's catch-all for a payload they could not parse. Two known causes, indistinguishable from the message: a missing `itgiKYCReferenceNo`, and a `medicalHistoryQuestions` entry with no `question` (this service fills that one). |
| `partnerDetails: "Partner details are invalid."` on a policy download | Almost always a **missing `contractType`**, not the partner code. Supplying it turns the same request into the true answer. |
| `205 / Invalid KYC details` | The IURN does not match this proposer. Check the pair. |
| `RESPONSE_MISMATCH` at the gateway | The amount posted differs from the policy premium. Re-quote and re-propose. |
| Blanket `INVALID REQUEST` on **both** CKYC endpoints | An ITGI-side outage, not your payload — check `/health/premium` on the same credentials to tell them apart. It has happened and recovered on its own. |
| `policy/download` says SUCCESS but the link says "Policy is not active." | Policy-specific, seen for ~20 minutes on one policy while a byte-identical re-run issued one whose PDF served immediately. A SUCCESS is not on its own proof of a retrievable document — fetch the link. |

---

## Files

```
src/config/env.js                     config.itgi — the only place the environment is read
src/config/defaults.js                ITGI_DEFAULTS — contract paths only, no host or secret
src/config/validate.js                boot report + the production rail
src/constants/itgi.constants.js       masters, medical questions, CKYC and gateway vocabulary
src/helpers/itgi.helper.js            request prep, response normalisers, the redirect parser
src/helpers/itgiValidation.helper.js  pre-flight validation for every payload
src/services/itgiApi.service.js       transport: Basic auth, 4-way failure detection, retries
src/services/itgiCkyc.service.js      CKYC fetch / create
src/controllers/itgi.controller.js    the nine handlers
src/routes/itgi.routes.js             the route table
src/routes/index.js                   createItgiRouter() — CORS, body limits, journey context
```
