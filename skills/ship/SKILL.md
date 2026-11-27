---
name: ship
description: Runs the code and security reviewers on the branch, fixes what they find, re-runs verify, then pushes and opens the PR (or, for an epic, fills in its PR and marks it ready for review). Never merges.
disable-model-invocation: true
---

Ship the current branch.

0. **Settings.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it prints `NOT-SET-UP` or `INVALID`, stop
   and tell the user to run `/runway:setup`. Otherwise its JSON gives `epicsDir`, `baseBranch` and `reviewModel`. If the current
   branch (`git branch --show-current`) is `<baseBranch>`, `main` or `master`, or HEAD is detached, stop: runway
   ships through a PR and never pushes to the base branch. Tell the user to move the work onto its own branch
   (`git switch -c <name>` keeps the commits and the uncommitted changes) and run `/runway:ship` again. If the branch is
   `epic/<slug>`, this is an epic: every row of the Slices table in `<epicsDir>/<slug>.md` must be `done`, and no
   suppression comment naming `runway epic <slug>` may remain (search the repository); if either fails, say what is
   left (`/runway:epic-next`) and stop. **The criteria:** for an epic, the slice specs in
   `.runway/specs/epic/<slug>/` (one `slice-<N>.md` each; for a slice without one, its row in the epic file and its
   commits); otherwise `.runway/specs/<branch>.md` if it exists, with the risk.
1. **Review.** Always run the `runway:reviewer` agent. Run the `runway:security-reviewer` agent with it, in
   parallel, when any of these holds: this is an epic; the spec's risk is medium or high (or no spec states a risk);
   or `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" --security-files origin/<baseBranch>...HEAD` prints files
   rather than `NONE`. Otherwise skip it, and keep the reason for the PR body. Give each reviewer the criteria's
   absolute file paths (with none, write the criteria out), the epic file path if any, the base branch, and the
   range `origin/<baseBranch>...HEAD`. They see nothing else of this conversation. Start both with the Agent tool's
   `model` set to `reviewModel` (leave it unset when that is `inherit`).
   **Then test the tests**, for an epic or a medium or high risk change: once both reviewers have returned, with the
   working tree clean, run the `runway:test-auditor` agent with the same criteria, base branch and range. Each
   criterion it reports `SURVIVED` is a blocker. After it returns, `git status --porcelain` must be empty: if not,
   restore the files it names with `git checkout -- <file>`.
2. **Fix** every blocker and should-fix finding. If you disagree with one, say why to the user rather than
   ignoring it. A missing test: `runway:test-writer` writes and commits it failing, then fix the code. A weak test
   (including each `SURVIVED`): `runway:test-writer` in repair mode (`repair: <test name>: <why>`). A fix with no
   testable behaviour says `[no-tests] <why>` in its commit message. Then follow
   `${CLAUDE_PLUGIN_ROOT}/skills/verify/SKILL.md` again until green. Re-run the reviewer when fixes changed more
   than a few lines of logic.
3. **PR body.** Fill in `${CLAUDE_PLUGIN_ROOT}/templates/pr-body.md`:
   - summary;
   - the acceptance criteria as a checklist, each ticked only if verified, with the test, screenshot or manual
     check proving it (for an epic, grouped by slice, with each slice's commits so reviewers can read it commit by
     commit);
   - risk level and why, and, if the security review was skipped, a line saying so and why (for example "Security
     review skipped: low risk, no security-relevant paths touched"); the dev actions needed before merging and the
     After merge follow-ups, for an epic;
   - screenshots: list each file under `.claude/screenshots/<branch>/` and what it shows. `gh` cannot upload
     images, so tell the user to drag them into the PR;
   - the epic file link, or "None";
   - **Proposed for the docs:** usually "None". Only when something went wrong more than once (the same check
     failing twice, a reviewer blocker, the user correcting you, an epic's Decisions or `fix:` commits) and a fresh
     session could repeat it: propose a lint rule, test or type that would catch it, or else one line for
     CLAUDE.md, a doc it links or REVIEW.md (name the file). At most one; never edit those files yourself.
   Write it to a temporary file outside the repository.
4. **Open or finish the PR.** Push the branch (`git push -u origin HEAD`, never with force). If the branch already
   has an open PR (`gh pr view --json number,isDraft,title`), update it: `gh pr edit <number> --title "<conventional
   commit title>" --body-file <file>`, then `gh pr ready <number>` if it is a draft. Otherwise run
   `gh pr create --base <baseBranch> --title "<conventional commit title>" --body-file <file>`. If this repository
   has a PR template that asks for other sections, add them below runway's sections.
5. Report the PR URL, any finding you left unfixed, and the docs proposal if there is one. Never merge the PR: a
   developer reviews and merges it.
