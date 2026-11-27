// Stop: while the working tree has changes (untracked files included), Claude may not stop until the repository's
// verify command (lint, typecheck, unit tests; never e2e) passes. Does nothing where runway is not set up. It blocks
// at most MAX_BLOCKS times in a row (stop_hook_active means Claude is already continuing because of this hook): after
// that it lets Claude stop, with a note to the user that verify still fails, so a failure Claude cannot fix never loops.
//
// After a pass it remembers a fingerprint of the tree (HEAD, the status, the content of every changed or untracked
// file, and the command) in <git-common-dir>/runway/verified/, one per worktree. A later stop with the same
// fingerprint passes without running verify again. Ignored files (node_modules, .env) are not part of it.
//
// It also lets Claude stop without running verify when:
// - the tree is exactly as it was when the session started (session-start records it): the changes are the user's
//   own work in progress, not Claude's;
// - Claude's last message ends its turn on purpose with a `RUNWAY-ASK: <question>` line (it needs the user to decide
//   something) or, in an unattended run, a `RUNWAY-STOP: <reason>` line.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";
import { block, lastLines, readEvent, workDir } from "./hook-io.mjs";

function git(root, args, input) {
	const r = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, input, maxBuffer: 64 * 1024 * 1024 });
	return { ok: r.status === 0 && !r.error, out: r.stdout ?? "" };
}

export function hasChanges(root) {
	const status = git(root, ["status", "--porcelain"]);
	// Not a repository, or git is missing: not ours to judge.
	return status.ok && status.out.trim() !== "";
}

// The paths `git status --porcelain -z` lists (renames list both names).
function changedPaths(statusZ) {
	const parts = statusZ.split("\0").filter(Boolean);
	const paths = [];
	for (let i = 0; i < parts.length; i++) {
		const code = parts[i].slice(0, 2);
		paths.push(parts[i].slice(3));
		if (/[RC]/.test(code)) paths.push(parts[++i]);
	}
	return paths;
}

// HEAD, the status and the content of every changed or untracked file, as one string.
function treeState(root) {
	const head = git(root, ["rev-parse", "HEAD"]).out.trim() || "no-head";
	const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).out;
	const files = [...new Set(changedPaths(status))]
		.filter((p) => {
			const full = path.join(root, p);
			return existsSync(full) && statSync(full).isFile();
		})
		.sort();
	const hashes = files.length ? git(root, ["hash-object", "--stdin-paths"], `${files.join("\n")}\n`).out : "";
	return [head, status, files.join("\n"), hashes].join("\0");
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export const fingerprint = (root, command) => sha256(`${command}\0${treeState(root)}`);

// The tree alone, without the verify command: compared with the tree the session started with.
export const treeFingerprint = (root) => sha256(treeState(root));

// How many times in a row the gate keeps Claude working before it lets it stop with verify still failing.
export const MAX_BLOCKS = 3;
// Under the Stop hook's 900 s timeout in hooks.json.
const VERIFY_TIMEOUT_MS = 14 * 60_000;

const worktreeFile = (repo, ext) =>
	path.join(repo.commonDir, "runway", "verified", `${sha256(repo.top).slice(0, 16)}.${ext}`);

function writeQuietly(file, text) {
	try {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, text);
	} catch {
		// A read-only .git only costs a rerun (or one more block) next time.
	}
}

const SESSION_ID = /^[\w-]{1,100}$/;
const BASELINE_DAYS = 14;

// Where session-start records the tree one session found, per worktree.
export function baselineFile(repo, sessionId) {
	if (!SESSION_ID.test(String(sessionId ?? ""))) return undefined;
	return path.join(repo.commonDir, "runway", "baseline", `${sessionId}-${sha256(repo.top).slice(0, 16)}.txt`);
}

// Called by session-start: records the tree when a session starts with changes already in it. Never overwrites, so
// the record stays the tree the session first found. Drops records older than BASELINE_DAYS.
export function recordBaseline(repo, sessionId) {
	const file = baselineFile(repo, sessionId);
	if (!file) return;
	const folder = path.dirname(file);
	try {
		for (const name of existsSync(folder) ? readdirSync(folder) : []) {
			const old = path.join(folder, name);
			if (Date.now() - statSync(old).mtimeMs > BASELINE_DAYS * 86_400_000) rmSync(old, { force: true });
		}
	} catch {
		// Housekeeping only.
	}
	if (existsSync(file) || !hasChanges(repo.top)) return;
	writeQuietly(file, `${treeFingerprint(repo.top)}\n`);
}

// The text of Claude's last message: from the event when Claude Code sends it, else from the transcript's end.
export function lastAssistantText(event) {
	if (typeof event.last_assistant_message === "string") return event.last_assistant_message;
	const file = event.transcript_path;
	if (typeof file !== "string" || !existsSync(file)) return "";
	let tail;
	try {
		const size = statSync(file).size;
		const length = Math.min(size, 512 * 1024);
		const buffer = Buffer.alloc(length);
		const fd = openSync(file, "r");
		try {
			readSync(fd, buffer, 0, length, size - length);
		} finally {
			closeSync(fd);
		}
		tail = buffer.toString("utf8");
	} catch {
		return "";
	}
	const lines = tail.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		let entry;
		try {
			entry = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		if (entry?.type !== "assistant") continue;
		const content = entry.message?.content;
		const text = Array.isArray(content)
			? content
					.filter((c) => c?.type === "text")
					.map((c) => c.text)
					.join("\n")
			: typeof content === "string"
				? content
				: "";
		if (text.trim()) return text;
	}
	return "";
}

// A `RUNWAY-ASK: <question>` or `RUNWAY-STOP: <reason>` line of its own.
export function endsTurnOnPurpose(text) {
	return String(text ?? "")
		.split(/\r?\n/)
		.some((line) => /^`?RUNWAY-(ASK|STOP):\s*\S/.test(line.trim()));
}

// Returns undefined (stop), { block } (keep Claude working, the reason goes to Claude) or { notice } (stop, and tell
// the user verify still fails).
export function gate(event) {
	const loaded = loadConfig(workDir(event));
	if (!loaded.ok) return undefined;
	const root = loaded.repo.top;
	const blocks = worktreeFile(loaded.repo, "blocks");
	// A stop that is not a continuation of this hook starts a new count.
	if (event.stop_hook_active !== true) rmSync(blocks, { force: true });
	if (!hasChanges(root)) return undefined;
	if (endsTurnOnPurpose(lastAssistantText(event))) return undefined;
	const baseline = baselineFile(loaded.repo, event.session_id);
	if (baseline && existsSync(baseline) && readFileSync(baseline, "utf8").trim() === treeFingerprint(root)) return undefined;

	const command = loaded.config.verifyCommand;
	const stamp = worktreeFile(loaded.repo, "txt");
	const before = fingerprint(root, command);
	if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === before) return undefined;

	// The command is the repository's own setting and may chain steps, so it runs through the shell.
	// Ended before the hook's own 900 s limit, so a hung verify fails here, with a reason, instead of being cut off.
	const result = spawnSync(command, { cwd: root, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: VERIFY_TIMEOUT_MS });
	if (result.error?.code === "ETIMEDOUT") {
		if (process.platform === "win32" && result.pid)
			spawnSync("taskkill", ["/PID", String(result.pid), "/T", "/F"], { windowsHide: true });
		result.error = new Error(`timed out after ${VERIFY_TIMEOUT_MS / 60_000} minutes (a watch mode, a server left running, or a hung test); processes it started may still run`);
	}
	if (result.status === 0) {
		rmSync(blocks, { force: true });
		// Taken again after the run: a verify command that formats or generates files changes the tree.
		writeQuietly(stamp, `${fingerprint(root, command)}\n`);
		return undefined;
	}

	let count = 0;
	try {
		count = Number.parseInt(readFileSync(blocks, "utf8"), 10) || 0;
	} catch {
		// No count yet.
	}
	if (count >= MAX_BLOCKS) {
		rmSync(blocks, { force: true });
		return {
			notice: `runway: \`${command}\` still fails after ${MAX_BLOCKS} attempts to fix it; Claude stopped anyway. Run it to see why.`,
		};
	}
	writeQuietly(blocks, `${count + 1}\n`);

	const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`;
	return {
		block: [
			`\`${command}\` failed (attempt ${count + 1} of ${MAX_BLOCKS}). Fix the cause before stopping; never weaken, skip or delete a check or test to get past it. If it cannot be fixed here, say why. If you need the user to decide something before you can go on, ask, and end your message with a line \`RUNWAY-ASK: <the question>\`.`,
			"Last 60 lines of output:",
			lastLines(output.trimEnd(), 60),
		].join("\n"),
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const verdict = gate(await readEvent());
	if (verdict?.notice) console.log(JSON.stringify({ systemMessage: verdict.notice }));
	if (verdict?.block) block(verdict.block);
}
