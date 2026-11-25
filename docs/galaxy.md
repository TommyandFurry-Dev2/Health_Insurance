# Galaxy Health Insurance (GHI) — Marvel, CBOS-GX V2

Moved here on 25 Nov 2026 from `novacred-insurance-integrations` (port 4002), which was never deployed. The encryption, key store, key rotation and scheduler logic moved unchanged; only the module syntax, the routes and the configuration files changed. The `GX_*` variable names are the same, so the old `.env` block copies across.

## Routes

Every route is also served under the `/health` alias (`/health/galaxy-health/...`).

| Route | GHI operation | Notes |
|---|---|---|
| `GET /galaxy-health/config/test` | — | Configured? Today's GHI key fetched? Names, host, dates and counts only. 503 until both hold. |
| `POST /galaxy-health/quickQuote` (`/quote`) | quickQuote | productCode defaults to `GXGLXYMRVL`; `GX_PRODUCER_CODE` fills `basicDetails.producerCode` when empty. |
| `POST /galaxy-health/saveFullProposal` (`/proposal`) | saveFullProposal | Creates a DRAFT proposal. The SPA sends productCode `GALMARVEL` (GHI UAT rejects `GXGLXYMRVL` here). |
| `POST /galaxy-health/createOrder` (`/issue`) | createOrder | Returns GHI's payment page (`returnUrl`) and `orderId`. txnAmount in paise. |
| `POST /galaxy-health/{upload,download,search}Document` | utils | Bodies passed through. |
| `POST /galaxy-health/ops/getCurrentPubKey` | getCurrentPubKey | `X-Ops-Key: <GX_OPS_KEY>`. One of GHI's 3 a day. Off (503) while `GX_OPS_KEY` is unset. |
| `POST /galaxy-health/ops/getNextPubKey`, `/ops/rotateKeys` | — | Same guard. |

Envelope (unchanged from port 4002, read by the SPA's `services/health/galaxy`):

- success `{ ok: true, provider: 'galaxy', operation, data, meta: { requestUID, statusCode, statusDescription } }`
- failure `{ ok: false, error: { code, message, provider, details } }`. 400 VALIDATION_ERROR, 401 UNAUTHORIZED (ops key), 503 CONFIG_ERROR (not configured, today's key missing, 3 fetches used), 502 UPSTREAM_ERROR / PARSE_ERROR, 504 TIMEOUT_ERROR, 500 CRYPTO_ERROR. For a GHI refusal, `details` carries GHI's `statusCode`, `statusDescription`, `requestUID` and, when GHI encrypted one, its decrypted answer `ghiResponse`, masked.

`meta.requestUID` is the id GHI support asks for. GHI's UAT success bodies carry none, so the one we sent is used.

## Payment result (after createOrder)

GHI asked (Ragul D, 25 Nov 2026) for our redirect URL, callback URL and token API. All three are this service's routes, reached through `/health` on the deployed host:

| What GHI configure | URL | Notes |
|---|---|---|
| Redirect (buyer's browser) | `https://healthinsurance.tommyandfurry.com/health/galaxy-health/payment/return` | GET or POST. 303 to the order's `/galaxy-return` page with `?ref=<orderId>` (or `GX_PAYMENT_FRONTEND_RETURN_URL`). |
| Callback (server to server) | `https://healthinsurance.tommyandfurry.com/health/galaxy-health/payment/callback` | `Authorization: Bearer <token>`; answers 200 `{"status":"SUCCESS"}`, 401 without a valid token. |
| Token API | `POST https://healthinsurance.tommyandfurry.com/health/galaxy-health/payment/token` | `{clientId, clientSecret}` (or Basic, or OAuth2 form) → `{access_token, token_type:"Bearer", expires_in:3600}`. We issue the credentials: `GX_PAYMENT_CLIENT_ID` / `GX_PAYMENT_CLIENT_SECRET`. |

- The SPA sends `frontendReturnUrl` (its `/galaxy-return` page) with createOrder. It's checked against the allowed origins, kept with the order in `data/galaxy-payments/orders` (git-ignored) and never sent to GHI.
- GHI haven't documented the result's parameter names, method or encryption, so every redirect and callback is **captured as received** in `data/galaxy-payments/captures`. Credential values aren't kept; only the last 500 captures are. Each one is opened with three schemes in turn:
  1. GHI's API envelope (`encryptedData` + `apiKey` wrapped with our public key + `checkSum`);
  2. a static AES key, if GHI issue one (`GX_PAYMENT_AES_KEY`);
  3. plain fields.
- A status is applied only when the result was decrypted or arrived on the token-authenticated callback. A redirect's plain fields only route the buyer, and CHARGED is never overwritten.
- **Bodies are read raw.** On the callback and redirect, every body is read as raw bytes first, so it is captured byte for byte before anything is decided about it. It is then decoded by its declared Content-Type: `application/json`, `application/x-www-form-urlencoded` or `text/*`.
- **The callback answers:**

  | Case | Answer | Stored? |
  |---|---|---|
  | Authenticated, readable body | 200 `{"status":"SUCCESS","message":"Received"}` | yes |
  | No valid Bearer token | 401 `UNAUTHORIZED` | yes |
  | No body and no query | 400 `EMPTY_PAYLOAD` | yes |
  | Declared JSON but invalid | 400 `MALFORMED_JSON` | yes |
  | Any other Content-Type, or none | 415 `UNSUPPORTED_CONTENT_TYPE` | yes |
  | Over `GX_JSON_BODY_LIMIT` | 413 `PAYLOAD_TOO_LARGE` | no |
  | Body cut off | 400 `BODY_NOT_READ` | no |
  | Capture could not be written | 500 `NOT_STORED` | no |

  Errors are `{ok:false, error:{code, message, details:{stored, reference}}}`. A 200 means stored and readable, not that the status was applied: that needs GHI's format, and an unmatched result is logged as a warning.
- **The redirect never refuses.** Any body sends the buyer on (303). With no `/galaxy-return` page known, the buyer gets a neutral page that claims no payment outcome. That happens when the order wasn't matched and `GX_PAYMENT_FRONTEND_RETURN_URL` is unset, or isn't an allowed origin's `/galaxy-return` page.
- `GET /galaxy-health/payment/status/:orderId` is what `/galaxy-return` reads: CREATED until GHI's result arrives, then CHARGED / PENDING_VBV / AUTHENTICATION_FAILED / AUTHORIZATION_FAILED.
- Once GHI confirm the format, read a real capture and tighten `openResult` in `services/galaxyPayment.service.js` to that one scheme.

## The daily key (read before running anything)

- GHI issues a new public key every IST day (05:00 UAT, 00:00 production). It may be fetched from 05:05 / 00:05, at most **3 times a day**. Business calls are refused (503) until today's key is in the store.
- Every `getCurrentPubKey` also registers a **new NovaCred key with GHI**, which breaks every other key store. So: **one key store and one scheduler per GHI environment**. Never run two processes with `GX_KEY_SCHEDULER=true` against the same GHI environment, and never copy a store and then fetch from both.
- The store is `GX_KEY_STORE_DIR` (default `./data/galaxy-keys`, git-ignored). It holds NovaCred's RSA **private** keys: keep it on disk a deploy does not overwrite, and back it up like a secret.
- `GX_KEY_SCHEDULER=true` fetches at `GX_KEY_REFRESH_AT` (IST) each day, and at start-up when today's key is missing and that time has passed. Transient failures (timeout, network, 5xx) are retried every `GX_KEY_RETRY_MINUTES` while fetches last. The counter survives restarts.

## Local and deployed ownership

On 25 Nov 2026 the GHI UAT key store was copied from port 4002 (`certs/galaxy`) into this service's `data/galaxy-keys`. Port 4002 was stopped and its `GX_KEY_SCHEDULER` set to `false`. From then on, this service (on the machine that has the store) owns the GHI UAT keys.

Moving ownership to the deployed server means copying `data/galaxy-keys` and the `GX_*` block there, turning the scheduler on there and off everywhere else. Do it right after a successful fetch, not around 05:05 IST.

## GHI's data dictionary

`src/constants/galaxy/GALMARVEL_Data_Dictionary.json` is GHI's `GALMARVEL_Data_Dictionary.ods` (sheet `DATA_GXGLXYMRVL`) transcribed verbatim, with the .ods sha256 recorded. `helpers/galaxyDictionary.helper.js` indexes it. Before each quickQuote, `checkQuickQuote` logs:

- the mandatory fields that are empty, including `deductibleOptions` / `deductiblePerClaim`, which the spec marks optional but GHI UAT needs;
- the codes the dictionary does not list.

It is information only: nothing is refused on it.

## Tests

`npm run test:galaxy` runs offline against a mock GHI gateway that speaks the real wire format (RSA-OAEP-SHA256 key wrap, AES-256-GCM with a 32-byte IV, SHA-256 checkSum). No request leaves the machine. `npm run verify` checks that the routes are registered.

## Open with GHI

1. Confirm `GALMARVEL` as saveFullProposal's product code.
2. Our own branch and fulfiller codes. UAT accepts GHI's samples, 33501 / TRICHY3 / GHI00567.
3. The benefits-list size limit.
4. Member-level premium 4,785 against policy-level 4,055.
5. Our payment redirect URL and how to decrypt its fields. Until then the SPA cannot confirm a payment.
6. How we get the policy number after `CHARGED`.
