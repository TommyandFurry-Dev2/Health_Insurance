# Health purchase store

Every health purchase saved to the database: one Purchase ID tying the common
`health_*` tables to each insurer's own `health_<insurer>_*` tables, with
personal data encrypted. Tables: `migrations/008`–`014`. Code:
`src/services/healthPurchase.service.js` (the write path every insurer uses) and
one adapter per insurer.

| Insurer | Status |
|---|---|
| ICICI Lombard | Saved (`src/services/iciciPurchaseStore.service.js`) |
| Niva Bupa, Future Generali, Chola MS, IFFCO Tokio, Galaxy Health | Tables exist; write paths not built yet |

## What is saved for ICICI Lombard

| ICICI call | Saved |
|---|---|
| Quote | Log row only (no purchase yet) |
| CKYC / OVD | `health_icici_kyc` attempt; creates the purchase; the verified PAN becomes the customer |
| Proposal | `health_icici_proposals`, proposer (`health_customers`), insured members, nominee and appointee (`health_purchase_members`), and the payment attempt (`health_payments` + `health_icici_payments`) once ICICI return a PaymentUrl |
| Policy status | ICICI's payment verdict (Paid → SUCCESS, verified via STATUS_API) and the policy (ACTIVE + PolicyNo → ISSUED, with dates). ICICI's hosted gateway sends the buyer straight back to the website, so this call is how the backend learns the payment outcome. An unchanged answer is counted, not logged again |
| Certificate (COI) | The PDF, encrypted, in `health_policy_documents`, linked to the policy |
| EMI, zone | Log row only |

Every call also writes a `health_icici_api_logs` row: a masked copy of the
request and response, plus the exact bytes encrypted. CKYC and OVD logs keep
only the described request (ID type and proof types), never a PAN, Aadhaar
number or document. The response body the SPA receives is unchanged. When the
call belongs to a purchase, the response carries `X-Purchase-Id`.

The existing `nivabupa_api_transactions` audit row is still written for every
ICICI call. It stops once the store is proven on the server.

## Turning it on

The store is off until both keys are set. While off, nothing is written and
every insurer flow behaves exactly as before.

1. Apply the migrations: `npm run migrate` (008–014 must be applied).
2. Generate two keys, once per environment:
   ```
   node -e "console.log('1:' + require('crypto').randomBytes(32).toString('base64'))"
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
3. Put them in the server's `.env`:
   ```
   HEALTH_DATA_ENC_KEYS=<the first command's output, e.g. 1:Qm9…>
   HEALTH_DATA_HASH_KEY=<the second command's output>
   ```
4. **Back both keys up somewhere other than this server.** Without them the
   encrypted columns cannot be read by anyone.
5. Restart. The boot banner says `🗂️ Purchase store: ON (key version 1)`, or
   `OFF —` followed by the reason (keys not set, MySQL not connected, tables
   missing).

## Checking that it saves

```sql
-- The latest purchases, any insurer
SELECT purchase_ref, insurer_code, insurer_env, status, payment_status, policy_status,
       proposal_number, policy_number, final_premium, needs_review, created_at
FROM health_purchases ORDER BY id DESC LIMIT 20;

-- One purchase's history
SELECT created_at, entity, event_type, from_status, to_status, source, message
FROM health_purchase_events
WHERE purchase_id = (SELECT id FROM health_purchases WHERE purchase_ref = '<Purchase ID>')
ORDER BY id;

-- Paid but not issued, any insurer
SELECT p.purchase_ref, p.insurer_code, pay.gateway_txn_id, pay.completed_at
FROM health_purchases p JOIN health_payments pay ON pay.purchase_id = p.id AND pay.status = 'SUCCESS'
WHERE p.policy_status <> 'ISSUED';

-- Anything flagged for a person to look at
SELECT purchase_ref, insurer_code, review_reason FROM health_purchases WHERE needs_review = 1;
```

## How it behaves

- **Never blocks a sale.** A store failure is logged
  (`⚠️ Purchase store [...] not saved: …`) and the insurer call answers as
  normal. A response waits for the store at most `HEALTH_STORE_WAIT_MS`
  (default 1500 ms); after that it goes out without `X-Purchase-Id` and the
  write finishes in the background.
- **One purchase per insurer reference.** Each step takes a MySQL named lock on
  ICICI's TransactionId, so two simultaneous first calls cannot create two
  purchases. An `X-Purchase-Id` that names a purchase with a different
  TransactionId is ignored.
- **Statuses only move forward.** A late answer that is behind the stored state
  is ignored. A contradiction, such as a "Failed" after a "Paid", is never
  applied: it is recorded as a `CONFLICT` event and the purchase gets
  `needs_review = 1`.
- **Production and UAT are kept apart.** `insurer_env` comes from the ICICI
  environment the call ran in (`X-App-Env`).

## Keys

- `HEALTH_DATA_ENC_KEYS`: AES-256-GCM keys as `version:base64`. The highest
  version encrypts; every listed version decrypts. To rotate, append
  `,2:<new key>` and keep `1:` so older rows stay readable.
- `HEALTH_DATA_HASH_KEY`: the HMAC key for the PAN / mobile / email lookup
  hashes. It must differ from the encryption keys. Changing it breaks lookups
  of existing customers, so treat it as permanent.

## Tests

`npm run test:purchase-store` runs the ICICI routes against a mock ICICI
gateway and a **local** database with 008–014 applied. It refuses any database
host other than 127.0.0.1 or localhost, and deletes every row it created.
`npm run test:icici` keeps passing whether the store is on or off.

## Not done yet

- Niva Bupa, Future Generali, Chola MS, IFFCO Tokio and Galaxy write paths.
- Copying historical rows into the new tables (the recovery scripts).
- A retention job that purges `request_enc` / `response_enc` after the agreed
  period.
- Frontends sending `X-Purchase-Id` back. Not required: ICICI purchases are
  found by TransactionId.
