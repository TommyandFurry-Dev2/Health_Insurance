# Journey break / resume

Lets a buyer leave the NivaBupa (Reassure 3.0) purchase flow at any stage and
continue from exactly where they stopped — including after a server restart, a
browser close, or a switch to another device.

---

## 1. Scope notes (read first)

Two items in the original request do not map onto this codebase. Both decisions
are deliberate:

| Requested | What was built | Why |
|---|---|---|
| **Vehicle details** | *No vehicle table.* Insured **members** are modelled instead (`nivabupa_journey_quote_members`, `nivabupa_journey_proposal_members`). | Reassure 3.0 is a **health** product. Its risk data is `member[]` — DOB, gender, diabetes/hypertension PED tenure — and there is no vehicle field anywhere in the eight endpoints. A vehicle table would never receive a row. |
| **KYC status** | `nivabupa_journey_kyc` created, plus `PUT /nivabupa/journey/:id/kyc`. **Not** wired to any NivaBupa API. | The current NivaBupa API kit contains no KYC endpoint. The table persists whichever provider gets wired in later, so a buyer who breaks *after* verifying is not sent through KYC twice. |

Also note the database is **shared**: `policy_db` already contains ~80 tables
belonging to a Laravel motor-insurance application. Every table added here is
prefixed `nivabupa_` for that reason — see §3.

---

## 2. The problem this actually solves

Before this change the service owned no database. The consequence that mattered
most was at **payment**.

NivaBupa's gateway POSTs `/nivabupa/payment/return` **from its own servers**,
carrying nothing but an encrypted `returnMessage`. No cookie, no session, no
journey id. So:

- Nothing linked a payment outcome back to the buyer who started it.
- A buyer who closed their browser during the gateway round-trip was
  unrecoverable — after money had already moved.

The fix is `nivabupa_journey_payments.unq_policy_number`: **we** generate that
reference at `payment/initiate` and store it; the callback echoes it back as
`uniqueReferenceId`. That single indexed column is the only bridge from a
payment outcome to a journey, and it is why this feature needs a database rather
than a session store.

---

## 3. Schema

11 tables. Run `npm run migrate`, inspect with `npm run migrate:verify`.

```
users  (EXISTING Laravel table — not created here)
  └─ nivabupa_journeys ................ the resume spine: current_step,
       │                                last_completed_step, resume_token, status, expiry
       ├─ nivabupa_journey_quotes ..... one row per /nivabupa/premium call (many per journey)
       │    └─ nivabupa_journey_quote_members ..... member[] normalised out
       ├─ nivabupa_journey_proposals .. proposer + policy + nominee, uwDecision, datapush
       │    └─ nivabupa_journey_proposal_members .. MEMBER[] with PII + medical
       ├─ nivabupa_journey_kyc ........ 1:1, KYC outcome
       ├─ nivabupa_journey_payments ... 1 row per attempt; unq_policy_number = callback key
       ├─ nivabupa_journey_policies ... 1:1, proposal-status + policy PDF
       ├─ nivabupa_api_transactions ... every upstream call (journey_id NULLable)
       └─ nivabupa_journey_events ..... step trail + non-API errors
nivabupa_schema_migrations ............ migration bookkeeping
```

### Why the `nivabupa_` prefix

`policy_db` is shared with a Laravel app. Unprefixed names collide, and
**the failure is silent**: `CREATE TABLE IF NOT EXISTS` skips a name that
already exists, so a table called `users` or `api_transactions` looks created
while the code queries columns that were never added. The prefix makes
ownership unambiguous.

### Why `users` is the exception

Journeys attach to the host app's existing `users` table so a buyer is one
person across both applications. That table is Laravel auth
(`name`/`email`/`password` all `NOT NULL`, no `mobile`), so:

- **Migration 002** adds `mobile VARCHAR(15) NULL UNIQUE` — additive, nullable,
  isolated in its own file because it touches a table this service does not own.
- `user.repository.js` supplies `name` and a deliberately **unusable password**
  (`!nivabupa-journey-no-login!…`) when creating a buyer row. No password can
  ever match a non-hash string, so a journey buyer cannot be logged in as.
- Lookup order is **mobile, then email** — email is `UNIQUE`, so an existing
  host-app account with the same address is reused rather than collided with.
- `fk_nb_journeys_user` is `ON DELETE RESTRICT`: deleting a user must not
  silently destroy issued-policy history.

### Design decisions worth knowing

- **`selected_quote_id` on `nivabupa_journeys`**, not an `is_selected` flag on
  the quote. One FK column enforces "exactly one selected quote" structurally;
  MySQL has no partial unique index, so a boolean would need app logic.
- **`last_completed_step` never moves backwards** (`isStepAfter` guard).
  Otherwise a buyer navigating back to the quote screen after submitting a
  proposal would lose it on the next resume.
- **Typed columns *and* raw JSON** on quotes/proposals. Not duplication: these
  are documented pass-throughs, so callers may legitimately send Data-Dictionary
  fields the schema does not model. Typed columns drive restore; JSON keeps the
  call replayable.
- **Two DOB columns** (`date_of_birth_raw` + `date_of_birth`). NivaBupa's
  `06/Aug/1998` format is contractual for byte-identical replay; the parsed DATE
  is for age maths.
- **No `error_logs` table.** API failures already carry full detail on
  `nivabupa_api_transactions`; non-API failures (validation, missing
  `returnMessage`, decrypt parse errors) go to `nivabupa_journey_events` with
  `event_type='ERROR'`. A third table would duplicate both.
- **Append-only tables have `created_at` only** — no `updated_at`, no
  `deleted_at`. An audit row that can be edited or hidden is not an audit row.
- **Soft delete** (`deleted_at`) on `nivabupa_journeys`, `_quotes`,
  `_proposals`, `_kyc`, `_payments`, `_policies`. Child member rows cascade with
  their parent instead — soft-deleting one independently has no meaning.

---

## 4. Backwards compatibility

**No existing endpoint changed shape.** All eight NivaBupa routes still accept
the same bodies and return the same fields; journey fields are *added* only when
a journey is in context. An already-deployed frontend keeps working untouched.

Journey identity is passed by **header** (preferred) or body:

```
X-Journey-Id:   <journey uuid>
X-Resume-Token: <64-hex token>
```

`journeyContext` middleware **deletes** `journeyId`/`resumeToken` from `req.body`
before the pass-through controllers forward it — otherwise those undocumented
fields would reach the Reassure 3.0 payloads. Headers avoid the issue entirely.

---

## 5. Endpoints

Existing eight unchanged. New (also served under the `/health` prefix):

| Method | Path | Purpose |
|---|---|---|
| POST | `/nivabupa/journey` | Start. `{ mobile }` required. Returns `journeyId` + `resumeToken`. |
| POST | `/nivabupa/journey/resume` | Resume by token → full snapshot. |
| POST | `/nivabupa/journey/resume-by-mobile` | **Restore on login.** Lists resumable journeys for a mobile, each with its token. Works from a new device. |
| GET | `/nivabupa/journey/:id` | Full restore snapshot. |
| PATCH | `/nivabupa/journey/:id/step` | Form autosave. `stepData` is **merged**, not replaced. |
| POST | `/nivabupa/journey/:id/select-quote` | Record chosen quote/insurer; opens the proposal. |
| PUT | `/nivabupa/journey/:id/proposal` | Autosave proposer / members / nominee. |
| PUT | `/nivabupa/journey/:id/kyc` | Record KYC outcome. |
| GET | `/nivabupa/journey/:id/policy-document` | Serve the stored PDF without calling NivaBupa. |
| GET | `/nivabupa/journey/:id/timeline` | Step trail + API call log (support-facing). |
| POST | `/nivabupa/journey/:id/abandon` | Mark abandoned (still resumable). |
| GET | `/readyz` | Readiness **including** MySQL; 503 when persistence is down. |

`/healthz` deliberately does **not** check MySQL — an orchestrator must not
restart a healthy process because the database blipped.

---

## 6. Automatic save points

Every upstream call writes its typed row, its audit row, and its step advance in
**one transaction**, so a crash cannot leave a journey pointing at a step whose
data is half-written.

| Trigger | Written |
|---|---|
| `POST /nivabupa/premium` | quote + members + audit → step `QUOTE_GENERATED` |
| `POST /nivabupa/uw-decision` | `uw_*` on proposal → step `UW_DECISION` |
| `POST /nivabupa/datapush` | `datapush_*` + `application_number` + policy row → `PROPOSAL_SUBMITTED` |
| `POST /nivabupa/payment/initiate` | payment attempt incl. `unq_policy_number` → `PAYMENT_INITIATED` |
| `POST /nivabupa/payment/return` | correlates by `unq_policy_number`, writes outcome → `PAYMENT_COMPLETED` |
| `POST /nivabupa/proposal-status` | `pre_issuance_*` → `POLICY_ISSUED` |
| `POST /nivabupa/policy-download` | policy PDF → `POLICY_DOWNLOADED`, journey `COMPLETED`, token rotated |
| `GET /nivabupa/token/test` | audit row with `journey_id NULL` |

**Failures are persisted too** — a `FAILED` quote row, a `FAILED` audit row with
the HTTP status, and a `STEP_FAILED` event. The journey does **not** advance on
failure, so a resume never lands on a screen with nothing on it.

### Persistence never breaks the integration

Every save from the pass-through controllers goes through `safeSave()`: failures
are logged with full context and the request continues. If MySQL is down the
NivaBupa endpoints keep serving and only persistence degrades. Verified:

```
/healthz                 → 200   (liveness unaffected)
/readyz                  → 503   DEGRADED
/nivabupa/token/test     → 200   pass-through still works
POST /nivabupa/journey   → 500   fails cleanly, does not hang
```

---

## 7. Two things that also improved

**Resume-aware payment redirect.** `/nivabupa/payment/return` now appends
`journeyId` + `resumeToken` to the frontend redirect (original query params
unchanged), so a buyer whose browser lost its storage during the gateway
round-trip still lands in a restored app.

**Self-healing case-API calls.** `proposal-status` fills in `ApplicationNumber`
and `MobileNumber` from the stored proposal when omitted, and `policy-download`
falls back to the stored policy number and serves an already-downloaded PDF from
MySQL. The application number is returned by data push exactly once — before
this it was lost on a break.

---

## 8. Verification

```bash
npm run migrate            # apply
npm run migrate:status     # what's applied
npm run migrate:verify     # tables / FKs / index counts
npm run smoke:journey      # 28 assertions, live UAT premium call
npm run smoke:payment      # 20 assertions, callback correlation
```

Results on MariaDB 10.4.32 / Node 22:

- `migrate:verify` → 11 tables, **16 foreign keys**
- `smoke:journey` → **28 passed, 0 failed**
- `smoke:payment` → **20 passed, 0 failed**

### Restart proof (requirement 15)

```bash
npm run smoke:journey                       # prints a resume token
#  … kill the server, start it again …
npm run smoke:journey -- --resume <token>
```

Observed against a **brand-new process**:

```
✅ resume succeeds after restart
   step=KYC_COMPLETED route=/proposal/review resumeCount=2
✅ quotes restored   ✅ proposal restored   ✅ kyc restored   ✅ selected quote restored
```

No journey state lives in process memory. The only in-memory state in this
service is the NivaBupa auth-token cache, which is disposable by design.

### Confirmed against real UAT data

Premium extraction is validated against a live response. NivaBupa prices **every**
payment frequency in one response, so a naive key search stores the wrong number:

```
paymentFrequency=A -> total=6865  base=7342  discount=1211   ← requested
paymentFrequency=H -> total=3481  base=3723  discount=614
paymentFrequency=Q -> total=1750  base=1872  discount=309
paymentFrequency=M -> total=590   base=631   discount=104
```

The extractor matches the frequency to the request's own `paymentFrequency` and
the tenure to `policyTerm`. Note `base` (7342) exceeds `total` (6865) because
adjustments net negative: `7342 + 734 zonal − 1211 vintage = 6865`. Storing base
as payable would overstate the price by 7%.

### Secrets are not persisted

`utils/sanitize.js` redacts credentials and truncates base64 blobs before any
audit write. Verified: **0 rows** in `nivabupa_api_transactions` contain a raw
secret; the token-test row stores `{"token_preview":"***REDACTED***"}`.

---

## 9. Housekeeping

An in-process sweeper (`server.js`, hourly by default) ages idle journeys to
`ABANDONED` — still resumable, since that *is* the journey-break population and
marking it makes the funnel measurable — and past-expiry ones to `EXPIRED`.

```
JOURNEY_TTL_DAYS=7                 # resume window; also refreshed on each resume
JOURNEY_ABANDON_AFTER_HOURS=48
JOURNEY_SWEEP_INTERVAL_MINUTES=60
```

The 7-day default is deliberate: a quote's premium is only valid for the
`premiumCalculationDate` sent upstream, so a months-old journey must not resume
at a price NivaBupa would no longer honour.

`SIGTERM`/`SIGINT` drain the pool before exit, so a transaction is never killed
mid-commit.

---

## 10. Test data left behind

The smoke runs created real rows, including in the shared `users` table
(mobiles `98765000xx`, `9876500777`). To remove them:

```sql
DELETE FROM nivabupa_journeys WHERE user_id IN (SELECT id FROM users WHERE mobile LIKE '987650%');
DELETE FROM users WHERE mobile LIKE '987650%' AND email LIKE '%@example.com';
```

Journey children cascade. `nivabupa_api_transactions` rows survive by design
(`ON DELETE SET NULL`) — delete them explicitly if you want a clean audit table.
