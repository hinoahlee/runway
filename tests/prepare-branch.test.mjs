import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { branchName, prepare } from "../scripts/prepare-branch.mjs";

let dir;
let origin;
let repo;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const current = () => git(repo, "branch", "--show-current");
const run = (name, extra = {}) => prepare({ cwd: repo, name, base: "main", ...extra });

// A commit pushed to <branch> on origin from a second clone, so this checkout is behind it.
function pushFromElsewhere(branch, file) {
	const other = path.join(dir, `other-${file}`);
	git(dir, "clone", "-q", origin, other);
	git(other, "config", "user.email", "t@example.com");
	git(other, "config", "user.name", "T");
	git(other, "switch", "-q", ...(git(other, "branch", "-r").includes(`origin/${branch}`) ? [branch] : ["-c", branch]));
	writeFileSync(path.join(other, file), "from elsewhere\n");
	git(other, "add", ".");
	git(other, "commit", "-qm", file);
	git(other, "push", "-q", "origin", `HEAD:${branch}`);
}

describe("prepare-branch", () => {
	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "prep-branch-"));
		origin = path.join(dir, "origin.git");
		repo = path.join(dir, "repo");
		git(dir, "init", "-q", "--bare", "-b", "main", origin);
		git(dir, "clone", "-q", origin, repo);
		git(repo, "config", "user.email", "t@example.com");
		git(repo, "config", "user.name", "T");
		writeFileSync(path.join(repo, "a.txt"), "one\n");
		git(repo, "add", ".");
		git(repo, "commit", "-qm", "init");
		git(repo, "push", "-q", "origin", "HEAD:main");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("branch names are made safe; an epic's slash stays", () => {
		assert.equal(branchName("Fix the Login!"), "fix-the-login");
		assert.equal(branchName("epic/version-notes"), "epic/version-notes");
		assert.equal(branchName("  "), "work");
	});

	test("--new creates the branch from origin/<base>, not from the local base", () => {
		pushFromElsewhere("main", "b.txt");
		writeFileSync(path.join(repo, "notes.txt"), "untracked scratch\n");
		assert.equal(run("Fix the Login!", { fresh: true }), "ON fix-the-login");
		assert.equal(current(), "fix-the-login");
		assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "origin/main"));
		// It tracks nothing yet: ship pushes it with -u.
		assert.throws(() => git(repo, "rev-parse", "--abbrev-ref", "fix-the-login@{upstream}"));
	});

	test("uncommitted changes stop it, and nothing moves", () => {
		writeFileSync(path.join(repo, "a.txt"), "changed\n");
		assert.match(run("fix", { fresh: true }), /^STOP the checkout has uncommitted changes on main/);
		assert.equal(current(), "main");
		assert.equal(readFileSync(path.join(repo, "a.txt"), "utf8"), "changed\n");
	});

	test("--new refuses a branch that exists, locally or on origin", () => {
		git(repo, "branch", "taken");
		assert.match(run("taken", { fresh: true }), /^STOP taken already exists:/);
		pushFromElsewhere("epic/notes", "n.txt");
		assert.match(run("epic/notes", { fresh: true }), /^STOP epic\/notes already exists on origin/);
		assert.equal(current(), "main");
	});

	test("an epic's branch: taken from origin when there is no local one, tracking it", () => {
		pushFromElsewhere("epic/notes", "n.txt");
		assert.equal(run("epic/notes"), "ON epic/notes");
		assert.equal(git(repo, "rev-parse", "--abbrev-ref", "epic/notes@{upstream}"), "origin/epic/notes");
	});

	test("an epic's local branch is switched to and caught up with what was pushed", () => {
		pushFromElsewhere("epic/notes", "n.txt");
		run("epic/notes");
		git(repo, "switch", "-q", "main");
		pushFromElsewhere("epic/notes", "m.txt");
		assert.equal(run("epic/notes"), "ON epic/notes");
		assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "origin/epic/notes"));
	});

	test("already on the branch: continues there, even with changes", () => {
		git(repo, "switch", "-q", "-c", "fix");
		writeFileSync(path.join(repo, "a.txt"), "work in progress\n");
		assert.equal(run("fix", { fresh: true }), "ON fix");
		assert.equal(readFileSync(path.join(repo, "a.txt"), "utf8"), "work in progress\n");
	});

	test("a branch that exists nowhere, without --new: STOP", () => {
		assert.match(run("epic/missing"), /^STOP epic\/missing does not exist/);
	});

	test("a missing base branch: STOP", () => {
		assert.match(run("fix", { base: "develop", fresh: true }), /^STOP origin\/develop does not exist/);
	});
});
