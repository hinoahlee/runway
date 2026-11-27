---
name: epic-plan
description: Plans a large feature as an epic built in slices on one branch, epic/<slug>, that lands as one PR. Writes the epic file and a skipped end-to-end acceptance test, reviews them with the user, then pushes the branch and opens the epic's draft PR. Writes no feature code.
argument-hint: "<ticket or brief>"
disable-model-invocation: true
---

Plan the epic for: $ARGUMENTS

0. **Settings.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it prints `NOT-SET-UP` or `INVALID`, stop
   and tell the user to run `/runway:setup`. Otherwise its JSON gives `verifyCommand`, `epicsDir` and `baseBranch`,
   used below.
1. **Name it.** Pick a short kebab-case slug for the epic. Run `git fetch` and check `origin/epic/<slug>` does not
   exist (`git rev-parse --verify --quiet origin/epic/<slug>`); if it does, that epic is already planned: tell the
   user and stop, or pick another slug if this is a different feature.
2. **Create the branch.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/prepare-branch.mjs" epic/<slug> --base
   <baseBranch> --new`: it creates `epic/<slug>` from `origin/<baseBranch>` in this checkout, and refuses while the
   checkout has uncommitted changes. On `ON epic/<slug>`, continue. On `STOP <reason>`, stop and tell the user the
   reason (uncommitted changes: they commit, stash or discard them, then run `/runway:epic-plan` again).
   **Baseline:** install dependencies if they are missing, then run the verify command once before changing
   anything, quietly, as `${CLAUDE_PLUGIN_ROOT}/skills/verify/SKILL.md` step 1 shows. If it fails, the base branch is already broken: tell the user what fails and stop.
3. **Map the code.** Run the `runway:explorer` agent with the brief. Read the files it names that matter most, the
   repository's CLAUDE.md and the convention docs it links.
4. **Write the epic file.** Copy `${CLAUDE_PLUGIN_ROOT}/templates/epic.md` to `<epicsDir>/<slug>.md` and fill in
   every section:
   - goal and non-goals; affected code (from the explorer);
   - data model and migrations, with who owns each row. The whole epic deploys at once when its PR merges, so each
     migration must work while the release before it is still running. A destructive step (dropping or renaming
     what that release reads) goes under **After merge** as a follow-up PR;
   - interfaces: types, API contracts, events and job payloads;
   - failure handling: retries, idempotency, ordering;
   - the release: **all at once** (the default: the feature is live when the PR merges) or **flag** (for a change to
     behaviour users rely on, or one risky enough to try in production first: name the flag, how it is read and
     how to turn it on for chosen users; tests cover both states; removing it goes under After merge). If the
     repository has no flag mechanism, its smallest one, fitting the config conventions, is slice 1. Say why in
     the decisions log;
   - the decisions log, starting with the choices made in this plan.
5. **Write the slices** as the template's table: number, scope, risk (low/medium/high), dev action (what only a
   developer can do before the PR merges, such as new env vars in the hosting dashboard), status `todo`. Each slice
   is small enough to build and review in one session (roughly a few hundred lines) and keeps the verify command
   green. Schema before the code that uses it. The last slice completes the feature and un-skips the acceptance
   test. If the epic needs more than about eight slices, it is too big to review as one PR: propose splitting it
   into two epics.
6. **Write the end-to-end acceptance test now**, in the repository's e2e folder and style, marked skipped (for
   example `test.skip`), describing the whole journey as it works once the epic is done. Run the repository's
   linter on the file. If it rejects the skip (Biome's `noSkippedTests`, or an ESLint rule such as
   `playwright/no-skipped-test`), put the linter's suppression comment for exactly that rule on the line above,
   with the reason, for example
   `// biome-ignore lint/suspicious/noSkippedTests: runway epic <slug>, un-skipped by its last slice`.
   Record the test's path in the epic file.
7. **Review with the user.** Show the epic file path, the slices table and any open questions. Write no feature
   code. Revise until the user approves.
8. **Push and open the epic's PR.** Commit the epic file and the test (`docs: plan the <slug> epic`), run the
   verify command, push (`git push -u origin epic/<slug>`, never with force), and open the PR:
   `gh pr create --draft --base <baseBranch> --title "feat: <slug>" --body-file <file>` with the goal, the slices
   table and "Built slice by slice; not ready for review until it leaves draft." If `--draft` is refused (draft PRs
   need a paid GitHub plan on private repositories), run it again without `--draft` and with the title
   `WIP: feat: <slug>`. Then tell the user the next step: `/runway:epic-next` to build slice 1 by hand (here or in a
   new session), or `/runway:epic-auto` to build every slice unattended. Nothing reaches `<baseBranch>` until they
   review and merge the PR.
