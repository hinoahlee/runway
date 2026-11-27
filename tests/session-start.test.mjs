import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { runHook } from "./run-hook.mjs";

let dir;
const start = () => runHook("session-start.mjs", { hook_event_name: "SessionStart", cwd: dir });
const exclude = () => readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8");
const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });

describe("session-start", () => {
	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "session-start-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("adds the output folders to .git/info/exclude, so git ignores them", () => {
		git("init", "-q");
		assert.equal(start().code, 0);
		assert.match(exclude(), /^# runway plugin output$/m);
		assert.match(exclude(), /^\.claude\/screenshots\/$/m);
		mkdirSync(path.join(dir, ".playwright-mcp"));
		writeFileSync(path.join(dir, ".playwright-mcp", "page.png"), "x");
		mkdirSync(path.join(dir, ".claude", "logs"), { recursive: true });
		writeFileSync(path.join(dir, ".claude", "logs", "verify.log"), "x");
		mkdirSync(path.join(dir, ".runway", "specs", "epic"), { recursive: true });
		writeFileSync(path.join(dir, ".runway", "specs", "epic", "billing.md"), "x");
		assert.equal(git("status", "--porcelain"), "");
	});

	test("adds them once across sessions and keeps existing lines", () => {
		git("init", "-q");
		writeFileSync(path.join(dir, ".git", "info", "exclude"), "*.local");
		start();
		start();
		const text = exclude();
		assert.match(text, /^\*\.local$/m);
		assert.equal(text.match(/\.playwright-mcp\//g).length, 1);
	});

	test("points the user to /runway:setup where runway is not set up", () => {
		git("init", "-q");
		const { code, stdout } = start();
		assert.equal(code, 0);
		assert.match(JSON.parse(stdout).systemMessage, /\/runway:setup/);
	});

	test("shows the setup note only once per repository", () => {
		git("init", "-q");
		assert.match(start().stdout, /runway:setup/);
		assert.equal(start().stdout.trim(), "");
		assert.equal(start().stdout.trim(), "");
	});

	test("reports invalid settings in every session", () => {
		git("init", "-q");
		mkdirSync(path.join(dir, ".claude"));
		writeFileSync(path.join(dir, ".claude", "runway.json"), "{ not json");
		for (let i = 0; i < 2; i++) assert.match(JSON.parse(start().stdout).systemMessage, /settings are invalid/);
	});

	test("says nothing once runway.json exists", () => {
		git("init", "-q");
		mkdirSync(path.join(dir, ".claude"));
		writeFileSync(path.join(dir, ".claude", "runway.json"), JSON.stringify({ verifyCommand: "npm test" }));
		assert.equal(start().stdout.trim(), "");
	});

	test("does nothing outside a git repository", () => {
		const { code, stdout } = start();
		assert.equal(code, 0);
		assert.equal(stdout.trim(), "");
	});
});
