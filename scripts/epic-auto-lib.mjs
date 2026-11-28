// Pure helpers for epic-auto.mjs: branch names, the epic file's slice table, prompts, markers in Claude's replies,
// usage-limit detection and finding the claude executable. No I/O of their own, so tests can cover them directly.
import path from "node:path";

export const SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/;

// Every epic is built on one branch and lands as one PR, which a developer reviews and merges.
export const epicBranch = (slug) => `epic/${slug}`;
export const isEpicBranch = (branch, slug) => branch === epicBranch(slug);

// Tools the unattended coding sessions may use without asking. Several of them (node, npx, curl, rm) can run
// anything, so this list and guard-bash are guard rails, not a security boundary: GitHub's branch rules protect the
// base branch, and a sandbox or dev container protects the machine.
export const CODING_TOOLS = [
	"Read",
	"Edit",
	"Write",
	"Glob",
	"Grep",
	"Task",
	"Agent",
	"Skill",
	"TodoWrite",
	"Bash(cd:*)",
	"Bash(ls:*)",
	"Bash(cat:*)",
	// Read-only text tools the skills and agents pipe output through (verify's `echo "exit $?"; tail -n 3 <log>`).
	// Claude Code's own read-only check usually allows these too; listing them keeps that from being load-bearing.
	"Bash(head:*)",
	"Bash(tail:*)",
	"Bash(grep:*)",
	"Bash(wc:*)",
	"Bash(echo:*)",
	"Bash(mkdir:*)",
	"Bash(cp:*)",
	"Bash(mv:*)",
	"Bash(rm:*)",
	"Bash(git:*)",
	"Bash(gh pr create:*)",
	"Bash(gh pr edit:*)",
	"Bash(gh pr ready:*)",
	"Bash(gh pr view:*)",
	"Bash(gh pr list:*)",
	"Bash(gh pr diff:*)",
	"Bash(gh pr checks:*)",
	"Bash(gh run:*)",
	"Bash(node:*)",
	"Bash(npm:*)",
	"Bash(npx:*)",
	"Bash(pnpm:*)",
	"Bash(yarn:*)",
	"Bash(docker compose:*)",
	"Bash(curl:*)",
	// Stopping the dev server verify starts: Windows, then macOS and Linux.
	"Bash(taskkill:*)",
	"Bash(netstat:*)",
	"Bash(kill:*)",
	"Bash(pkill:*)",
	"Bash(lsof:*)",
	"mcp__plugin_runway_playwright",
];

const RULES = `You are running unattended: runway's epic-auto runner started this session, nobody is watching it, and the
user approved the whole run in advance. Nothing you do is merged: a developer reviews the epic's PR and merges it.

- Treat every approval a skill asks for (a spec, a plan) as given. Where a skill says to ask the user which option
  to take, take the one the epic file and the code support best.
- Never wait for input. Stop only for what you cannot settle yourself: a test that looks wrong, a reviewer finding
  you cannot resolve, something only a developer can do (a secret, an env var or setting in a hosting dashboard,
  an account, a paid service), or a risky choice the epic file leaves open. Then end your final message with one
  line: \`RUNWAY-STOP: <what the developer must do or decide>, then proceed\`. Where a skill says to end with
  \`RUNWAY-ASK: ...\`, write \`RUNWAY-STOP: ...\` instead. Never tell the developer to run a runway command: after
  "proceed" the runner carries on, and ships the epic itself.
- Tests first, always: a \`runway:test-writer\` agent writes and commits each test file's failing tests before any
  code. Never write tests yourself. A commit with no testable behaviour says \`[no-tests] <why>\`.
- If a command writes files outside this worktree, redo it with an explicit path so they land here, and name the
  stray files in your final message. Don't delete them or stop for them.
- Never start a shell command with \`cd\`: with nobody to approve it, \`cd\` followed by other commands is denied.
  You already run in the worktree; point commands at another folder instead (\`git -C <dir>\`, \`pnpm --dir <dir>\`).
  Keep each command simple (no loops, subshells or \`cat > file\`: write files with Write). When you start an agent,
  pass this rule on. If a command is still denied, don't repeat it: split it or use Read, Grep and Glob. Stop for
  it only when that fails too, naming the command.
- If dependencies are missing in this worktree, install them with the repository's package manager and lockfile.
- Never merge a PR, force push, or push to any branch but this one.`;

// mode: "slice" builds the next slice, "ship" finishes the epic's PR, "fix" repairs CI or a conflict.
export function unattendedPrompt(pluginRoot, { mode = "fix" } = {}) {
	const finish = {
		slice: `- Build exactly one slice, as epic-next says: it ends when the slice is marked done, committed and pushed.
  Do not run ship: the runner starts it once every slice is done.`,
		ship: `- Ship the epic: read \`${pluginRoot}/skills/ship/SKILL.md\` and follow it, so the run ends with the epic's PR
  ready for review.`,
		fix: `- Do not run ship or open a PR: commit and push (never force) your fix.`,
	}[mode];
	return `${RULES}\n${finish}`;
}

// The --model flag for a headless session: the "model" setting, unless claudeSettings (an inline object) sets one.
export function modelArgs(config) {
	const settings = config.claudeSettings;
	if (settings && typeof settings === "object" && settings.model) return [];
	return config.model && config.model !== "inherit" ? ["--model", config.model] : [];
}

// Untracked paths in `git status --porcelain` output.
export const untrackedPaths = (porcelain) =>
	String(porcelain ?? "")
		.split(/\r?\n/)
		.filter((line) => line.startsWith("?? "))
		.map((line) => line.slice(3).replace(/^"|"$/g, ""));

// What a session added to the main checkout: untracked paths now that were not there before it ran.
export const newStrays = (before, after) => after.filter((p) => !before.includes(p));

// One headless session's cost from claude -p's JSON reply, for the log: { usd, line }, or undefined without one.
export function sessionCost(reply) {
	const usd = Number(reply?.total_cost_usd);
	if (reply?.total_cost_usd === undefined || !Number.isFinite(usd)) return undefined;
	const u = reply.usage ?? {};
	const k = (n) => `${Math.round((Number(n) || 0) / 1000)}K`;
	const turns = reply.num_turns ? `, ${reply.num_turns} turns` : "";
	return {
		usd,
		line: `Session cost $${usd.toFixed(2)} (output ${k(u.output_tokens)}, cache reads ${k(u.cache_read_input_tokens)}, cache writes ${k(u.cache_creation_input_tokens)}${turns}).`,
	};
}

export function ciFixPrompt({ pr, log }) {
	return `CI failed on PR #${pr}, which is this worktree's branch. The failing jobs' log ends with:

\`\`\`
${log}
\`\`\`

Find the cause and fix it here, following the repository's conventions. Run the verify command until it passes,
commit (\`fix: ...\`) and push with \`git push\` (never force). Never weaken, skip or delete a test or check to get
green. A behaviour fix starts with a failing test from \`runway:test-writer\` (the commit guard wants tests first); a
fix with no testable behaviour (lint, config, a flaky setup) says \`[no-tests] <why>\` in its commit message. If the failure needs something only a developer can do, stop as the unattended rules say.`;
}

export function conflictPrompt({ base }) {
	return `This worktree's branch conflicts with \`origin/${base}\`. Run \`git fetch\` and \`git merge origin/${base}\`,
resolve each conflict keeping the intent of both sides (the epic file says what this branch is for), run the verify
command until it passes, commit the merge and push with \`git push\` (never force). A fix needed after the merge
commit is committed on its own, with \`[no-tests] <why>\` in its message when it adds no behaviour.`;
}

// The marker the prompts above ask for. Only a marker on its own line counts.
export function readMarkers(text) {
	const lines = String(text ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim().replace(/^`|`$/g, ""));
	const stop = lines.map((line) => line.match(/^RUNWAY-STOP:\s*(.+)$/)).findLast(Boolean);
	return { stop: stop?.[1].trim() };
}

// The epic file's "## Slices" table → [{ number, scope, risk, status }], in order. Columns are found by header, so
// extra columns are fine. Returns [] when there is no such table.
export function parseSlices(markdown) {
	const lines = String(markdown ?? "").split(/\r?\n/);
	const start = lines.findIndex((line) => /^##\s+Slices\b/i.test(line.trim()));
	if (start < 0) return [];
	const cells = (line) =>
		line
			.trim()
			.replace(/^\||\|$/g, "")
			.split("|")
			.map((c) => c.trim());
	const rows = [];
	let header;
	for (const line of lines.slice(start + 1)) {
		if (/^##\s/.test(line.trim())) break;
		if (!line.trim().startsWith("|")) {
			if (header && rows.length) break;
			continue;
		}
		const row = cells(line);
		if (!header) {
			header = row.map((h) => h.toLowerCase());
			continue;
		}
		if (row.every((c) => /^:?-+:?$/.test(c))) continue;
		const at = (name) => row[header.indexOf(name)] ?? "";
		const number = Number.parseInt(at("#"), 10);
		if (Number.isNaN(number)) continue;
		rows.push({ number, scope: at("scope"), risk: at("risk").toLowerCase(), status: at("status").toLowerCase() });
	}
	return rows;
}

export const nextSlice = (slices) => slices.find((s) => s.status !== "done");

// The step the runner is at: the next slice's number, or "ship" once every slice is done.
export const stepOf = (slices) => nextSlice(slices)?.number ?? "ship";

// Two spellings of one folder: git prints C:/x where path.join gives C:\x, and Windows ignores case.
export function samePath(a, b, platform = process.platform) {
	const norm = (p) => {
		const r = path.resolve(p).replace(/[\\/]+$/, "");
		return platform === "win32" ? r.replaceAll("/", "\\").toLowerCase() : r;
	};
	return norm(a) === norm(b);
}

// Whether a status file's runner is really running: its process exists and it wrote a heartbeat lately (a process
// id reused after a reboot has none).
export function runnerAlive(status, pidExists, now = Date.now()) {
	if (!status?.pid || !pidExists(status.pid)) return false;
	const beat = Date.parse(status.heartbeat ?? "");
	return Number.isFinite(beat) && now - beat < 10 * 60_000;
}

// Whether to resume the session saved when a run stopped: only in the same worktree and for the same step. A slice
// session is never resumed to ship (or to build another slice), and a ship session never to build a slice.
export function resumeFor(saved, { where, step }) {
	if (!saved?.id || !saved.cwd || !samePath(saved.cwd, where)) return undefined;
	return saved.slice === step ? saved.id : undefined;
}

// The next time after `now` that the clock reads hour:minute, in the named IANA time zone ("resets 3pm
// (America/New_York)"), or in this machine's zone when none is named or the name is unknown.
function nextClockTime(now, hour, minute, zone) {
	let parts;
	try {
		if (zone) parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
	} catch {
		parts = undefined;
	}
	if (!parts) {
		const at = new Date(now);
		at.setHours(hour, minute, 0, 0);
		if (at <= now) at.setDate(at.getDate() + 1);
		return at;
	}
	// The zone's wall clock at an instant, read as if it were UTC.
	const wall = (instant) => {
		const p = Object.fromEntries(parts.formatToParts(instant).map(({ type, value }) => [type, Number(value)]));
		return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
	};
	const today = new Date(wall(now));
	for (let day = 0; day <= 2; day++) {
		const target = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + day, hour, minute);
		// Shift by the zone's offset near that time (twice, so a daylight-saving change in between settles).
		let at = target - (wall(new Date(target)) - target);
		at = target - (wall(new Date(at)) - at);
		if (at > now.getTime()) return new Date(at);
	}
	return new Date(now.getTime() + 15 * 60_000);
}

// When a reply says the Claude plan's usage limit was hit, returns when to try again (the reset plus two minutes),
// else undefined. Only called for failed runs: a successful reply may mention "rate limit" as code.
export function limitResetAt(text, now = new Date()) {
	const message = String(text ?? "");
	if (!/(usage|session|weekly|hourly|5-hour|rate)[\s_-]*limit|limit (reached|hit|exceeded)|out of usage/i.test(message))
		return undefined;
	const buffer = 2 * 60_000;
	const epoch = message.match(/limit[^|\n]*\|\s*(\d{10})\b/i);
	if (epoch) return new Date(Number(epoch[1]) * 1000 + buffer);
	const clock = message.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([^)\s]+)\))?/i);
	if (clock) {
		let hour = Number(clock[1]) % 12;
		if (clock[3].toLowerCase() === "pm") hour += 12;
		const at = nextClockTime(now, hour, Number(clock[2] ?? 0), clock[4]);
		return new Date(at.getTime() + buffer);
	}
	// A limit with no readable reset time: check again in 15 minutes.
	return new Date(now.getTime() + 15 * 60_000);
}

// How to start Claude Code without a shell. On Windows an npm install is a .cmd shim, which spawn() cannot run
// directly and cmd.exe cannot pass multi-line arguments to, so the shim's target is run instead.
//   where(): the paths `where claude` lists; read(file): its text.
// Returns { command, prefix } (prefix goes before Claude's own arguments), or undefined when nothing usable is found.
export function resolveClaude({ platform, env = {}, where = () => [], read = () => "", nodePath = "node" }) {
	if (env.RUNWAY_CLAUDE_BIN) return { command: env.RUNWAY_CLAUDE_BIN, prefix: [] };
	if (platform !== "win32") return { command: "claude", prefix: [] };
	const found = where();
	const exe = found.find((p) => /\.exe$/i.test(p));
	if (exe) return { command: exe, prefix: [] };
	const shim = found.find((p) => /\.cmd$/i.test(p));
	if (!shim) return undefined;
	const target = read(shim).match(/"%~?dp0%?\\([^"]+?\.(?:[cm]?js|exe))"/i)?.[1];
	if (!target) return undefined;
	const full = path.win32.join(path.win32.dirname(shim), target);
	return /\.exe$/i.test(full) ? { command: full, prefix: [] } : { command: nodePath, prefix: [full] };
}

// `git worktree list --porcelain` → [{ path, branch }]
export function parseWorktrees(text) {
	return String(text ?? "")
		.split(/\r?\n\r?\n/)
		.map((block) => ({
			path: block.match(/^worktree (.+)$/m)?.[1],
			branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1],
		}))
		.filter((w) => w.path);
}

// .worktreeinclude: plain paths of ignored files to copy into a new worktree (globs are skipped).
export function parseWorktreeInclude(text) {
	return String(text ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#") && !line.startsWith("!") && !/[*?[]/.test(line));
}

export function lastLines(text, count) {
	return String(text ?? "")
		.split(/\r?\n/)
		.slice(-count)
		.join("\n");
}
