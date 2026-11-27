// Builds a planned epic to the end on its own branch, epic/<slug>, one slice at a time: a fresh headless Claude
// session per slice (epic-next → spec → implement → verify → review → commit and push), then CI on the epic's PR
// with fixes. When every slice is done, one more session ships the epic: final reviews, and the PR marked ready for
// review. It never merges: a developer reviews the PR and merges it.
//
// The loop is plain code and costs no tokens. It works out where the epic is from the epic file on the branch and
// from GitHub, so "proceed" after a stop is just another start.
//
//   node epic-auto.mjs start  <slug>   start in the background
//   node epic-auto.mjs status <slug>   state and the log's tail
//   node epic-auto.mjs stop   <slug>   stop a running run
//   node epic-auto.mjs run    <slug>   the loop, in the foreground
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import {
	CODING_TOOLS,
	SLUG,
	ciFixPrompt,
	conflictPrompt,
	epicBranch,
	lastLines,
	limitResetAt,
	modelArgs,
	newStrays,
	sessionCost,
	untrackedPaths,
	nextSlice,
	parseSlices,
	resumeFor,
	runnerAlive,
	stepOf,
	parseWorktreeInclude,
	parseWorktrees,
	readMarkers,
	resolveClaude,
	unattendedPrompt,
} from "./epic-auto-lib.mjs";

const SELF = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(SELF), "..");
const MAX_FIX_ATTEMPTS = 3;
// The longest the runner waits for one round of CI checks.
const CI_WAIT_MINUTES = 90;
// Consecutive usage-limit waits for one Claude run before the runner gives up (a weekly limit needs a few).
const MAX_LIMIT_WAITS = 6;
// The longest one headless Claude run may take before the runner ends it as hung.
const SESSION_HOURS = Number(process.env.RUNWAY_SESSION_HOURS) > 0 ? Number(process.env.RUNWAY_SESSION_HOURS) : 4;

const [command, slug] = process.argv.slice(2);

class Stop extends Error {
	constructor(reason, extra = {}) {
		super(reason);
		Object.assign(this, extra);
	}
}

// ---- processes ----

function sh(program, args, { cwd = ROOT, allowFail = false } = {}) {
	const r = spawnSync(program, args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
	const result = { ok: r.status === 0, code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
	if (r.error) throw new Stop(`Cannot run ${program}: ${r.error.message}`);
	if (!result.ok && !allowFail) throw new Stop(`${program} ${args.join(" ")} failed: ${result.err || result.out}`);
	return result;
}

// timeoutMs: past it, the process and everything it started are killed, and the result has timedOut: true.
// onSpawn(pid) is told the process id.
function runAsync(program, args, { cwd, input, timeoutMs, onSpawn }) {
	return new Promise((resolve) => {
		// With a timeout, its own process group off Windows, so the kill reaches what it started too. `stop` kills
		// that group as well as the runner's (Windows' taskkill /T follows the tree either way).
		const child = spawn(program, args, { cwd, windowsHide: true, detached: Boolean(timeoutMs) && process.platform !== "win32" });
		onSpawn?.(child.pid);
		let out = "";
		let err = "";
		let timedOut = false;
		const timer =
			timeoutMs &&
			setTimeout(() => {
				timedOut = true;
				killTree(child.pid);
			}, timeoutMs);
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			err += d;
		});
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ code: -1, out, err: `${err}${e.message}`, timedOut });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, out, err, timedOut });
		});
		child.stdin.end(input ?? "");
	});
}

function killTree(pid) {
	if (!pid) return;
	try {
		if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
		else process.kill(-pid, "SIGTERM");
	} catch {
		// Already gone.
	}
}

const git = (args, opts) => sh("git", args, opts);
const gh = (args, opts) => sh("gh", args, opts);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- where things live ----

const COMMON_DIR = (() => {
	const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
	if (r.status !== 0) {
		console.error("Run this inside a git repository.");
		process.exit(1);
	}
	return r.stdout.trim();
})();
const ROOT = path.dirname(COMMON_DIR);
const STATE_DIR = path.join(COMMON_DIR, "runway");
const STATUS_FILE = path.join(STATE_DIR, `epic-auto-${slug}.json`);
const LOG_FILE = path.join(STATE_DIR, `epic-auto-${slug}.log`);
const BRANCH = epicBranch(slug ?? "");

function settings() {
	const loaded = loadConfig(ROOT);
	if (!loaded.ok) throw new Stop(`runway is not set up here (${loaded.message}). Run /runway:setup first.`);
	return loaded.config;
}

function readStatus() {
	try {
		return JSON.parse(readFileSync(STATUS_FILE, "utf8"));
	} catch {
		return {};
	}
}

function writeStatus(patch) {
	mkdirSync(STATE_DIR, { recursive: true });
	const next = { ...readStatus(), ...patch, slug, updated: new Date().toISOString() };
	// Written whole, then renamed into place, so `status` and `stop` never read half a file.
	const temp = `${STATUS_FILE}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
	renameSync(temp, STATUS_FILE);
	return next;
}

function log(message) {
	console.log(`[${new Date().toISOString()}] ${message}`);
}

function alive(pid) {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// ---- Claude ----

const CLAUDE = resolveClaude({
	platform: process.platform,
	env: process.env,
	where: () => {
		const r = spawnSync("where", ["claude"], { encoding: "utf8", windowsHide: true });
		return r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
	},
	read: (file) => readFileSync(file, "utf8"),
	nodePath: process.execPath,
});

// The claudeSettings object, read from its file when it names one (to see whether it sets a model).
function settingsObject(config) {
	const value = config.claudeSettings;
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(readFileSync(path.resolve(ROOT, value), "utf8"));
	} catch {
		return undefined;
	}
}

// The headless session running now: killed with the runner (off Windows it runs in its own process group).
let currentClaude;

function settingsArg(config) {
	const value = config.claudeSettings;
	if (!value) return [];
	return ["--settings", typeof value === "string" ? path.resolve(ROOT, value) : JSON.stringify(value)];
}

// One headless Claude run. Waits out the plan's usage limit and resumes the same session as often as needed.
// --plugin-dir replaces an installed runway of the same name for this run, so its hooks never run twice.
async function claude(cwd, prompt, { mode = "fix", resume, remember } = {}) {
	if (!CLAUDE)
		throw new Stop("Cannot find the claude executable. Set RUNWAY_CLAUDE_BIN to its full path (claude.exe, or the cli.js an npm install runs).");
	const config = settings();
	let sessionId = resume;
	let input = prompt;
	// A real usage limit clears at its reset; one that keeps coming back means the failure is something else (a
	// message that only mentions a limit), so the run stops instead of waiting forever.
	for (let waits = 0; ; ) {
		const args = [...CLAUDE.prefix, "-p", "--output-format", "json", "--plugin-dir", PLUGIN_ROOT, "--add-dir", PLUGIN_ROOT];
		args.push("--append-system-prompt", unattendedPrompt(PLUGIN_ROOT, { mode }));
		args.push("--permission-mode", process.env.RUNWAY_PERMISSION_MODE || "acceptEdits");
		args.push(...settingsArg(config), ...modelArgs({ ...config, claudeSettings: settingsObject(config) }));
		if (sessionId) args.push("--resume", sessionId);
		args.push("--disallowedTools", "PowerShell");
		args.push("--allowedTools", [...CODING_TOOLS, ...extraTools()].join(","));

		const before = mainCheckoutUntracked();
		const r = await runAsync(CLAUDE.command, args, {
			cwd,
			input,
			timeoutMs: SESSION_HOURS * 3_600_000,
			onSpawn: (pid) => {
				currentClaude = pid;
				writeStatus({ claudePid: pid ?? null });
			},
		});
		currentClaude = undefined;
		writeStatus({ claudePid: null });
		if (r.timedOut)
			throw new Stop(
				`A Claude session ran for over ${SESSION_HOURS} hours and was ended as hung (RUNWAY_SESSION_HOURS changes the limit). Check the worktree ${cwd}, commit or discard what it left, then proceed.`,
			);
		let reply = {};
		try {
			reply = JSON.parse(r.out);
		} catch {
			reply = { result: r.out };
		}
		sessionId = reply.session_id ?? sessionId;
		const cost = sessionCost(reply);
		if (cost) {
			const total = (readStatus().costUsd ?? 0) + cost.usd;
			writeStatus({ costUsd: Math.round(total * 100) / 100 });
			log(`${cost.line} Run total $${total.toFixed(2)}.`);
		}
		const strays = before ? newStrays(before, mainCheckoutUntracked() ?? before) : [];
		if (strays.length > 0) {
			const all = new Set([...(readStatus().strays ?? []), ...strays.map((p) => path.join(ROOT, p))]);
			writeStatus({ strays: [...all] });
			log(`New untracked files in the main checkout, likely written there by this session (not deleted, check and remove them): ${strays.join(", ")}`);
		}
		// Remembered so a run that stops mid-slice resumes the same conversation after "proceed".
		if (remember && sessionId) writeStatus({ session: { ...remember, cwd, id: sessionId } });
		const text = String(reply.result ?? "");
		const failed = r.code !== 0 || reply.is_error === true;
		const throttled = reply.api_error_status === 429 ? new Date(Date.now() + 15 * 60_000) : undefined;
		const resetAt = failed ? (limitResetAt(`${text}\n${r.err}`) ?? throttled) : undefined;
		if (resetAt) {
			if (++waits > MAX_LIMIT_WAITS)
				throw new Stop(
					`Claude kept failing with what looks like a usage limit after ${MAX_LIMIT_WAITS} waits. Its last words: ${lastLines(`${text}\n${r.err}`.trim(), 8)}`,
				);
			await waitForLimit(resetAt);
			if (sessionId) input = "Continue where you left off.";
			continue;
		}
		if (failed && !text.trim()) throw new Stop(`Claude exited with code ${r.code}: ${lastLines(r.err, 20)}`);
		const stop = readMarkers(text).stop;
		if (stop) throw new Stop(stop, { kind: "agent" });
		return { text, sessionId };
	}
}

// Untracked files in the main checkout, to spot what a session wrote outside its worktree. undefined if git fails.
function mainCheckoutUntracked() {
	const r = spawnSync("git", ["-c", "core.quotepath=off", "status", "--porcelain", "--untracked-files=all"], {
		cwd: ROOT,
		encoding: "utf8",
		windowsHide: true,
	});
	// The worktrees live inside the main checkout: their files are the session's own work, not strays.
	return r.status === 0 ? untrackedPaths(r.stdout).filter((p) => !p.startsWith(".claude/worktrees/")) : undefined;
}

function extraTools() {
	return (process.env.RUNWAY_ALLOWED_TOOLS ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
}

async function waitForLimit(resetAt) {
	log(`Claude usage limit reached. Waiting until ${resetAt.toLocaleString()} and then continuing.`);
	writeStatus({ state: "waiting-for-limit", until: resetAt.toISOString() });
	// Short sleeps, so a laptop that slept through the reset carries on as soon as it wakes.
	while (Date.now() < resetAt.getTime()) await sleep(Math.min(60_000, resetAt.getTime() - Date.now()));
	writeStatus({ state: "running", until: null });
	log("Usage limit reset: continuing.");
}

// ---- the epic's worktree and branch ----

function copyIncludes(worktree) {
	const file = path.join(ROOT, ".worktreeinclude");
	if (!existsSync(file)) return;
	for (const rel of parseWorktreeInclude(readFileSync(file, "utf8"))) {
		const from = path.join(ROOT, rel);
		const to = path.join(worktree, rel);
		if (!existsSync(from) || existsSync(to)) continue;
		mkdirSync(path.dirname(to), { recursive: true });
		cpSync(from, to, { recursive: true });
	}
}

// The worktree that holds epic/<slug>, created from the pushed branch when there is none.
function epicWorktree() {
	const existing = parseWorktrees(git(["worktree", "list", "--porcelain"]).out).find((w) => w.branch === BRANCH);
	if (existing) return path.resolve(existing.path);
	const where = path.join(ROOT, ".claude", "worktrees", `epic-${slug}`);
	const hasLocal = git(["rev-parse", "--verify", "--quiet", `refs/heads/${BRANCH}`], { allowFail: true }).ok;
	git(["worktree", "add", where, ...(hasLocal ? [BRANCH] : ["--track", "-b", BRANCH, `origin/${BRANCH}`])]);
	copyIncludes(where);
	log(`Created the worktree ${where}.`);
	return where;
}

// Brings the worktree up to date with what was pushed, and pushes what was committed but not pushed.
function syncWithRemote(where) {
	const ahead = Number(git(["rev-list", "--count", `origin/${BRANCH}..HEAD`], { cwd: where }).out);
	const behind = Number(git(["rev-list", "--count", `HEAD..origin/${BRANCH}`], { cwd: where }).out);
	if (behind > 0 && ahead > 0)
		throw new Stop(`${BRANCH} has diverged from origin/${BRANCH} in ${where}. Reconcile them (never force push), then proceed.`);
	if (behind > 0) git(["merge", "--ff-only", `origin/${BRANCH}`], { cwd: where });
	if (ahead > 0) git(["push", "origin", `HEAD:${BRANCH}`], { cwd: where });
}

// Takes in what landed on the base branch, so the epic is built and tested against today's code.
async function mergeBase(where, base) {
	const behind = Number(git(["rev-list", "--count", `HEAD..origin/${base}`], { cwd: where }).out);
	if (behind === 0) return;
	log(`Merging origin/${base} (${behind} new commits) into ${BRANCH}.`);
	if (git(["merge", "--no-edit", `origin/${base}`], { cwd: where, allowFail: true }).ok) {
		git(["push", "origin", `HEAD:${BRANCH}`], { cwd: where });
		return;
	}
	git(["merge", "--abort"], { cwd: where, allowFail: true });
	await claude(where, conflictPrompt({ base }));
	syncWithRemote(where);
}

const dirty = (where) => git(["status", "--porcelain"], { cwd: where }).out !== "";

function readSlices(where, epicsDir) {
	const file = path.join(where, epicsDir, `${slug}.md`);
	if (!existsSync(file)) throw new Stop(`${epicsDir}/${slug}.md is missing on ${BRANCH}.`);
	const slices = parseSlices(readFileSync(file, "utf8"));
	if (slices.length === 0) throw new Stop(`${epicsDir}/${slug}.md has no readable "## Slices" table.`);
	return slices;
}

// ---- GitHub ----

function openPr(base) {
	const list = (state) =>
		JSON.parse(
			gh(["pr", "list", "--state", state, "--head", BRANCH, "--json", "number,url,isDraft,title,state"]).out || "[]",
		);
	const open = list("open")[0];
	if (open) return open;
	if (list("merged")[0]) throw new Stop(`The PR for ${BRANCH} is already merged: the epic is finished.`);
	log(`Opening a draft PR for ${BRANCH}.`);
	const body = `The ${slug} epic, built slice by slice by runway's epic-auto. Plan: \`${settings().epicsDir}/${slug}.md\`. Not ready for review until it leaves draft.`;
	const args = ["pr", "create", "--base", base, "--head", BRANCH, "--body", body];
	// Draft PRs need a paid GitHub plan on private repositories; without one, the title says it is unfinished.
	if (!gh([...args, "--draft", "--title", `feat: ${slug}`], { allowFail: true }).ok)
		gh([...args, "--title", `WIP: feat: ${slug}`]);
	return list("open")[0];
}

const isReady = (pr) => !pr.isDraft && !/^WIP\b/i.test(pr.title);

// Waits until GitHub has the commit just pushed as the PR's head, so the checks read next are that commit's.
async function waitForHead(pr, where) {
	const local = git(["rev-parse", "HEAD"], { cwd: where }).out;
	for (let tries = 0; tries < 30; tries++) {
		const head = JSON.parse(gh(["pr", "view", String(pr), "--json", "headRefOid"]).out).headRefOid;
		if (head === local) return;
		await sleep(10_000);
	}
	throw new Stop(`PR #${pr} still does not show ${local.slice(0, 7)} as its head after 5 minutes. Check that ${BRANCH} was pushed, then proceed.`);
}

async function waitForChecks(pr) {
	for (let tries = 0, errors = 0; ; tries++) {
		const r = await runAsync("gh", ["pr", "checks", String(pr), "--watch", "--fail-fast", "--interval", "30"], {
			cwd: ROOT,
			timeoutMs: CI_WAIT_MINUTES * 60_000,
		});
		const output = `${r.out}\n${r.err}`;
		if (r.code === 0) return { pass: true };
		if (r.timedOut)
			throw new Stop(`CI on PR #${pr} did not finish within ${CI_WAIT_MINUTES} minutes (a check stuck in a queue?). Check it on GitHub, then proceed.`, { kind: "ci" });
		if (/no checks reported/i.test(output)) {
			if (tries >= 5) {
				log(`No CI checks reported for PR #${pr} after 5 minutes: treating CI as passed.`);
				return { pass: true };
			}
			await sleep(60_000);
			continue;
		}
		// Only a check that failed is a CI failure; anything else (network, auth, rate limit) is gh failing.
		if (!/\bfail(ed|ure)?\b/i.test(r.out)) {
			if (++errors >= 3) throw new Stop(`gh pr checks keeps failing for PR #${pr}: ${lastLines(output.trim(), 5)}`);
			await sleep(60_000);
			continue;
		}
		return { pass: false, output };
	}
}

function failedLog(pr) {
	const head = JSON.parse(gh(["pr", "view", String(pr), "--json", "headRefName,headRefOid"]).out);
	const runs = JSON.parse(
		gh(["run", "list", "--branch", head.headRefName, "--limit", "20", "--json", "databaseId,conclusion,headSha"]).out ||
			"[]",
	);
	const failed = runs.find((r) => r.headSha === head.headRefOid && r.conclusion === "failure");
	if (!failed) return "(no failed run log found: read `gh pr checks` output)";
	return lastLines(gh(["run", "view", String(failed.databaseId), "--log-failed"], { allowFail: true }).out, 200);
}

// Waits until CI passes on the PR, letting Claude fix failures and conflicts up to MAX_FIX_ATTEMPTS times.
async function ciGreen(pr, where, base) {
	for (let attempt = 0; ; attempt++) {
		const state = JSON.parse(gh(["pr", "view", String(pr), "--json", "mergeable"]).out);
		let fix;
		if (state.mergeable === "CONFLICTING") {
			log(`PR #${pr} conflicts with ${base}.`);
			fix = conflictPrompt({ base });
		} else {
			log(`Waiting for CI on PR #${pr}.`);
			await waitForHead(pr, where);
			const checks = await waitForChecks(pr);
			if (checks.pass) return;
			log(`CI failed on PR #${pr}.`);
			fix = ciFixPrompt({ pr, log: failedLog(pr) });
		}
		if (attempt >= MAX_FIX_ATTEMPTS)
			throw new Stop(`CI on PR #${pr} still fails after ${MAX_FIX_ATTEMPTS} fixes. Fix it, then proceed.`, { kind: "ci" });
		await claude(where, fix);
		syncWithRemote(where);
		await sleep(20_000);
	}
}

// ---- the loop ----

async function loop() {
	const { baseBranch: base, epicsDir } = settings();
	for (;;) {
		git(["fetch", "--prune", "origin"]);
		if (!git(["rev-parse", "--verify", "--quiet", `origin/${BRANCH}`], { allowFail: true }).ok)
			throw new Stop(`${BRANCH} is not on GitHub: plan the epic with /runway:epic-plan first (it pushes the branch).`);

		const where = epicWorktree();
		const pr = openPr(base);
		writeStatus({ pr: pr.number, url: pr.url, worktree: where });
		// A session saved when a run stopped is resumed only for the step it was working on.
		const saved = readStatus().session;
		const resume = resumeFor(saved, { where, step: stepOf(readSlices(where, epicsDir)) });
		if (saved && !resume) {
			log("The saved session was for another step: starting a new session.");
			writeStatus({ session: null });
		}
		if (!resume && dirty(where))
			throw new Stop(`${where} has uncommitted changes that no saved session owns. Commit or discard them, then proceed.`);
		if (!resume) {
			syncWithRemote(where);
			await mergeBase(where, base);
		}

		const slice = nextSlice(readSlices(where, epicsDir));
		if (slice) {
			log(`Slice ${slice.number}: ${slice.scope}`);
			const prompt = resume
				? "The developer has handled what stopped this run. Continue this slice where you left off, through to it being marked done, committed and pushed."
				: `/runway:epic-next ${slug}`;
			const { text } = await claude(where, prompt, { mode: "slice", resume, remember: { slice: slice.number } });
			writeStatus({ session: null });
			const after = readSlices(where, epicsDir).find((s) => s.number === slice.number);
			if (after?.status !== "done" || dirty(where))
				throw new Stop(`Slice ${slice.number} did not finish (not marked done, or uncommitted changes left). Its last words: ${lastLines(text, 8)}`);
			syncWithRemote(where);
			await ciGreen(pr.number, where, base);
			continue;
		}

		if (!isReady(pr)) {
			log(`Every slice is done. Shipping the epic's PR #${pr.number}.`);
			const prompt = resume
				? "The developer has handled what stopped this run. Continue shipping where you left off, through to the PR marked ready for review."
				: "/runway:ship";
			await claude(where, prompt, { mode: "ship", resume, remember: { slice: "ship" } });
			writeStatus({ session: null });
			syncWithRemote(where);
			const now = JSON.parse(gh(["pr", "view", String(pr.number), "--json", "isDraft,title"]).out);
			if (!isReady(now)) throw new Stop(`Ship ended without marking PR #${pr.number} ready for review.`);
		}
		await ciGreen(pr.number, where, base);
		return pr;
	}
}

// ---- commands ----

async function main() {
	if (!SLUG.test(slug ?? "")) {
		console.error("Usage: node epic-auto.mjs <start|status|stop|run> <slug>");
		process.exit(1);
	}
	const status = readStatus();

	if (command === "status") {
		console.log(JSON.stringify({ ...status, running: runnerAlive(status, alive) }, null, 2));
		if (existsSync(LOG_FILE)) console.log(`\n${LOG_FILE}:\n${lastLines(readFileSync(LOG_FILE, "utf8").trimEnd(), 20)}`);
		return;
	}

	if (command === "stop") {
		if (runnerAlive(status, alive)) {
			killTree(status.pid);
			if (process.platform !== "win32" && alive(status.claudePid)) killTree(status.claudePid);
		}
		writeStatus({ state: "stopped", reason: "Stopped by the developer.", kind: "manual", pid: null, claudePid: null });
		console.log("Stopped.");
		return;
	}

	if (command === "start") {
		if (runnerAlive(status, alive)) {
			console.log(`Already running (pid ${status.pid}). Log: ${LOG_FILE}`);
			return;
		}
		mkdirSync(STATE_DIR, { recursive: true });
		const out = openSync(LOG_FILE, "a");
		const child = spawn(process.execPath, [SELF, "run", slug], {
			cwd: ROOT,
			detached: true,
			stdio: ["ignore", out, out],
			windowsHide: true,
		});
		child.unref();
		writeStatus({ state: "running", pid: child.pid, reason: null, kind: null, started: new Date().toISOString() });
		console.log(`Started (pid ${child.pid}). Log: ${LOG_FILE}`);
		return;
	}

	if (command === "run") {
		writeStatus({ state: "running", pid: process.pid, heartbeat: new Date().toISOString() });
		// The heartbeat tells this runner from an unrelated process that got its id after a reboot.
		setInterval(() => writeStatus({ heartbeat: new Date().toISOString() }), 60_000).unref();
		const quit = (code) => () => {
			killTree(currentClaude);
			writeStatus({ state: "stopped", pid: null, claudePid: null, reason: "The runner was ended by a signal.", kind: "manual" });
			process.exit(code);
		};
		process.on("SIGINT", quit(130));
		process.on("SIGTERM", quit(143));
		log(`epic-auto ${slug} on ${BRANCH}.`);
		try {
			const pr = await loop();
			const reason = `Every slice is done and CI passes. PR #${pr.number} is ready for your review: ${pr.url}. Nothing was merged.`;
			writeStatus({ state: "done", pid: null, reason });
			log(`Done. ${reason}`);
		} catch (error) {
			const reason = error instanceof Stop ? error.message : `Unexpected error: ${error.stack ?? error}`;
			writeStatus({ state: "stopped", pid: null, reason, kind: error.kind ?? "error" });
			log(`Stopped: ${reason}`);
		}
		return;
	}

	console.error(`Unknown command: ${command}`);
	process.exit(1);
}

await main();
