// Tests first, checked at `git commit` (guard-bash calls checkCommit): tests are committed on their own, failing,
// before the code that makes them pass. So tests are written against the criteria, not fitted to code that exists.
//
//   1. A commit never mixes tests and code: the tests go first, in their own commit (runway:test-writer makes it).
//   2. Code is committed only once a tests-only commit exists in the current unit of work: since the last
//      "docs: finish <slug> slice <N>" commit on an epic branch, or since the branch left the base branch.
//      "[no-tests]" in the commit message lets a change with no testable behaviour through; reviewers check it.
//
// Docs and snapshots count as neither; deleting files counts as nothing. When a command's commit can't be read
// exactly (a pathspec, a glob in `git add`), it is blocked with a request to stage and commit separately.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { globToRegExp } from "./config.mjs";

export const TEST_PATHS = ["**/*.{test,spec}.*", "**/{test,tests,__tests__,e2e}/**"];
const NEUTRAL = ["**/*.{md,mdx,snap}", "**/__snapshots__/**", "**/*-snapshots/**"];
const MANIFESTS = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|go\.(mod|sum)|Cargo\.(toml|lock)|Gemfile(\.lock)?|composer\.(json|lock))$/;
const SEPARATELY =
	"Stage with `git add` in one command, then run `git commit` (no paths) in the next, so the commit can be checked for tests first.";

export function classifier(globs = TEST_PATHS) {
	const tests = globs.map(globToRegExp);
	const neutral = NEUTRAL.map(globToRegExp);
	return (file) => {
		const f = file.replaceAll("\\", "/");
		if (neutral.some((p) => p.test(f))) return "neutral";
		return tests.some((p) => p.test(f)) ? "test" : "code";
	};
}

// The reason to block this commit, or undefined. files: what it adds or changes; testsCommitted: whether a
// tests-only commit already exists in this unit of work; message: the commit's message (for "[no-tests]").
export function commitProblem({ files, kind, testsCommitted, message = "" }) {
	const tests = files.filter((f) => kind(f) === "test");
	const code = files.filter((f) => kind(f) === "code");
	const list = (xs) => xs.slice(0, 5).join(", ") + (xs.length > 5 ? ", ..." : "");
	if (tests.length > 0 && code.length > 0) {
		const deps = code.every((f) => MANIFESTS.test(f.replaceAll("\\", "/")))
			? ' A dependency change goes in its own commit first, with "[no-tests] <why>" in its message.'
			: "";
		return `Blocked: this commit mixes tests (${list(tests)}) and code (${list(code)}). Tests come first, on their own: commit the failing tests (runway:test-writer does this), then the code. Unstage one side (\`git restore --staged <files>\`) and commit them separately.${deps}`;
	}
	if (code.length > 0 && !testsCommitted && !/\[no-tests\]/i.test(message))
		return `Blocked: code (${list(code)}) before any tests. Run runway:test-writer first: it writes the failing tests for the criteria and commits them; then commit the code. If this change has no testable behaviour (config, a dependency, docs-like code), put "[no-tests] <why>" in the commit message (the reviewer checks it).`;
	return undefined;
}

// A commit (its added or changed files, and subject) that unlocks code: tests and no code, and not a planning or
// docs commit (epic-plan commits the skipped acceptance test, which proves nothing yet).
export const testsOnly = (files, kind, subject = "") =>
	!/^docs\b/i.test(subject) && files.some((f) => kind(f) === "test") && files.every((f) => kind(f) !== "code");

// ---- reading the command ----

// Options of `git commit` that take a value (as the next token, or attached).
const COMMIT_VALUE = new Set(["-m", "--message", "-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message", "--author", "--date", "-t", "--template", "--cleanup", "--fixup", "--squash", "--trailer", "--pathspec-from-file", "-S", "--gpg-sign"]);

// What a command's `git commit` would do: { dir, args, adds: [{ args }], problem }. segs: the command's segments,
// each a token list with multi-word quoted text removed; gitParts: guard-bash's parser. undefined: no commit.
export function readCommit(segs, gitParts, cwd) {
	let dir = cwd;
	const adds = [];
	for (const tokens of segs) {
		if (tokens[0] === "cd" && tokens[1]) {
			dir = path.resolve(dir, tokens[1]);
			continue;
		}
		const git = gitParts(tokens);
		if (!git) continue;
		const at = git.options.find((o) => o.startsWith("-C "));
		const here = at ? path.resolve(dir, at.slice(3)) : dir;
		if (["add", "stage", "rm", "mv"].includes(git.verb)) adds.push({ verb: git.verb, args: git.args, dir: here });
		if (git.verb !== "commit") continue;
		const positional = [];
		let all = false;
		let amend = false;
		let fileMessage;
		for (let i = 0; i < git.args.length; i++) {
			const a = git.args[i];
			if (a === "--") return { problem: `Blocked: a commit with paths. ${SEPARATELY}` };
			if (a === "--all") all = true;
			else if (a === "--amend") amend = true;
			else if (a === "-o" || a === "--only" || a === "-i" || a === "--include" || a.startsWith("--pathspec"))
				return { problem: `Blocked: a commit with paths. ${SEPARATELY}` };
			else if (/^-[a-zA-Z]+$/.test(a)) {
				if (a.slice(1).includes("a")) all = true;
				const last = a.at(-1);
				if (COMMIT_VALUE.has(`-${last}`)) {
					if (last === "F") fileMessage = git.args[i + 1];
					i++;
				}
			} else if (a.startsWith("--") && !a.includes("=") && COMMIT_VALUE.has(a)) {
				if (a === "--file") fileMessage = git.args[i + 1];
				i++;
			} else if (a.startsWith("--file=")) fileMessage = a.slice(7);
			else if (!a.startsWith("-")) positional.push(a);
		}
		if (positional.length > 0) return { problem: `Blocked: a commit with paths (${positional.join(" ")}). ${SEPARATELY}` };
		return { dir: here, all, amend, adds, fileMessage };
	}
	return undefined;
}

// ---- git ----

function git(cwd, args) {
	const r = spawnSync("git", ["-c", "core.quotepath=off", ...args], { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
	return r.status === 0 && !r.error ? r.stdout : undefined;
}
const lines = (text) => String(text ?? "").split(/\r?\n/).filter(Boolean);

// A merge, cherry-pick, revert, rebase or squash merge in progress: its commit is someone else's work, unchecked.
function finishingOther(dir) {
	return ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "SQUASH_MSG", "rebase-merge", "rebase-apply"].some((name) => {
		const p = lines(git(dir, ["rev-parse", "--git-path", name]))[0];
		return p && existsSync(path.resolve(dir, p));
	});
}

// Files a `git add` stages, from repository-relative changed paths. undefined when its paths can't be read exactly.
function staged(add, top, changed, tracked) {
	const paths = add.args.filter((a) => !a.startsWith("-"));
	if (add.args.some((a) => a === "-A" || a === "--all")) return changed;
	if (add.args.some((a) => a === "-u" || a === "--update")) return tracked;
	if (paths.some((p) => /[*?[\]]/.test(p))) return undefined;
	const rels = paths.map((p) => path.relative(top, path.resolve(add.dir, p)).replaceAll("\\", "/"));
	return changed.filter((f) => rels.some((r) => r === "" || f === r || f.startsWith(`${r}/`)));
}

// The reason to block `command`'s commit, or undefined. segs/gitParts: see readCommit.
export function checkCommit({ segs, gitParts, raw, cwd, config }) {
	const commit = readCommit(segs, gitParts, cwd);
	if (!commit) return undefined;
	if (commit.problem) return commit.problem;
	const { dir } = commit;
	const branch = lines(git(dir, ["branch", "--show-current"]))[0];
	if (!branch || branch === config.baseBranch || finishingOther(dir)) return undefined;
	const top = lines(git(dir, ["rev-parse", "--show-toplevel"]))[0];
	if (!top) return undefined;

	const files = new Set(lines(git(top, ["diff", "--cached", "--name-only", "--diff-filter=ACMR"])));
	const changed = lines(git(top, ["status", "--porcelain", "--untracked-files=all"]))
		.filter((l) => !l.startsWith(" D") && !l.startsWith("D "))
		.map((l) => l.slice(3).replace(/^"|"$/g, "").split(" -> ").pop());
	const tracked = lines(git(top, ["diff", "--name-only", "--diff-filter=AM"]));
	for (const add of commit.adds) {
		if (add.verb !== "add" && add.verb !== "stage") continue;
		const more = staged(add, top, changed, tracked);
		if (!more) return `Blocked: \`git add\` with a glob before a commit. ${SEPARATELY}`;
		for (const f of more) files.add(f);
	}
	if (commit.all) for (const f of tracked) files.add(f);
	// An amend replaces HEAD: its files are part of the new commit, and HEAD can't be what unlocked them.
	if (commit.amend) for (const f of lines(git(top, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--diff-filter=ACMR", "HEAD"]))) files.add(f);
	if (files.size === 0) return undefined;

	let message = raw.slice(raw.search(/\bcommit\b/));
	if (commit.fileMessage) {
		try {
			message += readFileSync(path.resolve(dir, commit.fileMessage), "utf8");
		} catch {}
	}
	const kind = classifier(config.testPaths);
	return commitProblem({
		files: [...files],
		kind,
		testsCommitted: testsCommittedSince(top, { base: config.baseBranch, kind, skipHead: commit.amend }),
		message,
	});
}

// Whether a tests-only commit exists since the unit of work began (see the top of this file).
export function testsCommittedSince(cwd, { base, kind, skipHead = false }) {
	const mergeBase = lines(git(cwd, ["merge-base", "HEAD", `origin/${base}`]))[0] ?? lines(git(cwd, ["merge-base", "HEAD", base]))[0];
	if (!mergeBase) return true; // nothing to compare with: don't block
	const log = lines(git(cwd, ["log", "--no-merges", "--format=%H%x09%s", `${mergeBase}..HEAD`])).slice(skipHead ? 1 : 0);
	for (const line of log) {
		const [sha, subject] = line.split("\t");
		if (/^docs: finish \S+ slice \d+/.test(subject)) return false; // newest first: the last finished slice ends the search
		const files = lines(git(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--diff-filter=AM", sha]));
		if (testsOnly(files, kind, subject)) return true;
	}
	return false;
}
