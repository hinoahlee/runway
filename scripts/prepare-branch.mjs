// Run by spec, epic-plan and epic-next before any work: puts the repository's checkout on the branch the work
// belongs on. It never carries uncommitted changes from one branch to another.
//
//   node prepare-branch.mjs <branch> [--base main] [--new]
//
// <branch> is a short name for the task (made safe here) or an epic's epic/<slug>. --new is for work that starts
// now: the branch must not exist yet, locally or on origin, and is created from origin/<base>. Without it, the branch
// is the local one, else the one on origin.
//
// The last line printed is the verdict; the skill acts on it:
//   ON <branch>     the checkout is on <branch>, fast-forwarded to what was pushed when it can be
//   STOP <reason>   nothing changed; tell the user why
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function branchName(name) {
	const safe = String(name ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9._/-]+/g, "-")
		.replace(/\/{2,}/g, "/")
		.replace(/(^|\/)[-.]+|[-.]+(\/|$)/g, "$1$2")
		.replace(/^\/+|\/+$/g, "")
		.slice(0, 60);
	return safe || "work";
}

export function prepare({ cwd, name, base = "main", fresh = false }) {
	const git = (args) => {
		const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
		return { ok: r.status === 0 && !r.error, out: (r.stdout ?? "").trim() };
	};
	const branch = branchName(name);

	if (!git(["rev-parse", "--show-toplevel"]).ok) return "STOP this is not a git repository.";
	git(["fetch", "--quiet", "origin"]);
	if (!git(["rev-parse", "--verify", "--quiet", `origin/${base}`]).ok)
		return `STOP origin/${base} does not exist: check the remote and baseBranch in runway.json.`;

	const onOrigin = git(["rev-parse", "--verify", "--quiet", `origin/${branch}`]).ok;
	const catchUp = () => onOrigin && git(["merge", "--ff-only", "--quiet", `origin/${branch}`]);

	const current = git(["branch", "--show-current"]).out;
	if (current === branch) {
		catchUp();
		return `ON ${branch}`;
	}
	// Tracked changes only: untracked files (scratch notes, local tools) stay where they are and do not block.
	if (git(["status", "--porcelain", "--untracked-files=no"]).out !== "")
		return `STOP the checkout has uncommitted changes on ${current || "a detached HEAD"}. Commit, stash or discard them first, then run the command again.`;

	const local = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
	if (fresh) {
		if (local || onOrigin)
			return `STOP ${branch} already exists${local ? "" : " on origin"}: pick another name, or continue that work on it.`;
		if (!git(["switch", "--quiet", "--no-track", "-c", branch, `origin/${base}`]).ok) return `STOP could not create ${branch}.`;
		return `ON ${branch}`;
	}
	if (local) {
		if (!git(["switch", "--quiet", branch]).ok) return `STOP could not switch to ${branch}.`;
		catchUp();
		return `ON ${branch}`;
	}
	if (onOrigin) {
		if (!git(["switch", "--quiet", "--track", "-c", branch, `origin/${branch}`]).ok) return `STOP could not switch to ${branch}.`;
		return `ON ${branch}`;
	}
	return `STOP ${branch} does not exist, locally or on origin.`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const args = process.argv.slice(2);
	const at = args.indexOf("--base");
	const base = at >= 0 ? args[at + 1] : "main";
	const name = args.find((a, j) => !a.startsWith("--") && args[j - 1] !== "--base");
	if (!name) {
		console.log("STOP no branch name given.");
		process.exit(1);
	}
	console.log(prepare({ cwd: process.cwd(), name, base: base || "main", fresh: args.includes("--new") }));
}
