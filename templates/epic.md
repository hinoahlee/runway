# Epic: <title>

- **Ticket / brief:** <link or one line>
- **Branch:** `epic/<slug>`, one PR into the base branch, reviewed and merged by a developer
- **Release:** <all at once: the feature is live when the PR merges | flag: `<name>`, off when the PR merges>
- **Acceptance test:** `<path to the end-to-end test, skipped until the last slice>`

## Goal
<What changes for users when the epic is done, in two or three sentences.>

## Non-goals
- <What this epic deliberately leaves out.>

## Affected code
<From the explorer agent: the files and modules this touches, with paths.>

## Data model and migrations
<Tables and columns added or changed, who owns each row, and each migration. Every migration must work with the
release that is running when it deploys: add first, remove only what no running release reads.>

## Interfaces
<Types, API contracts (request/response schemas, status codes), events and job payloads.>

## Failure handling
- **Retries:** <what retries, how often, when it gives up>
- **Idempotency:** <what makes a repeated request or job safe>
- **Ordering:** <what may arrive out of order and how it is handled>

## Slices
Built in order on `epic/<slug>`, one or more commits each. Nothing deploys until a developer merges the epic's PR,
so a slice may leave the feature unfinished, but every slice keeps the verify command and CI green.

| # | Scope | Risk | Dev action | Status |
|---|---|---|---|---|
| 1 | <scope> | low | - | todo |

Risk: low (no schema, auth, billing or data change), medium (new user-facing behaviour), high (migrations, auth,
billing, data deletion, or anything hard to roll back). Dev action: what only a developer can do before the PR
merges (an env var or secret in the hosting dashboard, an account, a manual data step), or "-". Status: todo or
done.

## After merge
<Follow-ups that must wait until this epic is deployed: the second step of a two-step migration (dropping or
renaming what the old release still reads), removing the flag and the old code path once it is on for everyone.
Each becomes its own small PR. "None" if nothing.>

## Decisions
<Dated entries: what was decided, why, and what it replaced. epic-next and implement add to this when reality
diverges from the plan.>
