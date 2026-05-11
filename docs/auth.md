# Authentication — Passkeys + Magic Links

## Decisions

- **WebAuthn / passkeys** as the primary credential. Library: `@simplewebauthn/server` + `@simplewebauthn/browser`.
- **JWT** in memory (or sessionStorage), short-lived (~1h). Payload is minimal: `{ userId, role }`. Permission details are re-read from the DB per request so role/permission changes take effect immediately. Refresh by silently re-running the passkey ceremony (one biometric tap).
- **Multiple passkeys per user** to support multi-device and self-serve recovery.
- **Magic-link email** for invites *and* recovery. Email is the trust root, same as a "forgot password" flow.
- **HTTPS tunnel** (Cloudflared) for dev/demo. The RP ID is pinned to one tunnel domain for the day — changing it invalidates registered credentials.

## Tables

```
users          (id, email, name, role, status, created_at)
                 role   ∈ { admin, employee }
                 status ∈ { pending, active, disabled }

credentials    (id, user_id, credential_id, public_key, counter,
                transports, label, created_at, last_used_at)

email_tokens   (id, user_id, token_hash, purpose, expires_at, consumed_at)
                 purpose ∈ { invite, recovery, add_device }
```

Notes:
- `email_tokens.token_hash` stores `sha256(raw_token)` — a DB leak does not grant logins.
- `credentials.counter` is bumped on each authentication; a regression indicates a cloned authenticator.

## Flows

### 1. First admin (one-time, via CLI)

```
$ npm run seed:admin -- --email=bram@example.com --name="Bram"
  → creates users row (role=admin, status=pending)
  → mints email_token (purpose=invite, 24h)
  → prints magic link to stdout (no SMTP wired at this stage)
```

Admin clicks the link → enrollment flow (#3) → registers a passkey → logged in.

### 2. Admin invites a user

```
Admin    →  POST /api/users { email, name, role, claimants }
Server   →  insert users row (status=pending)
         →  mint email_token (purpose=invite, 24h)
         →  send email: https://app/enroll?token=...
```

### 3. Enrollment (consumes invite / recovery / add-device token)

```
Browser  →  GET /enroll?token=...
Server   →  validate token (unconsumed, unexpired, lookup user)
         →  begin WebAuthn registration:
              { rpId, challenge, user:{id,email,name}, exclude:[...existing creds] }
Browser  →  navigator.credentials.create(...)
         →  POST /api/webauthn/register/finish { token, attestation }
Server   →  verify attestation
         →  insert credentials row
         →  mark email_token consumed
         →  set users.status=active (if first credential)
         →  issue JWT
```

### 4. Login

```
Browser  →  POST /api/webauthn/login/start { email }
            (or discoverable credential → omit email)
Server   →  return challenge + allowCredentials[] from user's credentials
Browser  →  navigator.credentials.get(...)
         →  POST /api/webauthn/login/finish { assertion }
Server   →  verify signature, bump credentials.counter
         →  issue JWT
```

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
            (always show "if the email is on file, we sent a link" — no enumeration)
         →  email https://app/enroll?token=...
User     →  follows enrollment flow (#3) → registers a NEW passkey
Server   →  on consume: keep existing credentials rows
            (deliberate — admin can audit "user added device on date X via recovery")
```

Trust root is email. For an in-house tool this is acceptable; if hardening is wanted later, recovery emails can be gated behind admin approval.

## Implementation gotchas

- **RP ID is baked into every credential.** Pin one tunnel domain for the day. Changing it = re-enrollment for everyone.
- **Counter regression** on a presented credential is a strong signal of cloning — reject the assertion and flag the credential.
- **Token URL**: query string is fine for a one-day build. Move to URL fragment (`#token=...`) if avoiding referrer/log leakage matters.
- **JWT storage**: in-memory or sessionStorage, not localStorage (XSS surface). HttpOnly cookie is a valid alternative but couples auth to cookies and complicates the SPA story.
