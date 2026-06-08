#!/usr/bin/env bash
# Apply (or re-apply) classic branch protection to `main`.
#
# Requires: `gh` authenticated as an account with ADMIN rights on the repo
# (the repo owner). A write-level collaborator gets HTTP 404 from this endpoint.
# The PUT is idempotent — re-running re-applies the same rule.
#
# Rule: every change must arrive via a PR, and the `Build & test` CI check
# (the `verify` job in .github/workflows/ci.yml) must pass before merge.
# Enforced on admins too; no required approvals (solo self-merge); non-strict.
set -euo pipefail

# Derive owner/repo from the `origin` remote so this is portable.
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
echo "Applying branch protection to ${REPO}@main…"

gh api -X PUT "repos/${REPO}/branches/main/protection" --input - <<'JSON'
{
  "required_status_checks": {
    "strict": false,
    "checks": [
      { "context": "Build & test" }
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON

echo "Done. Current protection:"
gh api "repos/${REPO}/branches/main/protection" \
  -q '{enforce_admins: .enforce_admins.enabled, required_checks: [.required_status_checks.checks[].context], requires_pr: (.required_pull_request_reviews != null)}'
