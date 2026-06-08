# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The Dink Club — a mobile-first **Angular 22** app for running open-play pickleball
sessions with live, multi-device sync via **Firebase** (Firestore + Anonymous Auth),
styled with **Tailwind v4** + **Angular Material**.

## Commands

```bash
npm start                    # ng serve → http://localhost:4200
npm run build                # production build → dist/pickleball-court-management/browser
npm test                     # ng test → vitest (jsdom), watch mode
npx ng test --watch=false    # one-shot test run (what CI uses)
npx vitest run -t "name"     # run a single test by name (or pass a spec path)
npx firebase deploy --only firestore:rules   # publish security rules (required for writes)
```

### Two hard prerequisites (builds fail without these)

1. **Node ≥ 24.15** (Angular 22 requirement). The machine default may be older — use
   `nvm use 24` (e.g. 24.16) before any `npm`/`ng` command, or `ng new`/`build` will
   abort with a version error.
2. **`src/environments/environment.ts` is git-ignored.** Create it before building:
   `cp src/environments/environment.example.ts src/environments/environment.ts` and fill
   in the Firebase web config (or `firebase apps:sdkconfig WEB`). CI does this step in the
   workflow; locally you must do it once.

## Architecture — the big picture

**One Firestore document per session.** The entire `SessionState` (courts, players map,
queue, challenger queue, mode, admin info) lives in a single doc at `sessions/{code}`.
This makes every change atomic and lets one listener drive the whole UI. Consequences:

- **All game logic is a pure, framework-free engine** in `core/services/rotation.ts` —
  no Firebase, no Angular. Each operation takes a `SessionState` and returns a new one
  (`addPlayer`, `finishStandardGame`, `finishChallengerGame`, `setMode`, `restPlayer`,
  `activatePlayer`, etc.). This is the correctness core and is exhaustively unit-tested in
  `rotation.spec.ts`. **Never reimplement rotation rules in a component or service** —
  call `rotation.*` and persist the result.
- **`SessionService.mutate()`** is the only write path: it runs a Firestore **transaction**
  that reads the doc, applies a pure rotation function, and writes the whole doc back, then
  **rethrows** on failure. This trades latency (a server round-trip per action, no offline
  echo) for correctness under concurrent admin/player edits. `SessionService` is otherwise a
  thin Firebase data layer (`listen()`, `createSession()`, `claimAdmin()`); it does **not**
  hold the live state or surface gameplay errors.
- **`SessionStore`** (`core/state/session-store.ts`, an `@ngrx/signals` SignalStore provided
  at the session **routes**) is the client-side state + UX layer. It owns the single live
  listener (via `SessionService.listen()`), the shared selectors both views read (`queue`,
  `challengerPairs`, `benched`, `status`, `me`, `isAdmin`, …), and per-action `pending`/`error`
  state. Components call `store.connect(code)` then read selectors and call store mutators
  (`store.join(...)`, `store.finishStandardGame(...)`) — **never** `SessionService` mutators
  directly. Each mutator is an `rxMethod` that **delegates the write to `SessionService`**
  (rotation rules stay in `rotation.ts`), guards repeat taps of the same action+target, and
  surfaces failures. Use the `busy(action)` helper in templates to disable a control while
  its action runs.
- **`SessionService.listen()`** attaches the `onSnapshot` listener only *after* anonymous auth
  lands (a signal `effect` on `FirebaseService.uid`), because `onSnapshot` does **not** recover
  from an initial permission-denied error. Do not attach reads before `uid` is set. `SessionStore`
  additionally re-attaches the listener on stream errors and on `online`/`visibilitychange`,
  so the live view recovers from offline/auth hiccups.

**Firebase setup is performance-tuned** (`core/services/firebase.service.ts`): Firestore
uses `experimentalAutoDetectLongPolling` + a persistent IndexedDB cache (Safari/perf), and
anonymous sign-in is **non-blocking at bootstrap** (`app.config.ts` app initializer is
fire-and-forget; pages render immediately and show a loading state until `uid` resolves).

**Data-model quirks to respect:**
- Firestore disallows nested arrays, so challenger-queue pairs are stored as objects
  `{ playerIds: [a, b] }`, never `string[][]`.
- **Teams are derived, not stored.** `CourtCard` splits the 4 players into Team 1 / Team 2:
  on a standard court that's first-two / last-two; on the challenger court it's the
  `incumbentPairIds` (the staying winners) vs. the rest.
- **Admin identity** = `adminUid` + `adminToken`. The token is a bearer secret stored in the
  (readable) session doc that lets a returning admin reclaim the role on another device via
  the `?t=<token>` admin link. Documented trade-off in `firestore.rules`: anyone with the
  code can read it / make gameplay writes — fine for a known group, not a hostile audience
  (harden by moving writes behind Cloud Functions).

**Routes** (`app.routes.ts`, all lazy): `/` create session · `/session/:code` player view ·
`/session/:code/admin` admin. The admin route's component reclaims admin with a token or
redirects non-admins to the player view (an `effect` in `AdminDashboard`).

## Conventions

- **Standalone components, signals, new control flow** (`@if`/`@for`). No NgModules.
- **Each component lives in its own folder** named after it, with separated files:
  `name/name.ts` (uses `templateUrl` + `styleUrl`), `name.html`, `name.scss`, `name.spec.ts`.
  When adding a component, follow this layout; mind relative import depth to `core/`
  (`../../../core/...` from a `features/<area>/<name>/` folder).
- **Styling:** brand design tokens live in `src/tailwind.css` `@theme` (e.g. `--color-court`,
  `--font-display`, `--shadow-hard`) — these generate both Tailwind utilities (`bg-court`,
  `font-display`, `shadow-hard`) **and** `--color-*` CSS vars consumed by component SCSS.
  `src/styles.scss` holds the Angular Material M3 theme + global motifs (`.ball`, the court
  net, keyframes). Use Tailwind utilities for layout/color; reach for component SCSS only
  for pseudo-element motifs and keyframe animations. Material is used for interactive
  controls (inputs, select, slide-toggle, dialog, snackbar).

## Testing

Tests run on **vitest** via the `@angular/build:unit-test` builder (no Karma/Chrome).
Highest-value coverage is the pure `rotation.ts` engine. Component and `SessionStore` tests
instantiate via `TestBed` and read selectors directly (often without `detectChanges`), using
a lightweight **fake `SessionService`** with real signals (its `listen()` feeds a snapshot to
the store and its mutators record calls / return controllable promises) rather than Firebase
mocks. The store's per-action `pending` guard means a second call to the *same* action+target
is dropped until the first settles — so sequential same-action tests must `await` a tick
between calls. `firebase.service` is intentionally not unit-tested (Firebase-emulator territory);
`session.service` has a thin spec backed by an in-memory Firestore stand-in.

## CI/CD

- `.github/workflows/ci.yml` — `npm ci`, build, tests on every push + PR.
- `.github/workflows/deploy.yml` — triggered via `workflow_run` *after CI succeeds on `main`*,
  generates `environment.ts` from repo **variables** (`FIREBASE_*`), builds, and deploys to
  Firebase Hosting `live`. The deploy credential is the repo **secret**
  `FIREBASE_SERVICE_ACCOUNT_PICKLEBALL_COURT_MANAGEMENT`. Live site:
  https://pickleball-court-management.web.app
