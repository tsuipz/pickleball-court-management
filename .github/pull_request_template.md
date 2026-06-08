## Summary

<!-- What does this PR do and why? 1–3 sentences. -->

## Type of change

<!-- Match your conventional-commit type(s). -->
- [ ] feat — new feature
- [ ] fix — bug fix
- [ ] refactor — no behavior change
- [ ] test — tests only
- [ ] docs — docs only
- [ ] chore / build / ci

## Changes

<!-- Bullet the notable changes. -->
-

## How to test

<!-- Steps to verify locally. Note any new session/admin flow to exercise. -->
1.

## Checklist
- [ ] `npm run build` passes
- [ ] `npx ng test --watch=false` passes
- [ ] Rotation rule changes live in `core/services/rotation.ts` (not duplicated in a component/service) and are covered in `rotation.spec.ts`
- [ ] Writes go through `SessionStore` mutators → `SessionService.mutate()` (no direct Firestore writes in components)
- [ ] No secrets committed; `src/environments/environment.ts` stays git-ignored
- [ ] Firestore rule changes (if any) deployed via `npx firebase deploy --only firestore:rules`

## Related

<!-- Link issues/PRs, e.g. Closes #123. -->
