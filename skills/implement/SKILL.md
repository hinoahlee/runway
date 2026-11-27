---
name: implement
description: Implements the approved spec test-first in the current git worktree. For each test file a runway:test-writer agent writes and commits the failing tests, then the code makes them pass and is committed on its own. Finishes with verify.
disable-model-invocation: true
model: sonnet
effort: medium
---

Implement the approved spec.

1. **Worktree only.** Run `git rev-parse --absolute-git-dir` and `git rev-parse --path-format=absolute
   --git-common-dir`. If they are the same path, this is the main checkout: stop and tell the user to run
   `/runway:spec` first, which moves the session into a worktree. **Read the spec**: the one in this conversation,
   or `.runway/specs/<branch>.md` (`git branch --show-current`; for an epic slice,
   `.runway/specs/epic/<slug>/slice-<N>.md`). With neither, stop and ask for `/runway:spec` first. The user running
   `/runway:implement` approves a saved spec. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"` for `epicsDir`
   if you do not have it yet.
2. **Read the epic file** in `<epicsDir>` if this work is a slice of one. It wins over your preferences: follow its
   interfaces, data model, release (all at once or flag) and decisions.
3. **Test-first, one test file at a time.** Group the `[test: <file>]` criteria by test file, in the order they
   first appear. For each group:
   1. **Always** run one `runway:test-writer` agent with all the group's criteria, that test file and the epic
      file path, before any code. Never write or edit a test file yourself. It commits the failing tests
      (`test: ... (red)`); the commit guard blocks code commits until one exists, and commits that mix tests and code.
   2. Write the smallest code that makes them pass. Never change a test to make it pass. If a test is wrong, run
      the test writer again in repair mode (`repair: <test name>: <why>`), or stop and ask.
   3. Run the affected tests until green, then commit the code alone (`feat: ...`, `fix: ...`) naming the
      group's criteria.
   `[manual: ...]` criteria get no test: build them along the way, and verify proves them. A commit with no
   testable behaviour (all criteria manual, config, a dependency) says `[no-tests] <why>` in its message.
   Run tests and the verify command quietly, as `${CLAUDE_PLUGIN_ROOT}/skills/verify/SKILL.md` step 1 shows.
   **Few turns.** Every turn re-sends the whole conversation, so: send independent reads, searches and commands
   together in one message; don't re-read a file after editing it (the edit fails if it didn't apply); run one
   command per step, not several separate tool calls for the same thing.
4. **Follow the conventions skill** (`runway:conventions`) and the docs it points to for every file you touch.
5. **If the design must change** (an interface, the data model, the slices), update the epic file in this same
   branch and add a dated entry under Decisions. Tell the user. When the spec itself changes, update the spec file
   too.
6. **Stopping to ask.** If you must ask the user something before you can go on (a design question, a new
   dependency), end your message with a line `RUNWAY-ASK: <the question>`: runway's Stop hook lets you stop with
   uncommitted changes only then.
7. **Finish with verify:** read `${CLAUDE_PLUGIN_ROOT}/skills/verify/SKILL.md` and follow it. Report each criterion
   with the test, screenshot or manual check that proves it.
8. **Hand over to ship.** Don't push, open a PR or offer to open one: `/runway:ship` does that after reviewing the
   branch, and runway's hook blocks `gh pr create` anywhere else. For a slice of an epic, epic-next says what comes
   next. Otherwise end by telling the user the next step is `/clear`, then `/runway:ship` (it reads the saved spec).
