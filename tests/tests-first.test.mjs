import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { classifier, commitProblem, testsOnly } from "../scripts/tests-first.mjs";
import { runHook } from "./run-hook.mjs";

const kind = classifier();

describe("tests first: rules", () => {
	test("tells tests, docs and code apart", () => {
		for (const f of ["src/a.test.ts", "apps/api/x.spec.tsx", "e2e/scripts/fake-bucket.ts", "pkg/__tests__/a.js", "tests/run.mjs"])
			assert.equal(kind(f), "test", f);
		for (const f of ["docs/epics/a.md", "README.md"]) assert.equal(kind(f), "neutral", f);
		for (const f of ["src/a.ts", "apps/web/package.json", "src/testing/config.ts"]) assert.equal(kind(f), "code", f);
	});

	test("a commit never mixes tests and code", () => {
		assert.match(commitProblem({ files: ["src/a.ts", "src/a.test.ts"], kind, testsCommitted: true }), /mixes tests/);
	});

	test("code waits for a tests-only commit, unless the message says [no-tests]", () => {
		assert.match(commitProblem({ files: ["src/a.ts"], kind, testsCommitted: false }), /before any tests/);
		assert.equal(commitProblem({ files: ["src/a.ts"], kind, testsCommitted: true }), undefined);
		assert.equal(commitProblem({ files: ["src/a.ts"], kind, testsCommitted: false, message: 'git commit -m "chore: bump [no-tests] config only"' }), undefined);
	});

	test("tests alone, and docs alone, are always fine", () => {
		assert.equal(commitProblem({ files: ["src/a.test.ts"], kind, testsCommitted: false }), undefined);
		assert.equal(commitProblem({ files: ["docs/epics/a.md"], kind, testsCommitted: false }), undefined);
		assert.equal(testsOnly(["src/a.test.ts", "docs/a.md"], kind), true);
		assert.equal(testsOnly(["docs/a.md"], kind), false);
	});
});

describe("tests first: the commit guard", () => {
	let dir;
	const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
	const commit = (command) =>
		runHook("guard-bash.mjs", { hook_event_name: "PreToolUse", tool_name: "Bash", cwd: dir, tool_input: { command } });
	const write = (file, text = "x") => {
		mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		writeFileSync(path.join(dir, file), text);
	};

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "runway-tests-first-"));
		git("init", "-q", "-b", "main");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "t");
		write(".claude/runway.json", JSON.stringify({ verifyCommand: "true" }));
		write("src/a.ts");
		git("add", "-A");
		git("commit", "-qm", "init");
		git("switch", "-qc", "epic/notes");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("blocks code before tests, then lets it through once the failing tests are committed", () => {
		write("src/a.ts", "changed");
		assert.match(commit("git add -A && git commit -m 'feat: a'").stderr, /before any tests/);
		write("src/a.test.ts");
		assert.match(commit("git add -A && git commit -m 'feat: a'").stderr, /mixes tests/);
		assert.equal(commit("git add src/a.test.ts && git commit -m 'test: a (red)'").code, 0);
		git("add", "src/a.test.ts");
		git("commit", "-qm", "test: a (red)");
		assert.equal(commit("git commit -am 'feat: a'").code, 0);
	});

	test("a finished slice starts the next unit of work: its code needs new tests", () => {
		write("src/a.test.ts");
		git("add", "-A");
		git("commit", "-qm", "test: a (red)");
		write("docs/epics/notes.md");
		git("add", "-A");
		git("commit", "-qm", "docs: finish notes slice 1");
		write("src/b.ts");
		assert.match(commit("git add -A && git commit -m 'feat: b'").stderr, /before any tests/);
	});

	const redCommit = () => {
		write("src/a.test.ts");
		git("add", "src/a.test.ts");
		git("commit", "-qm", "test: a (red)");
	};

	test("closes the ways around it: amend, paths, add -u, cd, globs", () => {
		redCommit();
		write("src/a.ts", "changed");
		git("add", "src/a.ts");
		assert.match(commit("git commit --amend --no-edit").stderr, /mixes tests/);
		git("restore", "--staged", "src/a.ts");
		assert.match(commit("git commit src/a.ts -m x").stderr, /commit with paths/);
		assert.match(commit("git commit -m x -- src/a.ts").stderr, /commit with paths/);
		assert.match(commit("git add src/*.ts && git commit -m x").stderr, /glob/);
		write("src/a.test.ts", "changed too");
		assert.match(commit("git add -u && git commit -m x").stderr, /mixes tests/);
		assert.match(commit("cd src && git add a.ts a.test.ts && git commit -m x").stderr, /mixes tests/);
		assert.match(commit("git add ./src/a.ts ./src/a.test.ts && git commit -m x").stderr, /mixes tests/);
	});

	test("a message that mentions a flag is only a message", () => {
		redCommit();
		write("src/a.test.ts", "changed");
		write("src/a.ts", "changed");
		git("add", "src/a.ts");
		assert.equal(commit('git commit -m "feat: drop the -a flag"').code, 0);
	});

	test("the epic plan's skipped acceptance test doesn't unlock code; snapshots are neither", () => {
		write("e2e/accept.spec.ts");
		git("add", "-A");
		git("commit", "-qm", "docs: plan the notes epic");
		write("src/a.ts", "changed");
		git("add", "src/a.ts");
		assert.match(commit("git commit -m 'feat: a'").stderr, /before any tests/);
		redCommit();
		write("src/__snapshots__/a.test.ts.snap");
		assert.equal(commit("git add src/__snapshots__ && git commit -m 'feat: a'").code, 0);
	});

	test("[no-tests] in a message file counts", () => {
		write("src/a.ts", "changed");
		git("add", "src/a.ts");
		write("msg.txt", "chore: config [no-tests] nothing to test");
		assert.equal(commit("git commit -F msg.txt").code, 0);
	});

	test("leaves the base branch alone", () => {
		git("switch", "-q", "main");
		write("src/a.ts", "changed");
		assert.equal(commit("git commit -am 'fix: a'").code, 0);
	});
});
