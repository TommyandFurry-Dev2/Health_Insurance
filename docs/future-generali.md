# Future Generali (FG) — Health

A third insurer alongside Niva Bupa and IFFCO Tokio, in the same service and
under the same architecture. TCS "BO" **SOAP/XML** rather than REST, a payment
step that is a **browser round trip with an encrypted callback** rather than an
API call, and issuance that **this service performs** rather than the insurer.

Everything under `/future-generali/*` is also served under
`/health/future-generali/*` (the same compatibility alias the Niva Bupa and
IFFCO Tokio routes use). For FG that alias is load-bearing — see
[Payment](#payment-read-this-one).

Migrated on 2026-09-09 from the standalone `novacred-insurance-integrations`
service, which the SPA reached on `localhost:4002` and which was never deployed
— so FG could not work anywhere but a developer's machine. The migration moved
the **routes** and the **base URL** and kept FG's own request and response
bodies unchanged on both sides of the hop, exactly as the IFFCO Tokio migration
did.

---

## Contents

- [Configuration](#configuration)
- [Routes](#routes)
- [The flow](#the-flow)
- [Payment (read this one)](#payment-read-this-one)
- [Request rules worth knowing](#request-rules-worth-knowing)
- [CKYC](#ckyc)
- [The policy document](#the-policy-document)
- [How failures arrive](#how-failures-arrive)
- [UAT → production](#uat--production)
- [Troubleshooting](#troubleshooting)
- [Files](#files)

---

## Configuration

**Four variables decide whether FG can be reached at all.** There are no bundled
fallbacks: no FG host, credential, vendor/agent/branch code or gateway URL
exists anywhere in the source, and a process that was not given them cannot
reach FG — the endpoints answer `503` naming what is missing, and Niva Bupa and
IFFCO Tokio are unaffected.

| Variable | What it is |
| --- | --- |
| `FG_BO_BASE_URL` | The TCS BO service host. Every SOAP path is appended to it, so this one value moves the integration between UAT and production. |
| `FG_VENDOR_CODE` | Partner identity, issued by FG. Travels inside the `<Root>` payload as `<VendorCode>`, not as a header. |
| `FG_AGENT_CODE` | `<AgentCode>`. |
| `FG_BRANCH_CODE` | `<BranchCode>`. |

Plus one that blocks everything after the quote:

| Variable | What it is |
| --- | --- |
| `FG_BANCA_CHANNEL` | **Required by the proposal and by issuance; quoting works without it.** Both fail with `BancaChannel Value INVALID` until it is correct, and the valid value is **not in FG's integration kit and cannot be derived** — FG must issue it for the configured vendor code. Startup warns when it is unset. |

And four the payment leg needs. Without them, quote, proposal and CKYC still
work and `/future-generali/payment/*` answers `503`:

| Variable | What it is |
| --- | --- |
| `FG_PAYMENT_GATEWAY_URL` | Where the browser is POSTed to pay. **One variable, no default** — deliberately not a UAT/production pair with a boolean between them, so a build cannot be one unset flag away from taking real money on a test tenant. |
| `FG_PAYMENT_RETURN_URL` | **Ours.** Sent to FG as `ResponseURL` on every payment form. |
| `FG_PG_CRYPTO_KEY` | 8-byte DES key that decrypts FG's payment response. |
| `FG_PG_CRYPTO_IV` | 8 comma-separated bytes. |

> **Quote `FG_PG_CRYPTO_KEY` in `.env`.** FG's key contains a `#`, and an
> unquoted `#` starts a **comment** in a `.env` file: the variable is then set,
> looks set in every report, and is two bytes long. Nothing notices until a real
> callback cannot be decrypted and the payment is reported as `unverified` —
> money may have moved — for a reason that has nothing to do with FG. Startup
> checks the key's length and **refuses to boot** when it is wrong.

Everything else has a working default and is listed in `.env.example`.

`GET /future-generali/config/test` reports whether this process can reach FG,
without calling them and without printing a single value. It reports the quote,
payment, CKYC and document legs **separately**, because they fail independently.

---

## Routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/future-generali/config/test` | Is FG configured? Prints no values. |
| `POST` | `/future-generali/quote` | `CreatePolicy` / `METHOD=ENQ`. Premium only. |
| `POST` | `/future-generali/proposal` | `HealthPreCRTValidate` / `METHOD=CRT`. |
| `POST` | `/future-generali/issue` | `CreatePolicy` / `METHOD=CRT` + Receipt. **Raw** — prefer `payment/issue`. |
| `POST` | `/future-generali/ckyc/create` | CKYC submit. |
| `POST` | `/future-generali/ckyc/status` | CKYC poll. |
| `POST` | `/future-generali/payment/session` | Builds the 13-field gateway form + CheckSum. |
| `ALL` | `/future-generali/payment/return` | **FG's callback.** Decrypts, stores, redirects. |
| `GET` | `/future-generali/payment/result/:token` | What the return page reads. |
| `POST` | `/future-generali/payment/issue` | Issues once, from a verified payment. |
| `GET` | `/future-generali/policy/:policyNo/pdf` | What FG say about the document. `?meta=1` to avoid fetching it. |
| `GET` | `/future-generali/policy/:policyNo/pdf/download` | Streams the PDF. `?download=1` for an attachment. |

Every response carries `fgRequest`: the URL, headers (credentials
fingerprinted, never printed) and the complete body that went upstream — the
same treatment the Niva Bupa routes give `nivabupaRequest` and the ITGI routes
`itgiRequest`. Here it is load-bearing rather than convenient: **FG's single
generic rejection is an empty `*Result` with no reason attached**, so the
payload that produced one is the only thing that makes it diagnosable.

Success answers `{ ok, provider, operation, data, meta }`; failure answers
`{ ok: false, error: { code, message, provider, field?, details } }`. That is
the standalone service's envelope, kept deliberately — the SPA's FG pages are
written against it, and changing it would mean rewriting them to gain nothing a
buyer or an operator can see.

| `code` | HTTP | Meaning |
| --- | --- | --- |
| `FG_VALIDATION_ERROR` | 400 | Refused locally, before any round trip. `field` names it. |
| `FG_CONFIG_ERROR` | 503 | Not configured. `details.missing` lists the variables. |
| `FG_AUTH_ERROR` | 502 | GC-CKYC token rejected. |
| `FG_UPSTREAM_ERROR` | 502 | FG rejected it, or a SOAP Fault. |
| `FG_PARSE_ERROR` | 502 | Unreadable response — including the empty `*Result`. |
| `FG_TIMEOUT_ERROR` | 504 | No answer inside the budget. |

---

## The flow

1. **`POST /future-generali/quote`** → `totalPremium`, `premiumWithServiceTax`,
   and a per-member breakdown. Nothing is created at FG.
2. **`POST /future-generali/ckyc/create`** → a CKYC number, or an `uploadUrl` to
   send the customer to. Poll `ckyc/status` until `finalStatus` is `1` or `3`.
3. **`POST /future-generali/proposal`** carrying the quoted premium as
   `receipt.amount` → `Status: Success` and `preCrtTranId`, FG's reference.
4. **`POST /future-generali/payment/session`** → the form the browser POSTs to
   FG's gateway. **Pass `proposal`** — see below.
5. **The browser POSTs that form to FG's hosted gateway.** The buyer pays there.
6. **FG POST the outcome, encrypted, to `/future-generali/payment/return`.**
   This service decrypts it, **starts issuance immediately**, and 303s the
   browser to the SPA with an opaque token.
7. **`GET /future-generali/payment/result/:token`** → the outcome and the
   issuance state. The SPA polls while `issuanceState` is `in_progress`.
8. **`GET /future-generali/policy/:policyNo/pdf`** — poll; FG generate the
   document 15–25 seconds *after* issuance.

`VendorCode`, `AgentCode`, `BranchCode` and `BancaChannel` are filled from
config, so a caller sends none of them.

---

## Payment (read this one)

FG expose **no payment API**. The browser is handed to their gateway page and
the outcome comes back as an **encrypted form POST**, so four routes cover what
a single-page app cannot do on its own.

**CheckSum** is `SHA-256` over the eleven posted values joined with `|` **and a
trailing pipe** — `TransactionID|…|Email|`. `Vendor` and `CheckSum` are excluded
from the input. A 64-char lowercase digest, not an encoding of the string.

**PaymentOption** selects the gateway, not the instrument: `1` PayTm, `2` HDFC,
`3` PayU. On FG's UAT only PayU works — PayTm fails its own checksum
verification inside FG's code, and HDFC answers "Error on payment gateway".

**The response is encrypted** — DES-CBC, which Node performs as `des-ede3-cbc`
with the 8-byte key repeated (3DES with K1=K2=K3 *is* single DES), base64, with
`+` transported as `$`. Decrypted it is a query string:

```
WS_P_ID=TP025482&TID=AJ12345009&PGID=403993715515706205&Premium=100.00&Response=Success
```

`WS_P_ID` becomes `<UniqueTranKey>` and `PGID` becomes `<TranRefNo>` on
issuance; the service applies that mapping so no caller has to remember it.

### The ResponseURL is ours, and nothing else holds a copy

Unlike IFFCO Tokio's registered redirect, **this service sends the ResponseURL
on every payment form**, so `FG_PAYMENT_RETURN_URL` alone decides where the
outcome lands. It must end in `/future-generali/payment/return`, must be
reachable **from FG's servers**, and must point at this service — never at the
SPA, which cannot read a POST body. The deployed host proxies only `/health`, so
the alias is part of the URL:

```
https://healthinsurance.tommyandfurry.com/health/future-generali/payment/return
```

A callback that lands on a 404 takes `WS_P_ID` and `PGID` with it, and issuance
is impossible without both. Startup checks the variable against the route served
and complains when they disagree.

### ⚠️ Revalidate every transaction — this is a security control

FG's v1.39 says it plainly:

> "As a recommended security measure, you validate each transaction response via
> an API call. Transaction revalidation protects from request/response tampering
> possible in browser calls."

For this integration it is not optional advice. The payment outcome arrives as a
form POST to a **public** callback route, and the DES key that encrypts it is
**printed in FG's own integration PDF and is identical for every FG partner**. So
the ciphertext authenticates nothing — anyone holding the kit can encrypt
`Response=Success` for a transaction id and post it. The only remaining obstacle
is that this service issues solely for a `TransactionID` it is holding a proposal
against, which is exactly what a buyer who starts a payment and abandons it has.

Set **`FG_RECONCILE_URL`** and the service asks FG server-to-server, before
issuing anything:

```
POST {FG_RECONCILE_URL}
<FetchTRNDetails xmlns="http://tempuri.org/">
  <transactionId>T497555205</transactionId>
  <source>webaggregator</source>
</FetchTRNDetails>
```

FG answer with `TransactionStatus`, `PaymentAmount`, `PGTransactionID`,
`AuthCode` and `FG_Transaction_ID`. Three outcomes, and the third is the point:

| Outcome | Meaning | What happens |
| --- | --- | --- |
| **verified** | FG confirm a success for this id, for a matching amount | Issue. |
| **rejected** | FG have no such transaction, report it as not-success, or report a *different amount* | **Refuse.** `FG_PAYMENT_UNVERIFIED`. This is a failed or tampered payment. |
| **unknown** | FG could not be reached or read | **Not a rejection** — money may have moved. Issuance proceeds and the gap is logged, because refusing here would strand a paying customer over an outage on an advisory service. |

Unset, issuance proceeds on the browser's word alone and a warning is logged at
boot and on every issuance. The service URL published in v1.39 is
`https://gen.futuregenerali.in/quick_pay/quickpay/comservice.asmx` (live) — ask
FG for the UAT equivalent, which the document does not give.

### Issuance does not wait for the browser

`POST /future-generali/payment/session` takes an optional **`proposal`** — the
same payload `createProposal` was given. It is kept against the `TransactionID`,
and when FG's callback arrives the service issues from it **immediately**,
without awaiting the response (issuance can take two minutes; the browser has to
be redirected at once).

**Pass it.** Without it, the only copy of the payload FG validated is in the
buyer's `localStorage`, and issuance depends on that surviving a trip to an
external payment page. Incognito, a cleared store, another device, a closed tab
— each one collects the premium and leaves nobody able to issue. Observed on UAT
2026-08-21 on a real ₹13,886 payment: `status: success`, `canIssue: true`,
`issuanceState: not_started`, and no way to move it from the UI.

The response says which case you are in — `proposalHeldForIssuance: true|false`
— and a session without one logs a warning rather than failing.

### Issuing at most once

Racing is safe. The store claims the payment before issuing, keyed on FG's
`WS_P_ID`, so the callback and the returning page cannot both issue: whichever
is second is refused the claim and gets the first one's outcome. A **repeated
callback** resolves to the original token for the same reason.

Three outcomes are tracked, not two, because "it failed" and "we do not know"
carry opposite risks:

| `issuanceState` | Meaning |
| --- | --- |
| `issued` | Final. Nothing may issue against this payment again. |
| `not_started` / `in_progress` | Poll `payment/result/:token`. |
| `unresolved` | **FG never answered.** They may already hold a policy. Nothing retries automatically; only a deliberate `force: true` proceeds, and that is a human's call. |

A response that arrives but cannot be decrypted is reported as `unverified`, not
as "no payment received" — money may have moved, and the buyer must never be
invited to pay twice.

> **The result store is in memory.** A restart loses the token→result mapping,
> so a late callback is answered as an unknown token. That is survivable here
> because this service has a database: **every callback is written to
> `nivabupa_api_transactions` before the browser is redirected**, carrying
> `WS_P_ID`, `PGID` and `TID` — exactly what FG's reconciliation asks for. A lost
> token costs the buyer their automatic issuance, not their payment.

---

## Request rules worth knowing

| Rule | Detail |
| --- | --- |
| Dates | **`dd/mm/yyyy`** in the SOAP payload, **`dd-mm-yyyy`** in CKYC. The two are not interchangeable and both are validated locally. |
| `receipt.amount` | **Required on every CRT call**, proposal included — not just issuance, whatever the kit says. An empty `<Amount>` is answered `Fail_Ex`, a token that names nothing. |
| Height / weight | **cm and kg.** FG have no BMI element — they derive it, and report a blank or wrongly-scaled pair as `BMI is Invalid for Member N`. Required on CRT, optional (but warned) on ENQ. |
| Coded fields | `occupation`, `relation`, `nomineeRelation`, `salutation`, `maritalStatus`, `gender` and `policyType` are **FG's own masters**, not free text. Validated locally — see below. |
| Member `insuredDob` / `sumInsured` | Required and format-checked on **every** call, quote included: FG derive `<Age>` from one and rate against the other, so a request missing either is not an early quote but a broken one. An absent `sumInsured` used to reach FG as the literal text `<SumInsured>undefined</SumInsured>`. |
| Products | `HEALTH_ABSOLUTE` and `ADVANTAGE_TOP_UP` are sellable. `HEALTH_TOTAL` is **discontinued** and refused locally — FG answer an empty `*Result` for it, which reads like a provisioning fault. |
| Member shape | The three products do **not** share a `<Member>` layout. Sending the wrong one produces the same empty `*Result`. |
| Empty elements | Emitted as empty tags, never omitted. The element order on the wire never changes. |
| FG's misspellings | `AptRelWithominee` (Health Total) really is missing its `N`, and `PremiumDeatils` really is misspelled in responses. Both are reproduced as found — a "corrected" tag is an element FG do not know. |

### The coded-value masters

FG's `Field Masters for Health Absolute.xlsx` publishes the closed code lists,
and they are **generated** into `constants/fg.constants.js` from that workbook —
not transcribed. `helpers/fgCodes.helper.js` validates against them **on CRT
only**, because the quote leg does not check them and enforcing there would break
quoting to fix proposals.

This exists because of how FG reject a wrong code: a bare sentence naming the
field and nothing else — `Occupation is incorrect.` No code, no field path, no
hint at the accepted values, and no way to tell which member carried it. The
local check answers with the field, the member, and the codes FG accept:

```
risk.members[0].insuredOccupation "Professional" is not one of Future Generali's
published <Occupation> codes. Did you mean PRFS (Professional), PROF (Professor)?
```

That example is not hypothetical. `PROF` is FG's code for **Professor**;
Professional is `PRFS`. The frontend offered `PROF` labelled "Professional" — it
passed validation, because it is a real code, just not that one — so every buyer
who picked Professional was underwritten as a professor. A probe tests
acceptance; only the master tests meaning.

| Master | Codes | Notes |
| --- | --- | --- |
| `FG_OCCUPATION` | 140 | `<Occupation>` and `<InsuredOccpn>` |
| `FG_RELATION` | 9 | `SIB`, `GRPA`, `GRCH` are **quotation-only** and refused on a proposal |
| `FG_NOMINEE_RELATION` | 9 | Plain English is accepted and normalised to the code |
| `FG_SALUTATION` | 18 | |
| `FG_MARITAL_STATUS` | 5 | FG list six rows; `W` is both Widow and Widower |
| `FG_GENDER` | 3 | `M`, `F`, `O` |
| `FG_POLICY_TYPE` | 2 | `HAI` individual, `HAF` family floater |

**Advisory-strict, deliberately.** FG's runtime accepts a *superset* of their own
masters: their FHA samples send `<NomineeRelation>BROT</NomineeRelation>`, which
appears in no master, and a live probe accepted the occupation `STUD` although
the master publishes `STDN`. So the check rejects a value FG would almost
certainly reject too, and says the value is not in FG's *published* list rather
than claiming FG will refuse it. Codes observed-but-undocumented are allowed
through explicitly.

`<NomineeRelation>` is the one field the kit genuinely contradicts itself on —
plain mixed case ("Mother") appears alongside codes. The split is by **product**
and it is decisive: all six Health Absolute samples and all four Advantage Top Up
samples send the code; every plain-English instance belongs to Varishta Bima or
the shared Postman collection, neither implemented here. So codes go on the wire,
and plain English is normalised rather than refused.

### The client handshake

For a customer FG have not seen before, the **first** CRT call creates the
client record and *fails* with `Please retry with Client ID <n>.` The same
request must then be replayed with that value in `<ClientID>`. The service does
that once, automatically, so a caller sees one logical operation.

---

## CKYC

Two services behind one interface; `config/test` says which is live.

| | legacy NL-CKYC | **GC-CKYC 3.0.0** |
| --- | --- | --- |
| Auth | static `token` + `x-client-id` | OAuth2 **password** grant → Bearer |
| Reference issued | `PR_` + 10 chars | `PR_` + 13 chars |
| Resume a verification | not supported | yes, via `proposalId` |
| Return the buyer to us | not supported | yes, via `redirectUrl` |

GC-CKYC is selected when `FG_GCKYC_ENABLED=true` **and** all six values are
present; a partial config logs a warning and falls back to legacy rather than
failing the KYC step. **It matters which one runs** — every working proposal
sample FG have sent carries a 13-character `PR_` reference, which only GC-CKYC
issues.

**Pass `proposalId` when retrying.** GC-CKYC resume that verification and return
the same id and URL; without it a retry mints a new record and orphans anything
already uploaded.

Known UAT oddity: GC-CKYC return `ckyc_remarks: "Mobile number length should be
10 digits"` even for a valid 10-digit mobile, alongside a usable URL. It does not
block the flow — informational, not an error.

The upload itself happens on **FG's own hosted page**. Their kit has no
document-upload API of any kind, so that one-time link is the only route they
provide.

---

## The policy document

A separate WCF endpoint with its own contract — `IService1`, not `IService` —
and `<PolicyNO>` has a **capital O**.

**`<GetPDFResult>` is a LINK, never base64.** The service follows it and returns
the bytes; handing the link to the browser does not work, because it is plain
`http` (blocked as mixed content) on a host a customer's browser cannot reach.
Only a link on FG's own configured hosts is followed — the URL arrives inside an
upstream response, and fetching whatever an upstream names is the shape of an
SSRF.

**The document does not exist at the moment of issuance.** For roughly the first
15–25 seconds FG answer `Kindly contact FG for policy document.` — the same
sentence they return for a policy number they do not know, and the two cannot be
told apart. So it is reported as `PDF_NOT_READY` with `retryable: true`, and the
SPA polls `?meta=1` rather than showing a failure. **Every buyer arriving
straight from the payment gateway hits this**; the policy itself is unaffected.

---

## How failures arrive

FG report failures in **five** shapes, four of which arrive with HTTP 200:

| # | Where | Shape |
| --- | --- | --- |
| 1 | HTTP status | transport faults, and the https/http binding trap below |
| 2 | SOAP `<Fault>` | HTTP 500 **with** an envelope — `faultstring` carries the reason |
| 3 | An **empty `*Result`** | FG's one generic rejection, with no reason attached |
| 4 | `<Status>Fail</Status>` + `<ValidationError>` | a business rejection, in plain English |
| 5 | Bare text under `<Root>` | a fault inside FG's own server — `The device is not ready.` — with no element to name it |

The fifth is easy to drop: without it the caller sees `status: Fail` and
`errorMessage: null`, which is the shape that says least about a failure FG have
actually explained.

**Retries:** transport failures and 502/503/504 only, never a 4xx and never a
business rejection. **Issuance is never retried on anything, including a
timeout** — a timeout means the outcome is unknown, not that it failed, and a
blind replay is how one premium becomes two policies.

---

## UAT → production

Change `.env`. Nothing else.

```env
FG_BO_BASE_URL=<production host>
FG_PDF_BASE_URL=<production host>
FG_VENDOR_CODE=<production>
FG_AGENT_CODE=<production>
FG_BRANCH_CODE=<production>
FG_BANCA_CHANNEL=<production, issued by FG>
FG_PAYMENT_GATEWAY_URL=https://<fg-prod-host>/Ecom_NL/WEBAPPLN/UI/Common/WebAggPayNew.aspx
FG_PAYMENT_RETURN_URL=https://<your-domain>/health/future-generali/payment/return
FG_RECONCILE_URL=https://gen.futuregenerali.in/quick_pay/quickpay/comservice.asmx
FG_GCKYC_TOKEN_URL=<production>
FG_GCKYC_BASE_URL=<production>
FG_GCKYC_CLIENT_KEY=<production>
FG_GCKYC_CLIENT_SECRET=<production>
FG_GCKYC_USERNAME=<production>
FG_GCKYC_PASSWORD=<production>
```

`NODE_ENV=production` **refuses to start** when any FG host or the payment
gateway still looks like UAT/staging — the same rail the Niva Bupa and IFFCO
Tokio endpoints have. The gateway is the sharpest case: a production build
pointed at FG's UAT gateway would take real money on a test tenant.

Unlike IFFCO Tokio, **nothing here is registered on FG's side**. The ResponseURL
travels on every request, so moving this service is purely a `.env` change.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `503 FG_CONFIG_ERROR` | One of the four variables is unset. `details.missing` names them. |
| **Zero-byte 404 on every POST** | `FG_BO_BASE_URL` is `https` on a host that binds the BO service to `http` only. Over https the `.svc` help page answers a GET, so the URL looks alive. |
| Empty `*Result`, no reason | FG's generic rejection. **Retry first** — their rating service answers this while it is down. Otherwise: the product is not provisioned for this agent code, the CoverType is not one it rates on, or a vendor/agent/branch code is wrong. |
| `BancaChannel Value INVALID` | `FG_BANCA_CHANNEL` is unset or wrong. FG must issue it for your vendor code; it is not in the kit. |
| `Fail_Ex` on a proposal | An empty `<Receipt><Amount>`. Pass the quoted premium. It reads like a `<ClientID>` fault and is not one. |
| `BMI is Invalid for Member N` | Height/weight missing, zero, or in the wrong unit. cm and kg. |
| `Occupation is incorrect.` | `occupation` is one of FG's four-letter codes, not free text. |
| `PAN Number already exists for different client.` | A data collision on the shared UAT tenant, not an integration fault. Use a fresh PAN. |
| Payment callback always `unverified` | `FG_PG_CRYPTO_KEY` is truncated by an unquoted `#`. Quote it. Startup now refuses to boot on this. |
| `FG_PAYMENT_UNVERIFIED` | FG did not confirm the transaction, or confirmed a different amount. Either the payment failed or the callback was tampered with — do not issue manually without checking FG. |
| `issuanceState: unresolved` | FG never answered the issuance call. **A policy may exist.** Confirm with FG before forcing. |
| `PDF_NOT_READY` right after issuance | Expected for the first 15–25s. Poll `?meta=1`. |

---

## Testing

```bash
npm run smoke:fg              # config + quote + CKYC + payment form. Issues nothing.
npm run smoke:fg -- --proposal   # additionally runs HealthPreCRTValidate
```

Safe by default: the quote leg is a pure read, and the payment form is built but
never submitted. `--proposal` still issues nothing, but FG's client handshake
does create a client record, so it is opt-in. The script generates a unique PAN
per run, because UAT is a shared tenant and FG key a client record on the PAN.

---

## Files

```
src/config/env.js                  config.fg — the only place the environment is read
src/config/defaults.js             FG_DEFAULTS — contract paths only, no host or secret
src/config/validate.js             boot report, the production rail, the DES-key shape check
src/constants/fg.constants.js      SOAP ops, products, member shapes, CKYC paths, payment vocabulary
src/helpers/fg.helper.js           typed errors, SOAP envelope, response parsers
src/helpers/fgXml.helper.js        the <Root> payload builder — a transcription, not a design
src/helpers/fgPayment.helper.js    CheckSum, DES decryption, the callback parser
src/helpers/fgCodes.helper.js      local validation of FG's coded fields
src/services/fgApi.service.js      SOAP transport, quote / proposal / issuance, the client handshake
src/services/fgCkyc.service.js     GC-CKYC 3.0.0 and legacy NL-CKYC behind one interface
src/services/fgPayment.service.js  session, callback, at-most-once issuance, result store
src/services/fgReconcile.service.js  FetchTRNDetails — server-to-server payment revalidation
src/services/fgPdf.service.js      the policy document
src/controllers/fg.controller.js   the twelve handlers
src/routes/fg.routes.js            the route table
src/routes/index.js                createFgRouter() — CORS, body limits, journey context
scripts/smoke-fg.js                npm run smoke:fg
```
