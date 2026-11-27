import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { globToRegExp, loadConfig, securityFiles, validate } from "../scripts/config.mjs";

const CONFIG = path.join(import.meta.dirname, "..", "scripts", "config.mjs");

let dir;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
const committed = (value) => {
	mkdirSync(path.join(dir, ".claude"), { recursive: true });
	writeFileSync(path.join(dir, ".claude", "runway.json"), typeof value === "string" ? value : JSON.stringify(value));
};

describe("config", () => {
	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "runway-config-"));
		git(dir, "init", "-q");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("no file: not set up", () => {
		assert.equal(loadConfig(dir).reason, "not-set-up");
	});

	test("the committed file, with defaults filled in", () => {
		committed({ verifyCommand: "pnpm verify" });
		const r = loadConfig(dir);
		assert.equal(r.ok, true);
		assert.deepEqual(r.config, {
			verifyCommand: "pnpm verify",
			epicsDir: "docs/epics",
			baseBranch: "main",
			model: "sonnet",
			reviewModel: "opus",
		});
	});

	test("the clone-only file inside .git, when nothing is committed", () => {
		writeFileSync(path.join(dir, ".git", "runway.json"), JSON.stringify({ verifyCommand: "npm test", baseBranch: "trunk" }));
		assert.equal(loadConfig(dir).config.baseBranch, "trunk");
	});

	test("the committed file wins over the clone-only one", () => {
		committed({ verifyCommand: "a" });
		writeFileSync(path.join(dir, ".git", "runway.json"), JSON.stringify({ verifyCommand: "b" }));
		assert.equal(loadConfig(dir).config.verifyCommand, "a");
	});

	test("found from a subfolder", () => {
		committed({ verifyCommand: "a" });
		mkdirSync(path.join(dir, "src", "deep"), { recursive: true });
		assert.equal(loadConfig(path.join(dir, "src", "deep")).ok, true);
	});

	test("invalid JSON and invalid values are reported, not used", () => {
		committed("{ nope");
		assert.equal(loadConfig(dir).reason, "invalid");
		assert.match(validate({}), /verifyCommand/);
		assert.match(validate({ verifyCommand: "x", extra: 1 }), /unknown key "extra"/);
		assert.match(validate({ verifyCommand: "x", epicsDir: "../out" }), /epicsDir/);
		assert.match(validate({ verifyCommand: "x", baseBranch: "--force" }), /baseBranch/);
		assert.match(validate({ verifyCommand: "x", model: "--dangerously-skip" }), /model/);
		assert.match(validate({ verifyCommand: "x", reviewModel: "" }), /reviewModel/);
		assert.equal(validate({ verifyCommand: "x", model: "claude-opus-5-5[1m]", reviewModel: "inherit" }), undefined);
		assert.equal(validate({ $schema: "s", verifyCommand: "x", claudeSettings: { sandbox: { enabled: true } } }), undefined);
		assert.equal(validate({ verifyCommand: "x", securityPaths: ["src/api/**"] }), undefined);
		assert.equal(validate({ verifyCommand: "x", securityPaths: [] }), undefined);
		assert.match(validate({ verifyCommand: "x", securityPaths: "src/**" }), /securityPaths/);
		assert.match(validate({ verifyCommand: "x", securityPaths: ["ok/**", ""] }), /securityPaths/);
	});

	test("--security-files lists the changed files that match securityPaths, or NONE", () => {
		const run = (...args) => execFileSync(process.execPath, [CONFIG, ...args, "--cwd", dir], { encoding: "utf8" }).trim();
		git(dir, "config", "user.email", "t@example.com");
		git(dir, "config", "user.name", "T");
		committed({ verifyCommand: "a", securityPaths: ["src/secure/**"] });
		git(dir, "add", ".");
		git(dir, "commit", "-qm", "init");
		mkdirSync(path.join(dir, "src", "secure"), { recursive: true });
		writeFileSync(path.join(dir, "README.md"), "x");
		git(dir, "add", ".");
		git(dir, "commit", "-qm", "docs");
		assert.equal(run("--security-files", "HEAD~1..HEAD"), "NONE");
		writeFileSync(path.join(dir, "src", "secure", "a.ts"), "x");
		git(dir, "add", ".");
		git(dir, "commit", "-qm", "code");
		assert.equal(run("--security-files", "HEAD~2..HEAD"), "src/secure/a.ts");
	});

	test("the settings printed by default leave out the security globs", () => {
		committed({ verifyCommand: "a" });
		assert.equal(loadConfig(dir).config.securityPaths, undefined);
	});

	test("outside a git repository: not set up", () => {
		const plain = mkdtempSync(path.join(tmpdir(), "runway-plain-"));
		try {
			assert.equal(loadConfig(plain).reason, "not-set-up");
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});
});

describe("security paths", () => {
	test("globs: ** spans folders, * stays in one, braces choose, case is ignored", () => {
		assert.ok(globToRegExp("**/*.sql").test("a.sql"));
		assert.ok(globToRegExp("**/*.sql").test("db/x/a.sql"));
		assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
		assert.ok(globToRegExp("src/**").test("src/a/b.ts"));
		assert.ok(globToRegExp("**/{a,b.{yml,yaml}}").test("x/b.yaml"));
		assert.ok(globToRegExp("**/dockerfile*").test("Dockerfile.dev"));
		assert.ok(!globToRegExp("a.b").test("axb"));
	});

	test("the default list catches routes, auth, db, config, infra, CI, Docker and dependencies", () => {
		const risky = [
			"src/app/api/users/route.ts",
			"server/routes/orders.js",
			"src/middleware.ts",
			"src/lib/auth.ts",
			"src/session/store.ts",
			"prisma/schema.prisma",
			"db/migrations/0001_init.sql",
			"src/db/queries.ts",
			".env.example",
			"src/config/env.ts",
			"next.config.mjs",
			"infra/main.tf",
			".github/workflows/ci.yml",
			"Dockerfile",
			"docker-compose.yml",
			"package.json",
			"pnpm-lock.yaml",
			"apps/web/package.json",
			"requirements-dev.txt",
		];
		assert.deepEqual(securityFiles(risky), risky);
	});

	test("the default list leaves ordinary UI, docs and tests out", () => {
		const plain = ["src/components/Button.tsx", "README.md", "docs/guide.md", "tests/button.test.ts", "src/styles/app.css"];
		assert.deepEqual(securityFiles(plain), []);
	});

	test("a setting replaces the default list", () => {
		assert.deepEqual(securityFiles(["package.json", "lib/vault/x.ts"], ["lib/vault/**"]), ["lib/vault/x.ts"]);
		assert.deepEqual(securityFiles(["package.json"], []), []);
	});
});
