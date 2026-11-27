import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { runHook } from "./run-hook.mjs";

const run = (command, tool_name = "Bash") =>
	runHook("guard-bash.mjs", { hook_event_name: "PreToolUse", tool_name, tool_input: { command } });

const BLOCKED = [
	"rm -rf /",
	"rm -rf ~",
	"sudo rm -fr /*",
	"rm -r -f $HOME",
	"rm --recursive --force ~/",
	"cd x && RM -RF /",
	"git push --force",
	"git push -f origin main",
	"git push origin main --force-with-lease",
	"GIT RESET --HARD HEAD~1",
	"git reset --hard",
	'psql -c "DROP TABLE users"',
	'psql -c "drop database app"',
	"npx prisma migrate reset",
	"pnpm db:reset",
	"npx drizzle-kit drop",
	"git commit --no-verify -m wip",
	"gh pr merge 12 --squash",
	"Remove-Item -Recurse -Force C:\\",
	"remove-item -path $HOME -recurse -force",
	"Remove-Item $env:USERPROFILE -Recurse -Force",
	"rm -r -fo ~",
	"rd /s /q C:\\",
	"git push origin +main",
	"git push origin +HEAD:feature",
	"git push --force-if-includes",
	"git clean -fdx",
	"git clean -f",
	"git checkout -- .",
	"git checkout .",
	"git restore .",
	"git restore --staged --worktree .",
	"git -C apps/api checkout -- .",
	"git branch -D main",
	"git branch --delete --force master",
	"git push origin --delete main",
	"git push origin :main",
	"git commit -n -m wip",
	"git commit -anm wip",
	"git commit -n -m x",
	'git commit -n -m "fix: a message with spaces"',
	'git commit --no-verify -m "wip: later"',
	'git push origin "+main"',
	"git push origin '+main'",
	'git push --force -m "x y" origin',
	'psql -c "DROP TABLE users"',
	"git stash drop",
	"git stash clear",
	"Remove-Item -Recurse -Force C:\\Users\\noah",
	"Remove-Item -Recurse -Force C:\\Users\\noah\\",
	"rm -rf /home/noah",
	"rm -rf /Users/noah/",
	"rm -rf /home",
	"rm -rf /root",
	'rm -rf "$HOME"/*',
	"rm -rf '~'",
	"git checkout -f",
	"git checkout --force main",
	"git switch -f main",
	"git switch --discard-changes main",
	"git -c core.hooksPath=/dev/null commit -m x",
	'git commit -m "drop table users" && psql -c "DROP TABLE users"',
];

const ALLOWED = [
	"rm -rf node_modules",
	"rm -rf ./dist",
	"rm -f /tmp/file.txt",
	"Remove-Item -Recurse -Force .\\dist",
	"git push",
	"git push -u origin feat/notes",
	"git push --follow-tags",
	"git reset --soft HEAD~1",
	"git reset HEAD file.ts",
	"pnpm db:migrate",
	"pnpm verify",
	"gh pr view 12 --json mergeable",
	"gh pr list --search merged",
	"echo dropped tables are fine to mention",
	"git commit -m 'verify the thing'",
	'git commit -m "fix: support the -n flag"',
	"git commit -m 'docs: explain --no-verify and git push --force'",
	'git commit -m "chore: git reset --hard is blocked" -m "and git clean -fdx too"',
	'echo "git push origin +main"',
	'git log --grep "stash drop"',
	"git clean -n",
	"git checkout feature",
	"git checkout -b epic/notes",
	"git checkout -- src/app.ts",
	"git restore src/app.ts",
	"git restore --staged .",
	"git branch -D epic/notes",
	"git branch -d mainline-fix",
	"git push origin --delete epic/old",
	"git push -u origin HEAD",
	"git commit --no-edit",
	"git commit --amend -m 'x'",
	"git stash",
	"git stash pop",
	"rm -rf /home/noah/project/dist",
	'git commit -m "feat: drop table legacy_notes after the release"',
	'gh pr create --title "chore: DROP TABLE legacy_notes" --body x',
	'git commit -m "docs: never run pnpm db:reset in production"',
	"git log --grep commit -n 5",
	"git -c core.hooksPath=.githooks commit -m x",
	"git switch main",
	"git checkout -b fix",
	"Remove-Item -Recurse -Force C:\\Users\\noah\\project\\dist",
];

describe("guard-bash", () => {
	for (const command of BLOCKED) {
		test(`blocks: ${command}`, () => {
			const { code, stderr } = run(command);
			assert.equal(code, 2);
			assert.match(stderr, /Blocked .*Ask the user/);
		});
	}

	for (const command of ALLOWED) {
		test(`allows: ${command}`, () => {
			const { code, stderr } = run(command);
			assert.equal(code, 0, stderr);
		});
	}

	test("checks PowerShell tool calls too", () => {
		assert.equal(run("Remove-Item -Recurse -Force ~", "PowerShell").code, 2);
	});

	test("also protects the base branch named in runway.json", async () => {
		const { check } = await import("../scripts/guard-bash.mjs");
		assert.match(check("git branch -D trunk", { base: "trunk" }), /Blocked deleting the trunk branch/);
		assert.equal(check("git branch -D trunk"), undefined);
	});

	test("blocks pushes that update the base branch", async () => {
		const { check } = await import("../scripts/guard-bash.mjs");
		const blocked = [
			["git push", "main"],
			["git push -u origin HEAD", "main"],
			['git commit -m "x y" && git push', "main"],
			["git push origin HEAD:main", "feat"],
			["git push origin feat:refs/heads/main", "feat"],
			["git push origin main", "feat"],
			["git push origin master", undefined],
			["git push --all", "feat"],
			["git push origin trunk", "feat", "trunk"],
		];
		for (const [command, branch, base = "main"] of blocked)
			assert.match(check(command, { base, branch }) ?? "", /Blocked pushing to/, `${command} on ${branch}`);
		const allowed = [
			["git push", "feat"],
			["git push -u origin HEAD", "epic/notes"],
			["git push origin HEAD:epic/notes", "main"],
			["git push -o ci.skip origin feat", "main"],
			["git push origin --delete epic/old", "main"],
			["git push", undefined],
		];
		for (const [command, branch] of allowed) assert.equal(check(command, { base: "main", branch }), undefined, `${command} on ${branch}`);
	});

	test("finds the checked-out branch from the event's cwd", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "guard-push-"));
		try {
			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
			const event = { hook_event_name: "PreToolUse", tool_name: "Bash", cwd: dir, tool_input: { command: "git push -u origin HEAD" } };
			assert.equal(runHook("guard-bash.mjs", event).code, 2);
			execFileSync("git", ["switch", "-q", "-c", "feat"], { cwd: dir });
			assert.equal(runHook("guard-bash.mjs", event).code, 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("blocks gh pr create where runway is set up, unless ship or epic-plan is running", async () => {
		const { check } = await import("../scripts/guard-bash.mjs");
		for (const command of ["gh pr create --base main --title x --body-file b.md", "gh pr new", 'cd x && gh pr create --title "a b"'])
			assert.match(check(command, { prAllowed: false }) ?? "", /Blocked gh pr create: .*\/runway:ship/, command);
		assert.equal(check("gh pr create --title x", { prAllowed: true }), undefined);
		assert.equal(check("gh pr create --title x"), undefined);
		for (const command of ["gh pr view 2", "gh pr edit 2 --body-file b.md", "gh pr ready 2", "gh pr list"])
			assert.equal(check(command, { prAllowed: false }), undefined, command);
	});

	test("reads the session's latest slash command from the transcript", async () => {
		const { lastSlashCommand } = await import("../scripts/guard-bash.mjs");
		const prompt = (name) => ({ type: "user", message: { role: "user", content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args></command-args>` } });
		const say = (text) => ({ type: "user", message: { role: "user", content: text } });
		const toolOutput = (text) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: text }] } });
		const skillBody = { type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: "<command-name>/runway:ship</command-name>" }] } };
		const jsonl = (...entries) => entries.map((e) => JSON.stringify(e)).join("\n");

		assert.equal(lastSlashCommand(jsonl(prompt("runway:ship"), say("yes, fix that"))), "runway:ship");
		assert.equal(lastSlashCommand(jsonl(prompt("runway:ship"), prompt("runway:spec"), say("Open the PR"))), "runway:spec");
		assert.equal(lastSlashCommand(jsonl(prompt("runway:spec"), toolOutput("<command-name>/runway:ship</command-name>"))), "runway:spec");
		assert.equal(lastSlashCommand(jsonl(prompt("runway:spec"), skillBody)), "runway:spec");
		assert.equal(lastSlashCommand(jsonl(say("open the PR"))), undefined);
		assert.equal(lastSlashCommand("not json\n"), undefined);
		assert.equal(lastSlashCommand(""), undefined);
	});

	test("the hook allows gh pr create only after /runway:ship or /runway:epic-plan, where runway is set up", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "guard-pr-"));
		try {
			execFileSync("git", ["init", "-q", "-b", "feat"], { cwd: dir });
			const transcript = path.join(dir, "t.jsonl");
			const prompt = (name) => JSON.stringify({ type: "user", message: { role: "user", content: `<command-name>/${name}</command-name>` } });
			const event = { hook_event_name: "PreToolUse", tool_name: "Bash", cwd: dir, transcript_path: transcript, tool_input: { command: "gh pr create --title x" } };

			writeFileSync(transcript, prompt("runway:spec"));
			assert.equal(runHook("guard-bash.mjs", event).code, 0, "not set up: left alone");

			mkdirSync(path.join(dir, ".claude"));
			writeFileSync(path.join(dir, ".claude", "runway.json"), JSON.stringify({ verifyCommand: "npm test" }));
			const spec = runHook("guard-bash.mjs", event);
			assert.equal(spec.code, 2);
			assert.match(spec.stderr, /Blocked gh pr create/);
			assert.equal(runHook("guard-bash.mjs", { ...event, transcript_path: undefined }).code, 2, "no transcript");

			for (const name of ["runway:ship", "runway:epic-plan"]) {
				writeFileSync(transcript, prompt(name));
				assert.equal(runHook("guard-bash.mjs", event).code, 0, name);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("lets an empty or malformed event through", () => {
		assert.equal(runHook("guard-bash.mjs", {}).code, 0);
	});
});
