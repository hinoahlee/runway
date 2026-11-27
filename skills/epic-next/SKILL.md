---
name: epic-next
description: Builds the next slice of an epic on its branch, epic/<slug>. Brings the branch up to date, specs and implements the slice test-first, verifies and reviews it, then marks it done, commits and pushes.
argument-hint: "[slug]"
disable-model-invocation: true
---

Build the next slice of an epic. Arguments: `$ARGUMENTS`, an optional slug (the epic's name, as in
`epic/<slug>`).

0. **Settings.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"`. If it prints `NOT-SET-UP` or `INVALID`, stop
   and tell the user to run `/runway:setup`. Otherwise its JSON gives `verifyCommand`, `epicsDir`, `baseBranch` and `reviewModel`.
1. **Find the epic.** Use the slug if given. Otherwise, if the current branch is `epic/<slug>`, use that. Otherwise
   run `git fetch` and list the epic branches (`git for-each-ref --format="%(refname:short)"
   refs/remotes/origin/epic/`); for each, read `git show origin/epic/<slug>:<epicsDir>/<slug>.md`. An epic is
   unfinished while a row of its Slices table is not `done`, or while its PR is a draft or `WIP:`. One unfinished
   epic: use it and say which. Several: list them (slug, goal, slices left) and ask which. None: say there is no
   epic in progress and stop.
2. **Switch to the branch.** Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/prepare-branch.mjs" epic/<slug> --base
   <baseBranch>`: it switches this checkout to `epic/<slug>` (from `origin/epic/<slug>` when there is no local one)
   and catches it up with what was pushed. On `ON epic/<slug>`, continue. On `STOP <reason>`, stop and tell the user
   the reason (uncommitted changes on another branch: they commit, stash or discard them first).
3. **Bring the branch up to date.** If `git status --porcelain` shows changes, a previous session left work
   unfinished: tell the user what is there and ask whether to continue it, ending your message with a line
   `RUNWAY-ASK: continue the unfinished work?` (unattended: continue it). Then, if `origin/<baseBranch>` has commits this branch lacks,
   `git merge origin/<baseBranch>` and resolve conflicts keeping the intent of both sides.
   **Baseline:** install dependencies if they are missing, then run the verify command once before starting the
   slice, quietly, as `${CLAUDE_PLUGIN_ROOT}/skills/verify/SKILL.md` step 1 shows. If it fails because of the merge, fix it until it passes. If the base branch itself is broken (the same
   check fails on `origin/<baseBranch>`), tell the user what fails and stop; don't fix the base branch here. Push
   (`git push`, never with force).
4. **Pick the slice:** the first row of the Slices table in `<epicsDir>/<slug>.md` that is not `done`. If every
   slice is done, say the next step is `/runway:ship` (unattended: just stop; the runner ships), and stop.
   Note the current commit (`git rev-parse HEAD`): the slice's review starts there. If the slice's dev action must
   happen before work can continue (not just before merging), tell the user.
5. **Spec, implement, verify.** Read `${CLAUDE_PLUGIN_ROOT}/skills/spec/SKILL.md` and follow it for this slice
   from its step 1. The chain is fixed: spec (saved to `.runway/specs/epic/<slug>/slice-<N>.md`) → implement, where
   **a `runway:test-writer` agent writes and commits each test file's failing tests before any code; never write
   tests yourself** → verify. If this is the last slice, its criteria include un-skipping the acceptance test and
   removing its suppression comment.
6. **Review the slice.** Always run the `runway:reviewer` agent. Run the `runway:security-reviewer` agent with it,
   in parallel, only when the slice's risk is medium or high, or
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs" --security-files <commit from step 4>..HEAD` prints files rather
   than `NONE`; `/runway:ship` reviews the whole epic for security either way. Give each reviewer the
   slice's spec file path (`.runway/specs/epic/<slug>/slice-<N>.md`, absolute), the epic file path, the base branch,
   and the range to review: `<commit from step 4>..HEAD`. Start both with the Agent tool's `model` set to
   `reviewModel` (leave it unset when that is `inherit`). Fix every blocker and should-fix finding (say why to the
   user if you disagree with one), tests first as implement says, commit, and follow
   `${CLAUDE_PLUGIN_ROOT}/skills/verify/SKILL.md` again until green.
7. **Finish the slice.** Set its Status to `done` in the epic file (add a Decisions entry if the slice changed the
   plan), commit (`docs: finish <slug> slice <N>`) and push (`git push`, never with force). CI runs on the epic's PR.
8. **Report** each criterion with its proof, then the next step (not when unattended): the next slice with
   `/runway:epic-next` in a new session, or, after the last slice, `/runway:ship`.
