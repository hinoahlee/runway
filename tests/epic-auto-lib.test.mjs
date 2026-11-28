import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	CODING_TOOLS,
	epicBranch,
	isEpicBranch,
	limitResetAt,
	modelArgs,
	newStrays,
	nextSlice,
	parseSlices,
	parseWorktreeInclude,
	parseWorktrees,
	readMarkers,
	resolveClaude,
	resumeFor,
	runnerAlive,
	samePath,
	sessionCost,
	stepOf,
	unattendedPrompt,
	untrackedPaths,
} from "../scripts/epic-auto-lib.mjs";

describe("resuming a stopped run", () => {
	const where = "C:/repo/.claude/worktrees/epic-notes";
	const done = (n) => ({ number: n, status: "done" });
	const todo = (n) => ({ number: n, status: "todo" });

	test("the step is the next slice, or ship once every slice is done", () => {
		assert.equal(stepOf([done(1), todo(2)]), 2);
		assert.equal(stepOf([done(1), done(2)]), "ship");
	});

	test("resumes the session saved for the slice still being built", () => {
		assert.equal(resumeFor({ cwd: where, id: "s1", slice: 2 }, { where, step: stepOf([done(1), todo(2)]) }), "s1");
	});

	test("a slice session is not resumed to ship once every slice is done", () => {
		assert.equal(resumeFor({ cwd: where, id: "s1", slice: 2 }, { where, step: stepOf([done(1), done(2)]) }), undefined);
	});

	test("a slice session is not resumed for another slice", () => {
		assert.equal(resumeFor({ cwd: where, id: "s1", slice: 1 }, { where, step: 2 }), undefined);
	});

	test("a ship session is resumed to ship, never to build a slice", () => {
		assert.equal(resumeFor({ cwd: where, id: "s9", slice: "ship" }, { where, step: "ship" }), "s9");
		assert.equal(resumeFor({ cwd: where, id: "s9", slice: "ship" }, { where, step: 3 }), undefined);
	});

	test("nothing saved, or saved in another worktree", () => {
		assert.equal(resumeFor(undefined, { where, step: 1 }), undefined);
		assert.equal(resumeFor(null, { where, step: 1 }), undefined);
		assert.equal(resumeFor({ cwd: "C:/elsewhere", id: "s1", slice: 1 }, { where, step: 1 }), undefined);
	});
});

describe("epic branches", () => {
	test("one branch per epic, matched exactly", () => {
		assert.equal(epicBranch("billing"), "epic/billing");
		assert.equal(isEpicBranch("epic/billing", "billing"), true);
		assert.equal(isEpicBranch("epic/billing-pro", "billing"), false);
		assert.equal(isEpicBranch("epic/billing/x", "billing"), false);
		assert.equal(isEpicBranch("billing", "billing"), false);
	});
});

describe("parseSlices", () => {
	const EPIC = `# Epic: Notes

## PR plan
| # | Scope | Status |
|---|---|---|
| 9 | not this table | todo |

## Slices
Built in order.

| # | Scope | Risk | Dev action | Status |
|---|---|---|---|---|
| 1 | Schema | high | - | done |
| 2 | API | Medium | add RESEND_KEY | todo |
| 3 | UI, with a pipe-free scope | low | - | todo |

Risk: ...

## Decisions
| 4 | not a slice | low | - | todo |
`;

	test("reads the Slices table only, in order", () => {
		assert.deepEqual(parseSlices(EPIC), [
			{ number: 1, scope: "Schema", risk: "high", status: "done" },
			{ number: 2, scope: "API", risk: "medium", status: "todo" },
			{ number: 3, scope: "UI, with a pipe-free scope", risk: "low", status: "todo" },
		]);
	});

	test("the next slice is the first one not done", () => {
		assert.equal(nextSlice(parseSlices(EPIC)).number, 2);
		assert.equal(nextSlice([{ number: 1, status: "done" }]), undefined);
	});

	test("columns are found by name", () => {
		const text = "## Slices\n| Status | # | Scope |\n|-|-|-|\n| Done | 1 | a |\n";
		assert.deepEqual(parseSlices(text), [{ number: 1, scope: "a", risk: "", status: "done" }]);
	});

	test("no table: no slices", () => {
		assert.deepEqual(parseSlices("# Epic\n\nNothing here."), []);
	});
});

describe("readMarkers", () => {
	test("reads a stop reason on its own line, also in backticks", () => {
		assert.equal(readMarkers("Tried everything.\nRUNWAY-STOP: add STRIPE_KEY in Render\n").stop, "add STRIPE_KEY in Render");
		assert.equal(readMarkers("`RUNWAY-STOP: x`").stop, "x");
	});

	test("ignores a marker quoted inside a sentence", () => {
		assert.equal(readMarkers("I would end with RUNWAY-STOP: x if blocked.").stop, undefined);
	});
});

describe("limitResetAt", () => {
	const now = new Date(2026, 10, 26, 13, 5);

	test("uses a unix reset time", () => {
		const at = limitResetAt("Claude AI usage limit reached|1795000000", now);
		assert.equal(at.getTime(), 1795000000 * 1000 + 120_000);
	});

	test("uses a clock reset time later today", () => {
		const at = limitResetAt("5-hour limit reached ∙ resets 3pm", now);
		assert.equal(at.getHours(), 15);
		assert.equal(at.getMinutes(), 2);
		assert.equal(at.getDate(), 26);
	});

	test("reads a clock time in the time zone the message names, not this machine's", () => {
		const utcNow = new Date(Date.UTC(2026, 10, 26, 14, 0)); // 9:00 in New York (EST, UTC-5)
		const at = limitResetAt("5-hour limit reached ∙ resets 3pm (America/New_York)", utcNow);
		assert.equal(at.toISOString(), "2026-11-26T20:02:00.000Z");
	});

	test("a named zone whose reset time has passed rolls to tomorrow there", () => {
		const utcNow = new Date(Date.UTC(2026, 10, 26, 21, 0)); // 16:00 in New York
		const at = limitResetAt("resets 3pm (America/New_York) usage limit", utcNow);
		assert.equal(at.toISOString(), "2026-11-27T20:02:00.000Z");
	});

	test("rolls a passed clock time to tomorrow", () => {
		const at = limitResetAt("Session limit reached, resets at 9:30am", now);
		assert.equal(at.getDate(), 27);
		assert.equal(at.getHours(), 9);
		assert.equal(at.getMinutes(), 32);
	});

	test("waits 15 minutes when the reset time is unreadable", () => {
		const at = limitResetAt("You've hit your usage limit.", now);
		assert.equal(at.getTime() - now.getTime(), 15 * 60_000);
	});

	test("is undefined for other errors", () => {
		assert.equal(limitResetAt("Error: ENOENT", now), undefined);
	});
});

describe("resolveClaude", () => {
	test("RUNWAY_CLAUDE_BIN wins", () => {
		assert.deepEqual(resolveClaude({ platform: "win32", env: { RUNWAY_CLAUDE_BIN: "C:\\c.exe" } }), {
			command: "C:\\c.exe",
			prefix: [],
		});
	});

	test("macOS and Linux run claude from PATH", () => {
		assert.deepEqual(resolveClaude({ platform: "linux" }), { command: "claude", prefix: [] });
	});

	test("Windows prefers claude.exe", () => {
		const where = () => ["C:\\npm\\claude", "C:\\npm\\claude.cmd", "C:\\Users\\me\\.local\\bin\\claude.exe"];
		assert.equal(resolveClaude({ platform: "win32", where }).command, "C:\\Users\\me\\.local\\bin\\claude.exe");
	});

	test("Windows npm shim: runs the script it points to with Node, no cmd.exe", () => {
		const shim = `@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`;
		const r = resolveClaude({
			platform: "win32",
			where: () => ["C:\\npm\\claude", "C:\\npm\\claude.cmd"],
			read: () => shim,
			nodePath: "C:\\node\\node.exe",
		});
		assert.deepEqual(r, {
			command: "C:\\node\\node.exe",
			prefix: ["C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"],
		});
	});

	test("Windows npm shim to a native binary", () => {
		const shim = `"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*`;
		const r = resolveClaude({ platform: "win32", where: () => ["C:\\npm\\claude.cmd"], read: () => shim });
		assert.deepEqual(r, { command: "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe", prefix: [] });
	});

	test("Windows with nothing usable", () => {
		assert.equal(resolveClaude({ platform: "win32", where: () => [] }), undefined);
		assert.equal(resolveClaude({ platform: "win32", where: () => ["C:\\x\\claude.cmd"], read: () => "@echo off" }), undefined);
	});
});

describe("parsers", () => {
	test("parseWorktrees", () => {
		const text = "worktree C:/r\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/r/.claude/worktrees/x\nHEAD def\nbranch refs/heads/epic/notes\n";
		assert.deepEqual(parseWorktrees(text), [
			{ path: "C:/r", branch: "main" },
			{ path: "C:/r/.claude/worktrees/x", branch: "epic/notes" },
		]);
	});

	test("parseWorktreeInclude keeps plain paths only", () => {
		assert.deepEqual(parseWorktreeInclude("# env\napps/api/.env\n\n*.local\n!x\n"), ["apps/api/.env"]);
	});
});

describe("prompts and tools", () => {
	test("a slice session builds one slice and does not ship", () => {
		const text = unattendedPrompt("/runway", { mode: "slice" });
		assert.match(text, /exactly one slice/);
		assert.match(text, /Do not run ship/);
		assert.match(text, /RUNWAY-STOP/);
		assert.match(text, /Never merge/);
	});

	test("the ship session follows the ship skill", () => {
		assert.match(unattendedPrompt("/runway", { mode: "ship" }), /\/runway\/skills\/ship\/SKILL\.md/);
	});

	test("a fix session neither ships nor opens a PR", () => {
		const text = unattendedPrompt("/runway");
		assert.doesNotMatch(text, /skills\/ship/);
		assert.match(text, /Do not run ship or open a PR/);
	});

	test("headless sessions get runway's browser tools and never gh pr merge", () => {
		assert.ok(CODING_TOOLS.includes("mcp__plugin_runway_playwright"));
		assert.ok(!CODING_TOOLS.some((t) => /merge/.test(t)));
		// verify stops the dev server it started, on every OS.
		for (const tool of ["Bash(taskkill:*)", "Bash(kill:*)", "Bash(pkill:*)", "Bash(lsof:*)"]) assert.ok(CODING_TOOLS.includes(tool), tool);
	});

	// Whether every part of a shell command (split on pipes, `&&`, `||` and `;`, redirections dropped) matches a
	// `Bash(<prefix>:*)` entry, the way Claude Code checks a compound command against --allowedTools.
	const allowed = (command) =>
		command
			.split(/\|\||&&|[|;]/)
			.map((part) => part.replace(/\d?>&?\s*\S+/g, "").trim())
			.filter(Boolean)
			.every((part) =>
				CODING_TOOLS.some((tool) => {
					const prefix = tool.match(/^Bash\((.+):\*\)$/)?.[1];
					return prefix !== undefined && (part === prefix || part.startsWith(`${prefix} `));
				}),
			);

	test("headless sessions may run every shell command the skills and agents tell them to", () => {
		// Each command the skills and agents that unattended sessions run (epic-next, spec, implement, verify, ship
		// and the five agents) instruct, as written there, with the verify command filled in. Add new ones here.
		const instructed = [
			'node "/runway/scripts/config.mjs" --security-files origin/main...HEAD',
			'node "/runway/scripts/prepare-worktree.mjs" epic-notes --base main',
			"mkdir -p .claude/logs; pnpm verify > .claude/logs/verify.log 2>&1; echo \"exit $?\"; tail -n 3 .claude/logs/verify.log",
			"tail -n 60 .claude/logs/verify.log",
			"grep -n FAIL .claude/logs/verify.log",
			"git diff origin/main...HEAD --stat",
			"git fetch && git for-each-ref --format=\"%(refname:short)\" refs/remotes/origin/epic/",
			"git status --porcelain",
			"git checkout -- src/app.ts",
			"git add src/app.test.ts",
			"git push -u origin HEAD",
			"curl --retry 60 --retry-delay 2 --retry-connrefused -sf -o /dev/null http://localhost:3000",
			"netstat -ano",
			"taskkill /PID 123 /T /F",
			"lsof -ti :3000",
			"kill 123",
			'pkill -f "pnpm dev"',
			"gh pr view --json number,isDraft,title",
			'gh pr edit 7 --title "feat: notes" --body-file /tmp/body.md',
			"gh pr ready 7",
			'gh pr create --base main --title "feat: notes" --body-file /tmp/body.md',
			// What the test-auditor ran in a real ship session, denied for `tail` before it was allowed.
			"cd /repo && git status --porcelain && git diff --stat origin/main...HEAD | tail -60 && ls .runway/specs/epic/notes",
			"pnpm vitest run src/app.test.ts > .claude/logs/audit.log 2>&1; echo \"exit $?\"; head -n 40 .claude/logs/audit.log",
			"git diff origin/main...HEAD | wc -l",
		];
		for (const command of instructed) assert.ok(allowed(command), command);
		// The matcher itself: a command outside the list is refused.
		assert.ok(!allowed("git status | sed -i s/a/b/ file"));
		assert.ok(!allowed("gh pr merge 7"));
	});
});

describe("models, cost and strays", () => {
	test("--model comes from the model setting, unless claudeSettings sets one", () => {
		assert.deepEqual(modelArgs({ model: "sonnet" }), ["--model", "sonnet"]);
		assert.deepEqual(modelArgs({ model: "opus", claudeSettings: { model: "claude-haiku-5-5" } }), []);
		assert.deepEqual(modelArgs({ model: "sonnet", claudeSettings: { sandbox: {} } }), ["--model", "sonnet"]);
		assert.deepEqual(modelArgs({ model: "inherit" }), []);
		assert.deepEqual(modelArgs({}), []);
	});

	test("a session's cost line, and none without a cost", () => {
		const cost = sessionCost({ total_cost_usd: 1.234, num_turns: 40, usage: { output_tokens: 21_400, cache_read_input_tokens: 3_040_000, cache_creation_input_tokens: 114_000 } });
		assert.equal(cost.usd, 1.234);
		assert.equal(cost.line, "Session cost $1.23 (output 21K, cache reads 3040K, cache writes 114K, 40 turns).");
		assert.equal(sessionCost({ result: "x" }), undefined);
		assert.equal(sessionCost(undefined), undefined);
	});

	test("strays: untracked paths that appeared during the session", () => {
		const before = untrackedPaths("?? notes.txt\n M src/a.ts\n");
		const after = untrackedPaths('?? notes.txt\r\n?? slider.tsx\n?? "with space.tsx"\n');
		assert.deepEqual(before, ["notes.txt"]);
		assert.deepEqual(newStrays(before, after), ["slider.tsx", "with space.tsx"]);
	});

	test("the unattended rules: stops end in proceed, strays never stop the run", () => {
		const rules = unattendedPrompt("/p", { mode: "slice" });
		assert.match(rules, /then proceed/);
		assert.match(rules, /Never tell the developer to run a\s+runway command/);
		assert.match(rules, /outside this worktree/);
	});
});

describe("resume and liveness", () => {
	test("one folder in git's and Node's spelling is the same folder", () => {
		assert.equal(samePath("C:/Repo/.claude/worktrees/epic-x", "c:\\repo\\.claude\\worktrees\\epic-x\\", "win32"), true);
		assert.equal(samePath("/repo/a", "/repo/b", "linux"), false);
	});

	test("a runner counts as alive only with a recent heartbeat", () => {
		const now = Date.parse("2026-11-28T10:00:00Z");
		const yes = () => true;
		assert.equal(runnerAlive({ pid: 5, heartbeat: "2026-11-28T09:58:00Z" }, yes, now), true);
		assert.equal(runnerAlive({ pid: 5, heartbeat: "2026-11-28T09:00:00Z" }, yes, now), false);
		assert.equal(runnerAlive({ pid: 5 }, yes, now), false);
		assert.equal(runnerAlive({ pid: 5, heartbeat: "2026-11-28T09:58:00Z" }, () => false, now), false);
	});
});
