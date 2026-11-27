import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { runHook } from "./run-hook.mjs";

const PASS = `node -e "process.exit(0)"`;
const FAIL = `node -e "for (let i = 1; i <= 100; i++) console.log('line ' + i); process.exit(1)"`;

let dir;
let repo;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
const configure = (verifyCommand) =>
	writeFileSync(path.join(repo, ".git", "runway.json"), JSON.stringify({ verifyCommand }));
const stop = (event = {}, env = {}) => runHook("stop-gate.mjs", { hook_event_name: "Stop", cwd: repo, ...event }, { env });

describe("stop-gate", () => {
	before(() => {
		dir = mkdtempSync(path.join(tmpdir(), "stop-gate-"));
		repo = path.join(dir, "repo");
		mkdirSync(repo);
		git(repo, "init", "-q");
		git(repo, "config", "user.email", "test@example.com");
		git(repo, "config", "user.name", "Test");
		writeFileSync(path.join(repo, "a.txt"), "one\n");
		git(repo, "add", ".");
		git(repo, "commit", "-qm", "init");
	});
	after(() => rmSync(dir, { recursive: true, force: true }));
	beforeEach(() => {
		git(repo, "checkout", "-q", "--", ".");
		git(repo, "clean", "-qfd");
		configure(FAIL);
	});

	test("lets Claude stop when the tree is clean, without running verify", () => {
		assert.equal(stop().code, 0);
	});

	test("does nothing where runway is not set up", () => {
		rmSync(path.join(repo, ".git", "runway.json"));
		writeFileSync(path.join(repo, "a.txt"), "two\n");
		assert.equal(stop().code, 0);
	});

	test("lets Claude stop when verify passes", () => {
		configure(PASS);
		writeFileSync(path.join(repo, "a.txt"), "two\n");
		assert.equal(stop().code, 0);
	});

	test("blocks with the last 60 lines when verify fails", () => {
		writeFileSync(path.join(repo, "a.txt"), "two\n");
		const { code, stderr } = stop();
		assert.equal(code, 2);
		assert.match(stderr, /failed \(attempt 1 of 3\)\. Fix the cause/);
		assert.match(stderr, /line 100/);
		assert.match(stderr, /line 41\b/);
		assert.doesNotMatch(stderr, /line 40\b/);
	});

	test("a new, untracked file counts as a change", () => {
		writeFileSync(path.join(repo, "new.ts"), "export {};\n");
		assert.equal(stop().code, 2);
	});

	test("keeps blocking while verify fails, up to 3 times in a row, then lets Claude stop with a note", () => {
		writeFileSync(path.join(repo, "a.txt"), "two\n");
		assert.match(stop().stderr, /attempt 1 of 3/);
		assert.match(stop({ stop_hook_active: true }).stderr, /attempt 2 of 3/);
		assert.match(stop({ stop_hook_active: true }).stderr, /attempt 3 of 3/);
		const last = stop({ stop_hook_active: true });
		assert.equal(last.code, 0);
		assert.match(JSON.parse(last.stdout).systemMessage, /still fails after 3 attempts/);
		// The next stop starts a new count.
		assert.match(stop().stderr, /attempt 1 of 3/);
	});

	test("a stop that is not a continuation starts the count again", () => {
		writeFileSync(path.join(repo, "a.txt"), "two\n");
		stop();
		stop({ stop_hook_active: true });
		assert.match(stop().stderr, /attempt 1 of 3/);
	});

	test("in a worktree, checks the worktree, not the clean main checkout CLAUDE_PROJECT_DIR points to", () => {
		const wt = path.join(dir, "wt");
		git(repo, "worktree", "add", "-q", "-b", "feature", wt);
		try {
			writeFileSync(path.join(wt, "a.txt"), "changed in the worktree\n");
			const { code } = stop({ cwd: wt }, { CLAUDE_PROJECT_DIR: repo });
			assert.equal(code, 2);
		} finally {
			git(repo, "worktree", "remove", "--force", wt);
		}
	});

	describe("lets Claude stop on purpose to ask", () => {
		test("a RUNWAY-ASK line in the event's last message skips verify", () => {
			writeFileSync(path.join(repo, "a.txt"), "two\n");
			const message = "The test expects 3 but the spec says 4.\nRUNWAY-ASK: which one is right?";
			assert.equal(stop({ last_assistant_message: message }).code, 0);
		});

		test("a RUNWAY-STOP line from an unattended run skips verify too", () => {
			writeFileSync(path.join(repo, "a.txt"), "two\n");
			assert.equal(stop({ last_assistant_message: "`RUNWAY-STOP: add STRIPE_KEY`" }).code, 0);
		});

		test("reads the last message from the transcript when the event has none", () => {
			writeFileSync(path.join(repo, "a.txt"), "two\n");
			const transcript = path.join(dir, "transcript.jsonl");
			const entry = (type, content) => JSON.stringify({ type, message: { role: type, content } });
			writeFileSync(
				transcript,
				[
					entry("user", "fix it"),
					entry("assistant", [{ type: "text", text: "RUNWAY-ASK: an old question" }]),
					entry("user", "keep going"),
					entry("assistant", [{ type: "text", text: "Which table should own it?\nRUNWAY-ASK: users or accounts?" }]),
					entry("assistant", [{ type: "tool_use", id: "x", name: "Read", input: {} }]),
				].join("\n"),
			);
			assert.equal(stop({ transcript_path: transcript }).code, 0);
			writeFileSync(transcript, [entry("assistant", [{ type: "text", text: "RUNWAY-ASK: old" }]), entry("assistant", [{ type: "text", text: "All done." }])].join("\n"));
			assert.equal(stop({ transcript_path: transcript }).code, 2);
		});

		test("a marker mentioned inside a sentence does not count", () => {
			writeFileSync(path.join(repo, "a.txt"), "two\n");
			assert.equal(stop({ last_assistant_message: "Done; I did not need RUNWAY-ASK: here." }).code, 2);
		});
	});

	describe("leaves the user's own work in progress alone", () => {
		const session = "11111111-2222-3333-4444-555555555555";
		const startSession = (source = "startup") =>
			runHook("session-start.mjs", { hook_event_name: "SessionStart", cwd: repo, session_id: session, source });
		beforeEach(() => rmSync(path.join(repo, ".git", "runway", "baseline"), { recursive: true, force: true }));

		test("changes that were there when the session started do not run verify", () => {
			writeFileSync(path.join(repo, "a.txt"), "the user's half-done work\n");
			startSession();
			assert.equal(stop({ session_id: session }).code, 0);
		});

		test("once Claude changes anything, verify runs", () => {
			writeFileSync(path.join(repo, "a.txt"), "the user's half-done work\n");
			startSession();
			writeFileSync(path.join(repo, "b.txt"), "Claude's change\n");
			assert.equal(stop({ session_id: session }).code, 2);
		});

		test("a resumed session keeps the tree it first found", () => {
			writeFileSync(path.join(repo, "a.txt"), "the user's half-done work\n");
			startSession();
			writeFileSync(path.join(repo, "a.txt"), "Claude edited it\n");
			startSession("resume");
			startSession("startup");
			assert.equal(stop({ session_id: session }).code, 2);
		});

		test("another session's record does not count", () => {
			writeFileSync(path.join(repo, "a.txt"), "the user's half-done work\n");
			startSession();
			assert.equal(stop({ session_id: "another-session" }).code, 2);
		});
	});

	describe("remembers a passing tree", () => {
		let counter;
		let log;
		const runs = () => (existsSync(log) ? readFileSync(log, "utf8").length : 0);

		before(() => {
			// A verify command that passes and counts its runs, in a file outside the repository.
			counter = path.join(dir, "count.cjs");
			log = path.join(dir, "runs.log");
			writeFileSync(counter, `require("node:fs").appendFileSync(${JSON.stringify(log)}, "x");`);
		});
		beforeEach(() => {
			configure(`node "${counter}"`);
			rmSync(log, { force: true });
		});

		test("an unchanged tree skips verify the second time", () => {
			writeFileSync(path.join(repo, "a.txt"), "cached\n");
			assert.equal(stop().code, 0);
			assert.equal(stop().code, 0);
			assert.equal(runs(), 1);
		});

		test("any edit runs it again", () => {
			writeFileSync(path.join(repo, "a.txt"), "first\n");
			stop();
			writeFileSync(path.join(repo, "a.txt"), "second\n");
			stop();
			assert.equal(runs(), 2);
		});

		test("a new file, or an edit to an untracked one, runs it again", () => {
			writeFileSync(path.join(repo, "a.txt"), "base\n");
			stop();
			writeFileSync(path.join(repo, "new.ts"), "export const a = 1;\n");
			stop();
			writeFileSync(path.join(repo, "new.ts"), "export const a = 2;\n");
			stop();
			assert.equal(runs(), 3);
		});

		test("a new commit runs it again", () => {
			writeFileSync(path.join(repo, "a.txt"), "committed soon\n");
			writeFileSync(path.join(repo, "b.txt"), "still changed\n");
			stop();
			git(repo, "add", "a.txt");
			git(repo, "commit", "-qm", "a");
			stop();
			assert.equal(runs(), 2);
			git(repo, "reset", "-q", "HEAD~1");
		});

		test("another verify command runs it again; a failure is never remembered", () => {
			writeFileSync(path.join(repo, "a.txt"), "command\n");
			stop();
			configure(FAIL);
			assert.equal(stop().code, 2);
			assert.equal(stop().code, 2);
		});
	});
});
