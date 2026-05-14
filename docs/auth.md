# Authentication — Passkeys + Magic Links

## Decisions

- **WebAuthn / passkeys** as the primary credential. Library: `@simplewebauthn/server` + `@simplewebauthn/browser`.
- **JWT** in memory (or sessionStorage), short-lived (~1h). Payload is minimal: `{ uid, role, iss: 'sred', sub: <user-id> }`. Permission details are re-read from the DB per request so role/permission changes take effect immediately.
- **Rotating refresh tokens.** A long-lived refresh token (default 30 days) sits in `localStorage` so closing and reopening the browser yields a "warm start" without a passkey ceremony. Every use of the refresh token rotates it; replay of an already-used token revokes the whole family (see §"Refresh-token rotation").
- **Multiple passkeys per user** to support multi-device and self-serve recovery.
- **Magic-link email** for invites *and* recovery. Email is the trust root, same as a "forgot password" flow.
- **HTTPS tunnel** (Cloudflared) for dev/demo. The RP ID is pinned to one domain. `ORIGIN` may be a comma-separated list to cover multi-tunnel previews (see §"Multi-origin support"); RP ID remains single.
- **JWT secret strength enforced at boot.** `JWT_SECRET` shorter than 32 chars, or matching a banned-weak set (`change-me`, `changeme`, `secret`, `dev`, `password`), aborts startup with a generation hint. See `src/config.js`.

## Tables

```
users                role   ∈ { admin, manager, employee }
                     status ∈ { pending, active, disabled }

credentials          (id, user_id, credential_id, public_key, counter,
                      transports, label, created_at, last_used_at)

email_tokens         (id, user_id, token_hash, purpose, expires_at, consumed_at)
                       purpose ∈ { invite, recovery, add_device }

webauthn_challenges  (id, user_id, challenge, kind, context, expires_at, consumed_at)
                       kind ∈ { register, login }
                       5-minute TTL; opportunistically reaped on every insert

refresh_tokens       (id, user_id, token_hash, expires_at, created_at, revoked_at)
                       sha256-hashed; rotated on consume; revoked_at marks
                       both intentional rotation and family-revocation on replay
```

Notes:
- `email_tokens.token_hash` and `refresh_tokens.token_hash` both store `sha256(raw_token)` — a DB leak does not grant logins.
- `credentials.counter` is bumped on each authentication; regression raises `unauthorized('counter regression — possible cloned authenticator')` and the assertion is rejected. (There is no separate "flagged" persistence today.)
- `webauthn_challenges` enforces a 5-minute TTL and clears expired rows on every insert (V-09 — bounds growth under churn).
- The `findValidEmailToken(rawToken, expectedPurpose)` helper requires the caller to pass the purposes it expects to accept; a purpose mismatch is surfaced with the same `'invalid token'` shape as an unknown token (no enumeration via error message).

## Flows

### 1. First admin (one-time, via CLI)

```
$ npm run seed:admin -- --email=bram@example.com --name="Bram"
  → creates users row (role=admin, status=pending)
  → mints email_token (purpose=invite, 24h)
  → calls sendMagicLink — when SMTP_HOST is set it emails the link;
    when SMTP is disabled the link is logged to stderr so a local
    operator can complete enrollment
```

Admin clicks the link → enrollment flow (#3) → registers a passkey → logged in.

### 2. Admin invites a user

```
Admin    →  POST /api/users { email, name, role, attachments: [...] }
            (creates users row, status=pending; no email sent at this step)
Admin    →  POST /api/users/:id/invite
            (rate-limited; mints email_token (purpose=invite, 24h);
             sends email — the raw link is NOT in the API response,
             only `{ user_id, purpose, expires_at, delivered }`)
```

### 3. Enrollment (consumes invite / recovery / add-device token)

```
Browser  →  GET /enroll?token=...
Server   →  validate token (unconsumed, unexpired, lookup user;
            findValidEmailToken checks the token's purpose is one of the
            three magic-link purposes)
         →  begin WebAuthn registration:
              { rpId, challenge, user:{id,email,name}, exclude:[...existing creds] }
Browser  →  navigator.credentials.create(...)
         →  POST /api/webauthn/register/finish { token, attestation, label? }
Server   →  verify attestation (expectedOrigin = config.origins[]; expectedRPID = config.rpId)
         →  insert credentials row
         →  mark email_token consumed (consumeEmailToken returns 0 if the
            row was already consumed — the server then refuses to activate
            the user rather than silently no-op'ing)
         →  set users.status=active (if first credential)
         →  issue JWT + refresh token
```

### 4. Login

```
Browser  →  POST /api/webauthn/login/start { email }
            (or discoverable credential → omit email)
Server   →  return challenge + allowCredentials[] from user's credentials
Browser  →  navigator.credentials.get(...)
         →  POST /api/webauthn/login/finish { assertion }
Server   →  verify signature, check counter, bump credentials.counter
         →  issue JWT + refresh token  (response: { user, token, refresh_token, refresh_expires_at })
```

### 4.5 Refresh-token rotation (V-03)

```
Browser  →  POST /api/auth/refresh { refresh_token }
Server   →  sha256 lookup → refresh_tokens row
            ├─ not found              → 401 invalid refresh token
            ├─ row.revoked_at != NULL → REPLAY: in one transaction
            │                            UPDATE refresh_tokens
            │                              SET revoked_at = now
            │                              WHERE user_id = ? AND revoked_at IS NULL
            │                            audit('refresh_replay_detected', ...)
            │                            → 401 refresh token already used
            ├─ expired or user inactive → 401 invalid refresh token
            └─ OK                     → mark row revoked, mint a new row,
                                        return { token, refresh_token, refresh_expires_at }
```

Replay handling forces both the legitimate user and the attacker to re-authenticate, and writes an `audit_log` row. The "expired" and "user inactive" branches surface the same error string as "not found" so the error message does not leak which case applied. The endpoint is rate-limited (30/min/IP) so the random-32 token space cannot be brute-forced online.

### 5. Add another passkey (recovery prep, while logged in)

```
User     →  Settings → "Add a passkey"
Browser  →  POST /api/webauthn/register/start (auth required)
Server   →  begin registration with exclude=[...existing creds]
         →  ...same finish as #3, no token involved
```

Prompt new users to do this on first login. "Add a second passkey on your phone so you don't get locked out."

### 6. Recovery (lost all passkeys)

```
User     →  Login page → "Can't sign in?" → enter email
Server   →  if user exists & active → mint email_token (purpose=recovery, 15min)
            (always show "if the email is on file, we sent a link" — no enumeration;
             rate-limited per-IP both per-minute and per-hour)
         →  email https://app/enroll?token=...
User     →  follows enrollment flow (#3) → registers a NEW passkey
Server   →  on consume: keep existing credentials rows
            (deliberate — admin can audit "user added device on date X via recovery")
```

Trust root is email. For an in-house tool this is acceptable; if hardening is wanted later, recovery emails can be gated behind admin approval.

## Cross-cutting hardening

### Rate limiting (V-04)

Per-IP limiters live in `src/lib/rate-limit.js` and respond with `429 { error: { code: 'rate_limited', ... } }`:

| Limiter                 | Endpoints                                                            | Window |
| ----------------------- | -------------------------------------------------------------------- | ------ |
| `webauthnLimiter`       | `/api/webauthn/register/start`, `/register/finish`, `/login/start`, `/login/finish` | 10 / min |
| `recoveryShortLimiter`  | `/api/recovery` (layered)                                            | 5 / min  |
| `recoveryHourLimiter`   | `/api/recovery` (layered)                                            | 30 / hr  |
| `refreshLimiter`        | `/api/auth/refresh`                                                  | 30 / min |
| `inviteLimiter`         | `/api/users/:id/invite`                                              | 30 / hr  |

The two recovery limiters are stacked: a request must clear both windows.

### Multi-origin support (V-07)

`ORIGIN` is parsed as a comma-separated list (`src/config.js → origins()`) and frozen at boot. The list is passed to `verifyRegistrationResponse` / `verifyAuthenticationResponse` as `expectedOrigin`, so a multi-tunnel deploy can serve `https://a.trycloudflare.com,https://b.trycloudflare.com` without re-enrolling credentials. RP ID is still single.

Each entry is parsed as a URL. In `NODE_ENV=production` every entry must use `https:`; in non-production, `http://localhost*` (and `127.0.0.1`) are permitted, every other entry must still be `https:`. A malformed entry, or `http:` in production, aborts boot.

The first entry of `config.origins` is the canonical outbound origin used by `buildMagicLink` and stderr log lines.

### JWT secret enforcement (V-02)

`JWT_SECRET` is validated at boot:
- presence required;
- length `>= 32`;
- not one of the banned-weak set (`change-me`, `changeme`, `secret`, `dev`, `password`, case-insensitive).

The error message hints `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` for an acceptable value.

### Append-only audit log (V-08)

`audit_log` rows are guarded by `audit_log_no_update` and `audit_log_no_delete` BEFORE triggers (migration 008). The refresh-replay handler relies on this: it bundles the family-revoke UPDATE and the `audit_log` INSERT into a single transaction, and the trigger ensures the audit row cannot be deleted out from under the revocation later.

## Implementation gotchas

- **RP ID is baked into every credential.** Pin one domain. Changing `RP_ID` = re-enrollment for everyone. (`ORIGIN` is more forgiving — see V-07 above.)
- **Counter regression** on a presented credential is a strong signal of cloning — the assertion is rejected; no extra credential-flag persistence today.
- **Token URL**: query string is fine for a one-day build. Move to URL fragment (`#token=...`) if avoiding referrer/log leakage matters.
- **JWT storage**: in-memory or sessionStorage, not localStorage (XSS surface). HttpOnly cookie is a valid alternative but couples auth to cookies and complicates the SPA story.
- **Refresh-token storage**: in `localStorage`, by design — it's what lets a browser restart skip the passkey ceremony. The blast-radius mitigation is rotation + replay detection + per-IP rate limiting, not storage protection. (Tracked as a known accepted risk.)
- **Magic-link purpose check**: `findValidEmailToken(rawToken, expectedPurpose)` requires the caller to specify which purposes it accepts. All three magic-link entry points (initial invite, recovery, add-device) pass `['invite', 'recovery', 'add_device']`; routes that should accept only one purpose pass that single value. A purpose mismatch surfaces as `unauthorized('invalid token')` — same message as an unknown token, so error timing/text doesn't leak.
