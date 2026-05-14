# Dependency / license review

_2026-05-14, against branch `worktree-agent-a45aa42489932ce69`, commit `d533fc3`_

## Summary

- **Direct dependencies**: 11 (no `devDependencies` declared)
- **Resolved tree** (`npm ls --all`): 292 unique packages across 315 installed
- **License posture**: clean. 100% permissive — predominantly MIT (242), then ISC (17), Apache-2.0 (14), BSD-3-Clause (5), BlueOak-1.0.0 (4), BSD-2-Clause (2), MIT-0 (1), 0BSD (1), `(MIT AND Zlib)` (1), `(MIT OR WTFPL)` (1), `(BSD-2-Clause OR MIT OR Apache-2.0)` (1). One package (`png-js@1.1.0`) has no `license` field in `package.json` but ships an MIT `LICENSE` file (effectively MIT — see [License findings](#license-findings)).
- **No GPL/AGPL/LGPL/MPL/EPL contamination anywhere in the tree.**
- **`npm audit`**: `0 vulnerabilities` (prod-only and full).
- **Install scripts**: Only one — `better-sqlite3` runs `prebuild-install || node-gyp rebuild --release`. Expected and benign (native bindings).
- **Lockfile**: `package-lock.json` is committed (`git ls-files` confirms).
- **`engines.node`**: pinned to `>=20`. One mismatch: `file-type@22.0.1` declares `engines.node >=22` — already flagged in `TODO.md`.
- **`.npmrc` / `.nvmrc`**: none present in repo (acceptable; no untrusted registry).

Bottom line: license posture is clean and audit is clean. The actionable items are maintenance — chiefly `multer@1.x` (deprecated by maintainer), `express@4.x` (LTS-maintenance), and the `file-type@22` Node-22 engine mismatch.

## Direct dependency table

Installed versions vs. latest on registry; "Last release" = publish date of the installed version.

| Package | Installed | Latest | License | Last release | Notes |
| --- | --- | --- | --- | --- | --- |
| `@simplewebauthn/server` | 11.0.0 | 13.3.0 | MIT | 2024-10-13 | Two majors behind. Pulls in `@simplewebauthn/types@11.0.0` which is deprecated ("Package no longer supported"). v13 drops this transitive dep. |
| `archiver` | 7.0.1 | 8.0.0 | MIT | 2024-03-10 | One major behind. v7 still maintained-grade. Pulls `glob@10.5.0` (deprecated for security in older majors; 10.5.0 itself is fine but maintainers warn about the family). |
| `better-sqlite3` | 11.10.0 | 12.10.0 | MIT | 2025-05-08 | One major behind. Native compile via `prebuild-install`. v12 supports Node 20+. |
| `dotenv` | 16.6.1 | 17.4.2 | BSD-2-Clause | 2025-06-27 | One major behind. v17 added a new licensing-adjacent telemetry mode opt-out — review before upgrading. |
| `express` | 4.22.1 | 5.2.1 | MIT | 2025-12-01 | 4.x is in **maintenance-only** mode per Express team; 5.x is the active line. 4.22.1 is the latest 4.x patch and is current. |
| `express-rate-limit` | 8.5.2 | 8.5.2 | MIT | 2026-05-14 | Up to date (published today). Healthy. |
| `file-type` | 22.0.1 | 22.0.1 | MIT | 2026-04-09 | **Engine mismatch**: requires Node `>=22` but project pins `>=20`. Already in `TODO.md`. Stay on v22 only if you bump the project's `engines` or risk runtime failures on Node 20.x. |
| `jsonwebtoken` | 9.0.3 | 9.0.3 | MIT | 2025-12-04 | Current. v9 fixed the 2022 CVE family (CVE-2022-23529 et al.). |
| `multer` | 1.4.5-lts.2 | 2.1.1 | MIT | 2025-03-20 | **Deprecated by maintainer**: install warning says "Multer 1.x is impacted by a number of vulnerabilities, which have been patched in 2.x. You should upgrade to the latest 2.x version." Highest-priority upgrade. |
| `nodemailer` | 8.0.7 | 8.0.7 | MIT-0 | 2026-04-27 | Current. Recently bumped per `TODO.md` V-10 to address advisories. Healthy. |
| `pdfkit` | 0.15.2 | 0.18.0 | MIT | 2024-12-15 | Three minor versions behind. Drags in `jpeg-exif@1.1.4` (deprecated upstream) and `png-js@1.1.0` (license-file-only, no SPDX in package.json). 0.18.0 may or may not change the situation — both still appear as deps of `pdfkit`. |

## License findings

**No copyleft anywhere.** No GPL, AGPL, LGPL, MPL, EPL, CDDL, CC-BY-SA, or proprietary licenses in either the direct deps or the 292-package resolved tree.

### One license-field anomaly (not a real risk)

- **`png-js@1.1.0`** — pulled in by `pdfkit`. Its `package.json` omits the `license` field, so automated tools (including SBOM generators) flag it as UNKNOWN. The package itself ships a proper MIT `LICENSE` file (`Copyright (c) 2017 Devon Govett`). If you generate an SBOM for compliance, you may want to add a manual override marking it MIT, or open a PR upstream to add `"license": "MIT"` to its `package.json`.

### Permissive but uncommon licenses (informational)

- `tslib@2.8.1` — **0BSD** (Microsoft's standard for `tslib`). Permissive, ~public-domain-equivalent. Fine.
- `pako@1.0.11` — **MIT AND Zlib**. Both permissive. Fine.
- `jackspeak`, `minipass`, `package-json-from-dist`, `path-scurry` — **BlueOak-1.0.0**. Permissive, OSI-approved, Isaac Schlueter's preferred license. Fine.
- `nodemailer` — **MIT-0**. MIT without the attribution clause. More permissive than MIT, no implications.

## Vulnerabilities (npm audit)

```
$ npm audit --omit=dev
found 0 vulnerabilities

$ npm audit
found 0 vulnerabilities
```

Nothing unresolved. The deprecated-package warnings emitted at `npm ci` time are advisory only and are not GitHub Advisory entries:

- `prebuild-install@7.1.3` — deprecated by author ("alternatives are available"). Pulled in by `better-sqlite3`. Functional, but the toolchain story for native add-ons is shifting.
- `multer@1.4.5-lts.2` — deprecated; vulnerabilities patched in 2.x. **No current `npm audit` finding**, but the maintainer message is clear.
- `@simplewebauthn/types@11.0.0` — deprecated ("Package no longer supported").
- `jpeg-exif@1.1.4` — deprecated.
- `glob@10.5.0` — deprecated-family warning. 10.5.0 itself has no audit advisory.

## Maintenance concerns

| Package | Concern |
| --- | --- |
| `multer@1.4.5-lts.2` | Author marked 1.x deprecated. The `-lts` line gets the occasional backport, but new CVEs land in 2.x first. v2.1.1 was published 2026-03-04. |
| `express@4.22.1` | 4.x is in maintenance per Express team; 5.x is the active line. 4.22.1 itself is current (Dec 2025 release). Acceptable to stay on 4.x short-term, but plan a 5.x migration. |
| `@simplewebauthn/server@11.0.0` | Two majors behind (current 13.x). v11 was published Oct 2024 — over a year stale relative to upstream. v13 drops the deprecated `@simplewebauthn/types` transitive. |
| `file-type@22.0.1` | Node engine mismatch (`>=22` vs project `>=20`). Production deployments on Node 20.x can break on install warnings or runtime imports. Already in `TODO.md`. |
| `pdfkit@0.15.2` | Three minors behind (0.18.0). Pulls in deprecated `jpeg-exif`. Low-momentum but actively published project. |
| `better-sqlite3@11.10.0` | One major behind. v12 is current. Native-compile dep; coordinate with deploy environment when bumping. |
| `archiver@7.0.1` | One major behind. v8 published 2026-05-08. |
| `dotenv@16.6.1` | One major behind (17.x). v17 introduced features some teams want to evaluate before adopting. |

### Single-maintainer / bus-factor flags

- `pdfkit`, `png-js` — both `devongovett`/`diegomura`. Small maintainer set, but both packages are actively published.
- `better-sqlite3` — Joshua Wise (`WiseLibs`). Single primary maintainer, but the project is stable, well-tested, and very widely used.
- `jsonwebtoken` — Auth0 / Okta. Corporate maintainer, healthy.
- `express`, `multer` — OpenJS Foundation governance. Healthy on paper, but Multer's deprecation indicates the 1.x line in particular is not getting active attention.

### Note on prompt vs. actual deps

The review brief mentions `playwright` as a recent devDep, but `package.json` declares no `devDependencies` field at all and `playwright` is not in the lockfile. No action — just flagging the discrepancy in case it was supposed to land.

## Recommendations (ranked)

1. **Upgrade `multer` from `1.4.5-lts.2` to `^2.1.1`.** Highest-priority maintenance item. The author has formally deprecated 1.x and explicitly states unpatched vulnerabilities exist there. Multer 2.x is a small breaking change (renamed/removed a couple of options, dropped deeply-nested `req.files` ambiguity). Only one call-site to touch: `src/routes/evidence.js`. Test plan: re-run the existing `tests/routes/evidence-upload.test.js`. Alternative if you want to escape the Multer churn entirely: replace with **`formidable@^3`** (smaller surface, similar maintenance profile) or **`@fastify/busboy`** + `busboy` directly (one less abstraction layer — `busboy` is already in the tree via Multer).
2. **Decide `file-type` engine alignment.** Either (a) bump `engines.node` to `>=22` in `package.json` and document the deploy requirement, or (b) downgrade to `file-type@^21` which still supports Node 20. Option (a) is cleaner long-term; option (b) is safer if any deploy target is pinned to Node 20.x. Already tracked in `TODO.md`.
3. **Upgrade `@simplewebauthn/server` 11 -> 13.** Two majors of stale, and it removes the deprecated `@simplewebauthn/types@11.0.0` transitive. Read the changelogs for 12.0 and 13.0 — the API for `verifyAuthenticationResponse` / `verifyRegistrationResponse` had small param renames. Touches `src/auth/webauthn.js`.
4. **Plan an `express@4 -> 5` migration.** Not urgent (4.22.1 is the latest 4.x and was published Dec 2025), but 4.x is officially maintenance-only. Migration is non-trivial: async error propagation changes, `req.query` is now `null`-prototyped, several middleware moved out. Stage this behind a feature branch.
5. **Bump `better-sqlite3` 11 -> 12, `archiver` 7 -> 8, `pdfkit` 0.15 -> 0.18, `dotenv` 16 -> 17.** Routine majors with manageable migration surface. Each touches one or two files (`src/db/index.js`, `src/routes/exports.js`, `src/lib/format.js`, `src/config.js`). Batch into a single "deps refresh" commit and re-run the test suite.
6. **Accept-and-document `png-js` missing license field.** It is MIT in fact (LICENSE file ships in the tarball). If/when you generate an SBOM, add a manual override or open a PR upstream to add `"license": "MIT"` to `pdfkit`/`png-js`. Tracking effort only.
7. **Accept `prebuild-install` deprecation warning.** It's transitive via `better-sqlite3` and there is nothing to do at this layer — the better-sqlite3 maintainer chooses the install toolchain. Bumping `better-sqlite3` to v12 may or may not resolve this (v12 still uses `prebuild-install` as of the time of this review).

## Already in good shape

These dependencies don't need attention:

- **`express-rate-limit@8.5.2`** — published 2026-05-14 (today). Up to date.
- **`nodemailer@8.0.7`** — current. Recent V-10 bump in `TODO.md` confirms it has been deliberately maintained at HEAD.
- **`jsonwebtoken@9.0.3`** — current. v9 fixed the 2022 CVE family. Auth0/Okta-maintained.
- **License posture overall** — 100% permissive, zero copyleft, one cosmetic license-field gap.
- **`npm audit`** — `0 vulnerabilities` on both prod-only and full scans.
- **Supply-chain hygiene** — `package-lock.json` is committed, only one install script in the tree and it's the expected native-bindings build (`better-sqlite3`), `engines.node` is pinned. No `postinstall` hooks in any transitive package that could exfiltrate data.
