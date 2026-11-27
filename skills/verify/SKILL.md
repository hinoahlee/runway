---
name: verify
description: Proves the change works. Runs the verify command and the relevant e2e specs, then opens every touched page in a headless browser and checks each acceptance criterion against what renders, saving screenshots. Loops until green.
disable-model-invocation: true
---

Prove the current change works. Commands specific to this repository (e2e, dev server, database) are in its
CLAUDE.md under "Checks". Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/config.mjs"` for `verifyCommand` and
`baseBranch` if you do not have them yet (`NOT-SET-UP`: tell the user to run `/runway:setup`).

1. **Checks.** Run the verify command **quietly**, from the repository root: send its output to a log in
   `.claude/logs/` (runway keeps this folder out of git) and print only the exit code and the last lines:
   `mkdir -p .claude/logs; <verify command> > .claude/logs/verify.log 2>&1; echo "exit $?"; tail -n 3 .claude/logs/verify.log`.
   Read more of the log (`tail -n 60`, or grep it for the errors) only when it fails. Then run the e2e specs
   relevant to the change, the same way and on every browser project the config defines: the ones covering the pages, routes or flows the diff
   (`git diff origin/<baseBranch>...HEAD --stat`) touches. Run the whole e2e suite if the change touches auth,
   routing, security headers or shared layout.
2. **In the browser.** Start the dev server in the background and wait until it answers with one command, not a
   shell loop: `curl --retry 60 --retry-delay 2 --retry-connrefused -sf -o /dev/null <url>`. Check every acceptance
   criterion with a visible result on each page the change touches. Drive each journey as **one Playwright script**
   through the `playwright` MCP server's run-code tool (`browser_run_code_unsafe`): navigate, perform the steps,
   assert what renders (`expect`-style checks that throw on failure), and save a screenshot of each page and state
   with `page.screenshot({ path })` to `.claude/screenshots/<branch>/<criterion>-<page>.png`, as an absolute path
   (runway keeps this folder out of git). Return only a short result, such as which assertions passed. Use single
   click, type and snapshot calls only to debug a script that fails. When you need the page's structure, save the
   snapshot to a file (the snapshot tool's `filename`) and grep it rather than reading it inline. Then stop the dev
   server and every process it started: stopping the background shell is not enough. On Windows,
   `taskkill /PID <pid> /T /F` on the server's process tree (`netstat -ano` shows the pid listening on the port);
   on macOS or Linux, `kill` each pid that `lsof -ti :<port>` prints, or `pkill -f "<dev server command>"`.
3. **Manual criteria.** Check each `[manual: ...]` criterion the way the spec says, and keep the command and its
   result (or a screenshot) as its proof. If it cannot be checked here, say so in the report.
4. **Loop until green.** On any failure, find the cause, fix it, and repeat from step 1.
   Never weaken, skip or delete a test, or loosen a check, to get green. If a test seems wrong, stop and ask the
   user, ending your message with a line `RUNWAY-ASK: <the question>` (runway's Stop hook then lets you stop with
   the change unfinished).

Report: each command and its result, each criterion with how it was checked (test name, screenshot path, or the
manual check and its result), and anything you could not check.
