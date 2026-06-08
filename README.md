# Pickleball Court Management

A mobile-first web app for running open-play pickleball sessions. An **admin**
creates a session with N courts; **players** join from their own phones via a
share link and are auto-rotated onto courts as games finish.

- **Standard mode** — pure 4-on / 4-off rotation across all courts.
- **Challenger mode** — one court runs 2-on / 2-off *winner-stays*, fed by a
  separate challenger queue. Winners of a standard court can be **promoted**
  into the challenger queue; losers on the challenger court drop to the back of
  the standard queue.
- **The organizer plays too** — entering your name on create adds you to the
  queue. Anyone (organizer included) can **take a break** (sit on the bench)
  and **jump back in**, or leave entirely.
- **Join from home** with a code or a pasted link.
- **Admin recovery** — the organizer can copy an admin transfer link to
  re-open the dashboard on another device.

Built with **Angular 22** (standalone + signals + Tailwind v4), **Angular
Material** (interactive controls), and **Firebase** (Firestore real-time +
Anonymous Auth).

> **Security note.** Access is gated by a hard-to-guess join code + Firestore
> rules (see `firestore.rules`). Two documented trade-offs make this great for a
> known group but not a hostile public audience: any signed-in player who knows
> the code can perform gameplay writes, and the `adminToken` lives in the
> readable session doc. Harden both by moving writes behind Cloud Functions /
> the Admin SDK (requires the Blaze plan).

## Tech / architecture

```
src/app/
  core/
    models/types.ts            Domain types (SessionState, Court, Player, …)
    services/
      rotation.ts              PURE rotation logic (no Firebase) — unit tested
      rotation.spec.ts         23 unit tests covering every rotation flow
      firebase.service.ts      Firebase app + anonymous auth (uid signal)
      session.service.ts       Firestore read/write; transactions + onSnapshot→signal
  features/
    home/create-session.ts     Admin: create a session
    admin/admin-dashboard.ts   Admin: courts, queues, mode toggle, controls
    admin/court-card.ts        One court (players, status, finish button)
    admin/end-game-dialog.ts   Pick winning pair + promotion offer
    player/player-page.ts      Player: join + live "where am I" status
  app.routes.ts                /  ·  /session/:code  ·  /session/:code/admin
```

The **entire session lives in one Firestore document** (`sessions/{code}`), so
every rotation is an atomic transaction and one `onSnapshot` listener drives the
live UI on every device. The rotation rules are pure functions, applied inside
the transaction by `SessionService`.

### Routes

| Route | Who | Purpose |
| --- | --- | --- |
| `/` | admin | Create a session → redirected to the admin view |
| `/session/:code/admin` | admin | Manage courts, queues, mode |
| `/session/:code` | players | **Shareable link** — join + live status |

## Prerequisites

- **Node ≥ 24.15.0** (Angular 22 requirement). This repo was built on v24.16.0.
  If you use `nvm`: `nvm install 24 && nvm use 24`.
- A Firebase project with **Firestore** and **Anonymous Authentication**
  enabled.

### Firebase config (not committed)

`src/environments/environment.ts` holds the web config and is **git-ignored**.
Create it from the template before building:

```bash
cp src/environments/environment.example.ts src/environments/environment.ts
# then fill in your values, or:
firebase apps:sdkconfig WEB --project <your-project-id>
```

The web API key is a **public client identifier** (it ships in the browser
bundle), not a secret. We keep it out of the repo for hygiene, but real
protection comes from three layers: the Firestore security rules, Firebase Auth
authorized domains (auto-configured for Hosting domains), and **restricting the
API key** in Google Cloud Console. Once the bundle is public, the referrer
allowlist is the practical guard that stops the key being reused from other
origins — see the runbook below.

### Restrict the API key (Google Cloud Console)

In `APIs & Services → Credentials`, open the project's **Browser key**, then set
both restrictions:

**1. Application restrictions → Websites.** Add these referrer patterns
(keep the trailing `/*`; matching is exact path-prefix):

| Origin            | Pattern                                          |
| ----------------- | ------------------------------------------------ |
| Prod (Hosting)    | `pickleball-court-management.web.app/*`           |
| Prod (Auth domain)| `pickleball-court-management.firebaseapp.com/*`   |
| Local dev         | `localhost:4200/*`                                |

**2. API restrictions → Restrict key.** Limit the key to only the APIs this app
actually calls, so a leaked key can't be repurposed for other billed APIs:

- **Identity Toolkit API** — Firebase Anonymous Auth
- **Token Service API** — auth token refresh
- **Cloud Firestore API** — the single `sessions/{code}` doc read/write path
- **Firebase Installations API** — SDK bootstrap

(`measurementId` analytics works without an extra key API, so it isn't listed.
If you later add Storage, Remote Config, or full Analytics event ingestion, add
the matching API here or those calls will 403.)

**Gotchas.** Restriction changes take a few minutes to propagate. A sudden
site-wide `PERMISSION_DENIED` / 403 after a deploy usually means the API
restrictions are too tight — add the missing API rather than removing the
referrer list. The referrer list is an allowlist of *origins*, not a secret; it
does **not** replace the Firestore rules, which remain the real authZ boundary.
For stronger hardening beyond key restriction, see the trade-off note in
`firestore.rules` (moving writes behind Cloud Functions / App Check).

## Run locally

```bash
npm install
cp src/environments/environment.example.ts src/environments/environment.ts  # first time only
npm start                # ng serve → http://localhost:4200
```

Open the admin view in one window, copy the share link (the code button in the
toolbar), and open `/session/<CODE>` in other windows/phones to simulate
players.

## Tests

```bash
npm test                 # vitest (jsdom) — rotation logic + smoke tests
```

## Deploy the Firestore security rules

The rules in `firestore.rules` must be live for gameplay writes to work:

```bash
npx firebase login                 # if not already
npx firebase deploy --only firestore:rules
```

## Build & host

```bash
npm run build                                  # → dist/pickleball-court-management/browser
npx firebase deploy --only hosting             # manual one-off deploy
```

## Continuous deployment (GitHub Actions)

Two workflows:

- **`.github/workflows/ci.yml`** — `npm ci`, build, and unit tests on every
  push and PR.
- **`.github/workflows/deploy.yml`** — triggered via `workflow_run` after CI
  succeeds on `main`; builds with the real Firebase config and deploys to
  **Firebase Hosting** (`live` channel). It won't run if CI failed, so a broken
  commit never deploys.

### One-time setup on the GitHub repo

1. **Repo variables** (Settings → Secrets and variables → Actions → *Variables*) —
   the public Firebase web config the deploy build is generated from. These are
   set already for this repo; recreate them with:
   ```bash
   gh variable set FIREBASE_API_KEY            --body "<apiKey>"
   gh variable set FIREBASE_AUTH_DOMAIN        --body "<project>.firebaseapp.com"
   gh variable set FIREBASE_PROJECT_ID         --body "<project>"
   gh variable set FIREBASE_STORAGE_BUCKET     --body "<project>.firebasestorage.app"
   gh variable set FIREBASE_MESSAGING_SENDER_ID --body "<senderId>"
   gh variable set FIREBASE_APP_ID             --body "<appId>"
   gh variable set FIREBASE_MEASUREMENT_ID     --body "<measurementId>"
   ```
2. **Deploy credential** (secret) — a Firebase service account for CI. The
   easiest way to provision it (creates the service account *and* uploads the
   secret named `FIREBASE_SERVICE_ACCOUNT_PICKLEBALL_COURT_MANAGEMENT`):
   ```bash
   firebase init hosting:github
   ```
   When prompted, point it at this repo and **decline** letting it overwrite the
   existing workflow (we ship our own `ci-cd.yml`). Delete any extra
   `firebase-hosting-*.yml` files it generates.

Once the secret is in place, every merge to `main` ships to
`https://pickleball-court-management.web.app`. Firebase Hosting domains are
auto-authorized for Anonymous Auth, so sign-in works out of the box.

## Local emulators (optional, offline dev)

```bash
npx firebase emulators:start --only auth,firestore
```

> Note: to point the app at the emulators, add `connectAuthEmulator` /
> `connectFirestoreEmulator` calls in `firebase.service.ts` guarded by a
> dev-only flag. By default the app talks to the live project.
