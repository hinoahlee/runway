import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { checks, formatTools, githubRepo, protectionFrom, skippedTestRule } from "../scripts/doctor.mjs";

describe("githubRepo", () => {
	test("https, ssh and scp-like GitHub URLs", () => {
		assert.equal(githubRepo("https://github.com/hinoahlee/runway.git"), "hinoahlee/runway");
		assert.equal(githubRepo("https://token@github.com/a/b"), "a/b");
		assert.equal(githubRepo("git@github.com:a/b.git"), "a/b");
		assert.equal(githubRepo("ssh://git@github.com/a/b.git"), "a/b");
		assert.equal(githubRepo("ssh://git@github.com:22/a/b"), "a/b");
	});

	test("anything else is not GitHub", () => {
		assert.equal(githubRepo("https://gitlab.com/a/b.git"), undefined);
		assert.equal(githubRepo("https://github.com.evil.example/a/b"), undefined);
		assert.equal(githubRepo("C:/repos/origin.git"), undefined);
		assert.equal(githubRepo(""), undefined);
	});
});

describe("checks: gh sign-in and the GitHub remote", () => {
	let dir;
	let gh;
	const lines = (env, only) => {
		process.env.FAKE_GH = JSON.stringify(env);
		return checks(dir, only, { gh: [process.execPath, gh] });
	};
	const line = (all, name) => all.find((l) => l.split(":")[0].endsWith(` ${name}`));

	before(() => {
		dir = mkdtempSync(path.join(tmpdir(), "doctor-checks-"));
		execFileSync("git", ["init", "-q"], { cwd: dir });
		execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/shop.git"], { cwd: dir });
		// A fake gh: `auth status` follows FAKE_GH.signedIn; `api` answers FAKE_GH.rules for rules/branches.
		gh = path.join(dir, "..", `fake-gh-${path.basename(dir)}.mjs`);
		writeFileSync(
			gh,
			`const env = JSON.parse(process.env.FAKE_GH);
			 const [cmd, arg] = process.argv.slice(2);
			 if (cmd === "auth") process.exit(env.signedIn ? 0 : 1);
			 if (cmd === "api" && arg.includes("/rules/branches/")) { console.log(JSON.stringify(env.rules ?? [])); process.exit(0); }
			 process.exit(1);`,
		);
	});
	after(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(gh, { force: true });
	});

	test("not signed in: the remote is still found, and protection says why it cannot check", () => {
		const all = lines({ signedIn: false });
		assert.match(line(all, "gh"), /^FAIL gh: .*not signed in/);
		assert.equal(line(all, "github"), "PASS github: origin is acme/shop");
		assert.equal(line(all, "protection"), "WARN protection: cannot check: gh is not signed in. Fix: run `gh auth login`, then check again");
	});

	test("signed in, branch rules in place", () => {
		const all = lines({ signedIn: true, rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "pull_request" }] }, "protection");
		assert.deepEqual(all, ["PASS protection: main blocks force pushes, deletion and pushes without a PR on GitHub"]);
	});

	test("signed in, no rules: points to the shipped example ruleset, not another repository", () => {
		const [warn] = lines({ signedIn: true, rules: [] }, "protection");
		assert.match(warn, /^WARN protection: main does not block force pushes, deletion and pushes without a PR on GitHub/);
		assert.match(warn, /repos\/acme\/shop\/rulesets --method POST --input ".*templates[\\/]ruleset\.json"/);
	});

	test("an origin that is not GitHub", () => {
		execFileSync("git", ["remote", "set-url", "origin", "https://gitlab.com/acme/shop.git"], { cwd: dir });
		try {
			const all = lines({ signedIn: true });
			assert.match(line(all, "github"), /^FAIL github: origin is not on GitHub/);
			assert.match(line(all, "protection"), /^WARN protection: cannot check: origin is not a GitHub repository/);
		} finally {
			execFileSync("git", ["remote", "set-url", "origin", "git@github.com:acme/shop.git"], { cwd: dir });
		}
	});
});

describe("protectionFrom", () => {
	test("a ruleset that blocks force pushes and deletion and requires a PR", () => {
		assert.deepEqual(protectionFrom([{ type: "deletion" }, { type: "non_fast_forward" }, { type: "pull_request" }]), {
			forcePush: true,
			deletion: true,
			pullRequest: true,
		});
	});

	test("classic branch protection", () => {
		const classic = { allow_force_pushes: { enabled: false }, allow_deletions: { enabled: true } };
		assert.deepEqual(protectionFrom([], classic), { forcePush: true, deletion: false, pullRequest: false });
		const reviews = { ...classic, required_pull_request_reviews: { required_approving_review_count: 1 } };
		assert.equal(protectionFrom([], reviews).pullRequest, true);
	});

	test("nothing, or an error answer", () => {
		const none = { forcePush: false, deletion: false, pullRequest: false };
		assert.deepEqual(protectionFrom(undefined, undefined), none);
		assert.deepEqual(protectionFrom({ message: "Not Found" }, undefined), none);
	});
});

describe("skippedTestRule", () => {
	const inRepo = (files, check) => {
		const dir = mkdtempSync(path.join(tmpdir(), "doctor-"));
		try {
			for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
			check(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};

	test("Biome with noSkippedTests on", () => {
		inRepo({ "biome.json": '{"linter":{"rules":{"suspicious":{"noSkippedTests":"error"}}}}' }, (dir) => {
			assert.deepEqual(skippedTestRule(dir), { linter: "biome", rule: "lint/suspicious/noSkippedTests" });
		});
	});

	test("Biome with it off", () => {
		inRepo({ "biome.json": '{"linter":{"rules":{"suspicious":{"noSkippedTests":"off"}}}}' }, (dir) => {
			assert.equal(skippedTestRule(dir), undefined);
		});
	});

	test("an ESLint rule", () => {
		inRepo({ "eslint.config.js": "export default [{ rules: { 'playwright/no-skipped-test': 'error' } }];" }, (dir) => {
			assert.equal(skippedTestRule(dir).rule, "playwright/no-skipped-test");
		});
	});

	test("no linter", () => {
		inRepo({}, (dir) => assert.equal(skippedTestRule(dir), undefined));
	});
});

describe("formatTools", () => {
	let dir;
	before(() => {
		dir = mkdtempSync(path.join(tmpdir(), "doctor-format-"));
	});
	after(() => rmSync(dir, { recursive: true, force: true }));
	const install = (name) => {
		const pkg = path.join(dir, "node_modules", name);
		mkdirSync(path.join(pkg, "bin"), { recursive: true });
		writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ bin: { [name]: `bin/${name}` } }));
	};

	test("nothing installed: none", () => {
		assert.deepEqual(formatTools(dir), []);
	});

	test("installed but not configured: none, so setup warns", () => {
		install("prettier");
		install("eslint");
		assert.deepEqual(formatTools(dir), []);
	});

	test("installed and configured: names them", () => {
		writeFileSync(path.join(dir, ".prettierrc"), "{}");
		writeFileSync(path.join(dir, "eslint.config.js"), "export default [];");
		assert.deepEqual(formatTools(dir), ["prettier", "eslint"]);
	});
});
