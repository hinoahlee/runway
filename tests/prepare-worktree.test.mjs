import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { prepare, slugify } from "../scripts/prepare-worktree.mjs";

let dir;
let origin;
let main;
let fakeGh;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const wt = (name) => path.join(main, ".claude", "worktrees", name);
const addWorktree = (name) => git(main, "worktree", "add", "-q", "-b", name, wt(name), "origin/main");
const logs = [];
const run = (cwd, extra = {}) =>
	prepare({ cwd, name: "Fix the Login!", base: "main", gh: [process.execPath, fakeGh], log: (l) => logs.push(l), ...extra });

describe("prepare-worktree", () => {
	beforeEach(() => {
		logs.length = 0;
		dir = mkdtempSync(path.join(tmpdir(), "prep-wt-"));
		origin = path.join(dir, "origin.git");
		main = path.join(dir, "main");
		git(dir, "init", "-q", "--bare", "-b", "main", origin);
		git(dir, "clone", "-q", origin, main);
		git(main, "config", "user.email", "t@example.com");
		git(main, "config", "user.name", "T");
		writeFileSync(path.join(main, "a.txt"), "one\n");
		git(main, "add", ".");
		git(main, "commit", "-qm", "init");
		git(main, "push", "-q", "origin", "HEAD:main");
		// A fake `gh pr list --head <branch>`: answers from FAKE_GH, or fails when FAKE_GH is "fail".
		fakeGh = path.join(dir, "gh.mjs");
		writeFileSync(
			fakeGh,
			`const m = JSON.parse(process.env.FAKE_GH || "{}"); if (m === "fail") process.exit(1);
			 const b = process.argv[process.argv.indexOf("--head") + 1];
			 console.log(JSON.stringify((m[b] ?? []).map((pr) => (typeof pr === "string" ? { state: pr } : pr))));`,
		);
		process.env.FAKE_GH = "{}";
	});
	afterEach(() => {
		execFileSync("git", ["worktree", "prune"], { cwd: main });
		rmSync(dir, { recursive: true, force: true });
	});

	test("main checkout, clean: ENTER with a safe name", () => {
		assert.equal(run(main), "ENTER fix-the-login");
	});

	test("main checkout: untracked files do not block", () => {
		writeFileSync(path.join(main, "notes.txt"), "scratch\n");
		assert.equal(run(main), "ENTER fix-the-login");
	});

	test("main checkout with uncommitted changes: STOP, nothing created", () => {
		writeFileSync(path.join(main, "a.txt"), "changed\n");
		assert.match(run(main), /^STOP the main checkout has uncommitted changes/);
		assert.equal(existsSync(path.join(main, ".claude", "worktrees")), false);
	});

	test("a taken name gets a suffix", () => {
		addWorktree("fix-the-login");
		assert.equal(run(main), "ENTER fix-the-login-2");
	});

	test("a fresh worktree: STAY, fast-forwarded to the latest origin/main", () => {
		addWorktree("fresh");
		writeFileSync(path.join(main, "b.txt"), "two\n");
		git(main, "add", ".");
		git(main, "commit", "-qm", "second");
		git(main, "push", "-q", "origin", "HEAD:main");
		assert.equal(run(wt("fresh")), "STAY");
		assert.equal(git(wt("fresh"), "rev-parse", "HEAD"), git(main, "rev-parse", "origin/main"));
	});

	test("a worktree with commits of its own: IN-USE, never a new worktree", () => {
		addWorktree("busy");
		writeFileSync(path.join(wt("busy"), "c.txt"), "work\n");
		git(wt("busy"), "add", ".");
		git(wt("busy"), "commit", "-qm", "work");
		assert.equal(run(wt("busy")), "IN-USE busy");
	});

	test("a new worktree started from another branch's commits: moved onto origin/main, STAY", () => {
		git(main, "switch", "-q", "-c", "side");
		writeFileSync(path.join(main, "side.txt"), "side work\n");
		git(main, "add", ".");
		git(main, "commit", "-qm", "side work");
		// What a worktree created from the main checkout's HEAD looks like.
		git(main, "worktree", "add", "-q", "-b", "fresh", wt("fresh"), "HEAD");
		writeFileSync(path.join(wt("fresh"), "notes.txt"), "untracked scratch\n");
		assert.equal(run(wt("fresh")), "STAY");
		assert.equal(git(wt("fresh"), "rev-parse", "HEAD"), git(main, "rev-parse", "origin/main"));
		assert.ok(existsSync(path.join(wt("fresh"), "notes.txt")));
		assert.equal(git(main, "rev-list", "--count", "origin/main..side"), "1");
	});

	test("a worktree with uncommitted changes: IN-USE", () => {
		addWorktree("editing");
		writeFileSync(path.join(wt("editing"), "a.txt"), "edit\n");
		assert.equal(run(wt("editing")), "IN-USE editing");
	});

	test("cleanup removes only clean worktrees whose PR is merged or closed", () => {
		for (const n of ["merged", "closed", "open", "unsaved", "no-pr", "current"]) addWorktree(n);
		writeFileSync(path.join(wt("unsaved"), "draft.txt"), "keep me\n");
		process.env.FAKE_GH = JSON.stringify({
			merged: ["MERGED"],
			closed: ["CLOSED"],
			open: ["OPEN"],
			unsaved: ["MERGED"],
			current: ["MERGED"],
		});
		assert.equal(run(wt("current")), "STAY");
		assert.equal(existsSync(wt("merged")), false);
		assert.equal(existsSync(wt("closed")), false);
		for (const kept of ["open", "unsaved", "no-pr", "current"]) assert.equal(existsSync(wt(kept)), true, kept);
		assert.equal(logs.length, 2);
		assert.throws(() => git(main, "rev-parse", "--verify", "merged"));
	});

	test("cleanup keeps a closed PR's worktree whose branch has commits that are not pushed", () => {
		addWorktree("later");
		writeFileSync(path.join(wt("later"), "c.txt"), "after the PR closed\n");
		git(wt("later"), "add", ".");
		git(wt("later"), "commit", "-qm", "local only");
		process.env.FAKE_GH = JSON.stringify({ later: ["CLOSED"] });
		run(main);
		assert.equal(existsSync(wt("later")), true);
		assert.equal(logs.length, 0);
	});

	test("cleanup removes a merged worktree whose remote branch is gone but whose tip is the PR's head", () => {
		addWorktree("squashed");
		writeFileSync(path.join(wt("squashed"), "c.txt"), "pushed, then the branch was deleted on merge\n");
		git(wt("squashed"), "add", ".");
		git(wt("squashed"), "commit", "-qm", "work");
		const tip = git(wt("squashed"), "rev-parse", "HEAD");
		process.env.FAKE_GH = JSON.stringify({ squashed: [{ state: "MERGED", headRefOid: tip }] });
		run(main);
		assert.equal(existsSync(wt("squashed")), false);
	});

	describe("locked worktrees", () => {
		// A process that has already exited: its pid is no longer running.
		const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid;
		const lock = (name, reason) => git(main, "worktree", "lock", "--reason", reason, wt(name));
		const merged = (...names) => {
			for (const n of names) addWorktree(n);
			process.env.FAKE_GH = JSON.stringify(Object.fromEntries(names.map((n) => [n, ["MERGED"]])));
		};

		test("a Claude session lock whose process has ended is unlocked and removed", () => {
			merged("ended");
			lock("ended", `claude session ended (pid ${deadPid()})`);
			run(main);
			assert.equal(existsSync(wt("ended")), false);
			assert.equal(logs.length, 1);
		});

		test("a Claude session lock whose process is running keeps the worktree, still locked", () => {
			merged("running");
			lock("running", `claude session running (pid ${process.pid})`);
			run(main);
			assert.equal(existsSync(wt("running")), true);
			assert.match(git(main, "worktree", "list", "--porcelain"), /^locked claude session running/m);
		});

		test("any other lock keeps the worktree", () => {
			merged("on-usb", "no-reason");
			lock("on-usb", "on a removable drive");
			git(main, "worktree", "lock", wt("no-reason"));
			run(main);
			assert.equal(existsSync(wt("on-usb")), true);
			assert.equal(existsSync(wt("no-reason")), true);
			assert.equal(logs.length, 0);
		});
	});

	test("without a working gh, nothing is removed", () => {
		addWorktree("merged");
		process.env.FAKE_GH = JSON.stringify("fail");
		assert.equal(run(main), "ENTER fix-the-login");
		assert.equal(existsSync(wt("merged")), true);
	});

	describe("--branch", () => {
		const onBranch = (cwd) => run(cwd, { branch: "epic/notes" });

		test("a fresh worktree takes the new branch's name", () => {
			addWorktree("epic-notes");
			assert.equal(onBranch(wt("epic-notes")), "STAY");
			assert.equal(git(wt("epic-notes"), "branch", "--show-current"), "epic/notes");
			assert.throws(() => git(main, "rev-parse", "--verify", "refs/heads/epic-notes"));
		});

		test("a fresh worktree switches to the pushed branch and drops its temporary one", () => {
			git(main, "push", "-q", "origin", "HEAD:refs/heads/epic/notes");
			addWorktree("epic-notes");
			assert.equal(onBranch(wt("epic-notes")), "STAY");
			assert.equal(git(wt("epic-notes"), "branch", "--show-current"), "epic/notes");
			assert.throws(() => git(main, "rev-parse", "--verify", "refs/heads/epic-notes"));
		});

		test("a worktree already on the branch: STAY, even with work in it", () => {
			git(main, "worktree", "add", "-q", "-b", "epic/notes", wt("epic-notes"), "origin/main");
			writeFileSync(path.join(wt("epic-notes"), "c.txt"), "slice\n");
			git(wt("epic-notes"), "add", ".");
			git(wt("epic-notes"), "commit", "-qm", "slice 1");
			assert.equal(onBranch(wt("epic-notes")), "STAY");
		});

		test("from the main checkout while the branch is open elsewhere: STOP, nothing created", () => {
			git(main, "worktree", "add", "-q", "-b", "epic/notes", wt("epic-notes"), "origin/main");
			assert.match(onBranch(main), /^STOP epic\/notes is already open in /);
		});

		test("a worktree holding other work: IN-USE", () => {
			addWorktree("busy");
			writeFileSync(path.join(wt("busy"), "c.txt"), "work\n");
			git(wt("busy"), "add", ".");
			git(wt("busy"), "commit", "-qm", "work");
			assert.equal(onBranch(wt("busy")), "IN-USE busy");
		});
	});

	test("outside a git repository: STOP", () => {
		assert.match(run(dir), /^STOP this is not a git repository/);
	});

	test("slugify", () => {
		assert.equal(slugify("Plan: Notes v2!"), "plan-notes-v2");
		assert.equal(slugify(""), "work");
	});
});
