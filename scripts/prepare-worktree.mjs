// Run by spec, epic-plan and epic-next before any work: decides where the work happens, and tidies up old
// worktrees. It changes nothing in the folder you are in, and never moves you out of a worktree.
//
//   node prepare-worktree.mjs <suggested-name> [--base main] [--branch <branch>]
//
// --branch puts the work on that branch (an epic's epic/<slug>): a fresh worktree switches to it (or takes the name
// when it does not exist yet), and a worktree already on it is where the work continues.
//
// The last line printed is the verdict; the skill acts on it:
//   ENTER <name>      main checkout, no uncommitted changes: create a worktree named <name> (EnterWorktree)
//   STAY              a fresh worktree (no work of its own yet), now up to date with origin/<base>
//   IN-USE <branch>   a worktree that already holds work on <branch>: stay here, never create another
//   STOP <reason>     do nothing; tell the user why
//
// Before the verdict, it removes worktrees under .claude/worktrees/ whose PR is merged or closed, that have no
// changes, and that are not the current folder. Locked worktrees stay, except for a Claude session's lock whose process
// has ended. Each removal prints "REMOVED <path> (<branch>)".
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function slugify(name) {
	const slug = String(name ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 50);
	return slug || "work";
}

function run(program, args, cwd) {
	const r = spawnSync(program[0], [...program.slice(1), ...args], { cwd, encoding: "utf8", windowsHide: true });
	return { ok: r.status === 0 && !r.error, out: (r.stdout ?? "").trim() };
}

export function prepare({ cwd, name, base = "main", branch: wanted, gh = ["gh"], log = console.log }) {
	const git = (args, at = cwd) => run(["git"], args, at);

	const top = git(["rev-parse", "--show-toplevel"]);
	if (!top.ok) return "STOP this is not a git repository.";
	const gitDir = git(["rev-parse", "--absolute-git-dir"]).out;
	const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).out;
	const inMainCheckout = path.resolve(gitDir) === path.resolve(commonDir);
	const root = path.dirname(commonDir);
	const here = path.resolve(top.out);

	git(["fetch", "--quiet", "origin"]);
	const hasBase = git(["rev-parse", "--verify", "--quiet", `origin/${base}`]).ok;
	if (!hasBase) return `STOP origin/${base} does not exist: check the remote and baseBranch in runway.json.`;

	cleanup({ git, gh, root, here, log });

	// Tracked changes only: untracked files (scratch notes, local tools) stay where they are and do not block.
	const dirty = git(["status", "--porcelain", "--untracked-files=no"]).out !== "";

	if (inMainCheckout) {
		if (dirty)
			return "STOP the main checkout has uncommitted changes. Commit, stash or discard them first, then run the command again.";
		const holder = wanted && worktreeOn(git, root, wanted);
		if (holder) return `STOP ${wanted} is already open in ${holder}: continue in a session there.`;
		let candidate = slugify(name);
		for (let i = 2; existsSync(path.join(root, ".claude", "worktrees", candidate)); i++)
			candidate = `${slugify(name)}-${i}`;
		return `ENTER ${candidate}`;
	}

	// Inside a worktree: never leave it. Fresh means no commits of its own and no changes.
	const branch = git(["branch", "--show-current"]).out || "(detached)";
	if (wanted && branch === wanted) {
		// Pick up what another session pushed; a diverged branch is left for the skill to deal with.
		if (git(["rev-parse", "--verify", "--quiet", `origin/${wanted}`]).ok) git(["merge", "--ff-only", "--quiet", `origin/${wanted}`]);
		return "STAY";
	}
	const ownCommits = git(["rev-list", "--count", `origin/${base}..HEAD`]).out;
	if (!dirty && ownCommits === "0") {
		git(["merge", "--ff-only", "--quiet", `origin/${base}`]);
		if (wanted) return useBranch(git, root, branch, wanted);
		return "STAY";
	}
	// Just created and never committed to, but started from another commit than origin/<base> (the main checkout was
	// on another branch, or ahead of the remote): move it onto origin/<base>, keeping untracked files.
	if (!dirty && branch !== "(detached)" && justCreated(git, branch)) {
		if (!git(["reset", "--keep", "--quiet", `origin/${base}`]).ok) return `IN-USE ${branch}`;
		if (wanted) return useBranch(git, root, branch, wanted);
		return "STAY";
	}
	return `IN-USE ${branch}`;
}

// A branch whose reflog holds only its creation: nothing was committed, reset or merged on it since.
function justCreated(git, branch) {
	const reflog = git(["reflog", "show", "--format=%gs", `refs/heads/${branch}`]);
	const entries = reflog.out.split(/\r?\n/).filter(Boolean);
	return reflog.ok && entries.length === 1 && /^branch: Created from/.test(entries[0]);
}

// The worktree that has <branch> checked out, if any.
function worktreeOn(git, root, branch) {
	const list = git(["worktree", "list", "--porcelain"], root).out;
	for (const block of list.split(/\r?\n\r?\n/)) {
		if (block.match(/^branch refs\/heads\/(.+)$/m)?.[1] === branch) return block.match(/^worktree (.+)$/m)?.[1];
	}
	return undefined;
}

// A fresh worktree moves onto <wanted>: the local branch, else the remote one, else a new branch here.
function useBranch(git, root, current, wanted) {
	const holder = worktreeOn(git, root, wanted);
	if (holder) return `STOP ${wanted} is already open in ${holder}: continue in a session there.`;
	if (git(["rev-parse", "--verify", "--quiet", `refs/heads/${wanted}`]).ok) {
		if (!git(["switch", "--quiet", wanted]).ok) return `STOP could not switch to ${wanted}.`;
		git(["merge", "--ff-only", "--quiet", `origin/${wanted}`]);
	} else if (git(["rev-parse", "--verify", "--quiet", `origin/${wanted}`]).ok) {
		if (!git(["switch", "--quiet", "--track", "-c", wanted, `origin/${wanted}`]).ok) return `STOP could not switch to ${wanted}.`;
	} else {
		if (!git(["branch", "-m", wanted]).ok) return `STOP could not name the branch ${wanted}.`;
		return "STAY";
	}
	if (current !== "(detached)") git(["branch", "-D", current]);
	return "STAY";
}

// Whether every commit on <branch> is safe elsewhere: on a remote-tracking branch, or in a PR's head (GitHub keeps
// it after the branch is deleted on merge).
function pushed(git, root, branch, heads) {
	const tip = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root).out;
	if (!tip) return false;
	if (git(["for-each-ref", "--contains", tip, "--format=%(refname)", "refs/remotes"], root).out !== "") return true;
	return heads.some((head) => git(["merge-base", "--is-ancestor", tip, head], root).ok);
}

// Whether a process with this pid is running. EPERM means it runs but belongs to someone else.
function running(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e.code === "EPERM";
	}
}

// Claude Code locks a worktree it enters with "claude session <name> (pid N)" and leaves the lock behind when that
// session ends. Such a lock whose process has exited is stale; every other lock means someone wants the worktree kept.
function staleSessionLock(block) {
	const pid = block.match(/^locked claude session .* \(pid (\d+)\)$/m)?.[1];
	return pid !== undefined && !running(Number(pid));
}

function cleanup({ git, gh, root, here, log }) {
	const list = git(["worktree", "list", "--porcelain"], root);
	if (!list.ok) return;
	const managed = path.resolve(root, ".claude", "worktrees");
	for (const block of list.out.split(/\r?\n\r?\n/)) {
		const where = block.match(/^worktree (.+)$/m)?.[1];
		const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1];
		if (!where || !branch) continue;
		const full = path.resolve(where);
		if (full === here || !full.startsWith(managed + path.sep)) continue;
		const locked = /^locked/m.test(block);
		if (locked && !staleSessionLock(block)) continue;
		// Anything unsaved, untracked files included, keeps the worktree.
		if (git(["status", "--porcelain"], full).out !== "") continue;
		const prs = run(gh, ["pr", "list", "--state", "all", "--head", branch, "--json", "state,headRefOid"], root);
		if (!prs.ok) return; // no gh, or not signed in: skip the cleanup entirely
		let list = [];
		try {
			list = JSON.parse(prs.out || "[]");
		} catch {
			continue;
		}
		const states = list.map((p) => p.state);
		if (states.length === 0 || states.includes("OPEN")) continue;
		// Commits made after the PR closed (or never pushed) keep the worktree: deleting the branch would lose them.
		if (!pushed(git, root, branch, list.map((p) => p.headRefOid).filter(Boolean))) continue;
		// Unlock only now, once the worktree is certain to go, so a worktree that stays keeps its lock.
		if (locked && !git(["worktree", "unlock", full], root).ok) continue;
		// Without --force, git itself refuses a worktree with changes.
		if (!git(["worktree", "remove", full], root).ok) continue;
		git(["branch", "-D", branch], root);
		log(`REMOVED ${full} (${branch}, PR ${states.includes("MERGED") ? "merged" : "closed"})`);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const args = process.argv.slice(2);
	const value = (flag) => {
		const i = args.indexOf(flag);
		return i >= 0 ? args[i + 1] : undefined;
	};
	const base = value("--base") || "main";
	const branch = value("--branch");
	const name = args.find((a, j) => !a.startsWith("--") && !["--base", "--branch"].includes(args[j - 1]));
	const gh = process.env.RUNWAY_GH_BIN ? [process.execPath, process.env.RUNWAY_GH_BIN] : ["gh"];
	console.log(prepare({ cwd: process.cwd(), name, base, branch, gh }));
}
