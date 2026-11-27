import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { toolsFor } from "../scripts/post-edit.mjs";
import { runHook } from "./run-hook.mjs";

// A fake Biome: the hook finds it through node_modules/@biomejs/biome/package.json, like the real one. `format`
// rewrites the file; `lint` fails when the file contains "LINT_ERROR". Like the real one with
// --files-ignore-unknown=true, it leaves files it doesn't handle (here .md) alone and succeeds. Each call is logged
// next to the repository it ran in.
const FAKE_BIOME = `
const fs = require("node:fs");
const [cmd, ...args] = process.argv.slice(2);
const file = args[args.length - 1];
fs.appendFileSync("calls.log", cmd + " " + file + "\\n");
if (file.endsWith(".md") && args.includes("--files-ignore-unknown=true")) process.exit(0);
if (cmd === "format") fs.writeFileSync(file, fs.readFileSync(file, "utf8").trim() + "\\n// formatted\\n");
if (cmd === "lint" && fs.readFileSync(file, "utf8").includes("LINT_ERROR")) {
	console.error(file + ":1:1 lint/suspicious/noExplicitAny  Unexpected any.");
	process.exit(1);
}
`;

let dir;
let root;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
const edit = (file_path, cwd = root, env = {}) =>
	runHook("post-edit.mjs", { hook_event_name: "PostToolUse", tool_name: "Edit", cwd, tool_input: { file_path } }, { env });
const calls = (at = root) => readFileSync(path.join(at, "calls.log"), "utf8");

function addBiome(at) {
	const pkg = path.join(at, "node_modules", "@biomejs", "biome");
	mkdirSync(path.join(pkg, "bin"), { recursive: true });
	writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ bin: { biome: "bin/biome" } }));
	writeFileSync(path.join(pkg, "bin", "biome"), FAKE_BIOME);
	writeFileSync(path.join(at, "calls.log"), "");
}

describe("post-edit", () => {
	before(() => {
		dir = mkdtempSync(path.join(tmpdir(), "post-edit-"));
		root = path.join(dir, "repo");
		mkdirSync(root);
		git(root, "init", "-q");
		git(root, "config", "user.email", "t@example.com");
		git(root, "config", "user.name", "T");
		writeFileSync(path.join(root, ".gitignore"), "node_modules/\ncalls.log\n");
		writeFileSync(path.join(root, "biome.json"), "{}");
		git(root, "add", ".");
		git(root, "commit", "-qm", "init");
		addBiome(root);
		writeFileSync(path.join(root, ".git", "runway.json"), JSON.stringify({ verifyCommand: "true" }));
	});
	after(() => rmSync(dir, { recursive: true, force: true }));

	test("formats, then lints, a covered file and passes when lint is clean", () => {
		writeFileSync(path.join(root, "ok.ts"), "export const a = 1;");
		const { code, stderr } = edit(path.join(root, "ok.ts"));
		assert.equal(code, 0, stderr);
		assert.match(readFileSync(path.join(root, "ok.ts"), "utf8"), /formatted/);
		assert.match(calls(), /format ok\.ts\nlint ok\.ts/);
	});

	test("blocks with the remaining lint errors", () => {
		writeFileSync(path.join(root, "bad.ts"), "const LINT_ERROR: any = 1;");
		const { code, stderr } = edit("bad.ts");
		assert.equal(code, 2);
		assert.match(stderr, /Lint errors remain in bad\.ts/);
		assert.match(stderr, /noExplicitAny/);
	});

	test("formats and lints YAML with Biome", () => {
		writeFileSync(path.join(root, "ci.yml"), "on: push");
		const before = calls();
		const { code, stderr } = edit("ci.yml");
		assert.equal(code, 0, stderr);
		assert.match(readFileSync(path.join(root, "ci.yml"), "utf8"), /formatted/);
		assert.equal(calls().slice(before.length), "format ci.yml\nlint ci.yml\n");
	});

	test("leaves files Biome doesn't handle to its --files-ignore-unknown", () => {
		writeFileSync(path.join(root, "notes.md"), "LINT_ERROR");
		assert.equal(edit("notes.md").code, 0);
		assert.equal(readFileSync(path.join(root, "notes.md"), "utf8"), "LINT_ERROR");
	});

	test("skips files outside the repository and in node_modules", () => {
		const before = calls();
		assert.equal(edit(path.join(tmpdir(), "elsewhere.ts")).code, 0);
		mkdirSync(path.join(root, "node_modules", "x"), { recursive: true });
		writeFileSync(path.join(root, "node_modules", "x", "index.ts"), "LINT_ERROR");
		assert.equal(edit("node_modules/x/index.ts").code, 0);
		assert.equal(calls(), before);
	});

	test("a file in a worktree is formatted by the worktree's own tools, not the main checkout's", () => {
		const wt = path.join(dir, "wt");
		git(root, "worktree", "add", "-q", "-b", "feature", wt);
		try {
			addBiome(wt);
			writeFileSync(path.join(wt, "w.ts"), "export const w = 1;");
			const mainBefore = calls();
			const { code, stderr } = edit(path.join(wt, "w.ts"), wt, { CLAUDE_PROJECT_DIR: root });
			assert.equal(code, 0, stderr);
			assert.match(calls(wt), /format w\.ts\nlint w\.ts/);
			assert.equal(calls(), mainBefore);
		} finally {
			git(root, "worktree", "remove", "--force", wt);
		}
	});

	test("does nothing where runway is not set up", () => {
		const other = path.join(dir, "other");
		mkdirSync(other);
		git(other, "init", "-q");
		writeFileSync(path.join(other, "biome.json"), "{}");
		addBiome(other);
		writeFileSync(path.join(other, "x.ts"), "const LINT_ERROR = 1;");
		assert.equal(edit(path.join(other, "x.ts"), other).code, 0);
		assert.equal(calls(other), "");
	});
});

describe("post-edit: Prettier and ESLint", () => {
	let at;
	const addPackage = (name) => {
		const pkg = path.join(at, "node_modules", name);
		mkdirSync(path.join(pkg, "bin"), { recursive: true });
		writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ bin: { [name]: `bin/${name}` } }));
		writeFileSync(path.join(pkg, "bin", name), "");
	};
	const kinds = (file) => toolsFor(at, file).map((s) => `${s.kind}:${path.basename(path.dirname(path.dirname(s.script)))} ${s.args.join(" ")}`);

	before(() => {
		at = mkdtempSync(path.join(tmpdir(), "post-edit-tools-"));
		addPackage("prettier");
		addPackage("eslint");
	});
	after(() => rmSync(at, { recursive: true, force: true }));

	test("ignores Prettier and ESLint that are only in node_modules, with no config of the repository's", () => {
		assert.deepEqual(toolsFor(at, "a.ts"), []);
	});

	test("an .eslintrc repository is linted without the flat-config-only --no-warn-ignored", () => {
		writeFileSync(path.join(at, ".eslintrc.json"), "{}");
		try {
			assert.deepEqual(kinds("a.ts"), ["lint:eslint --fix a.ts"]);
		} finally {
			rmSync(path.join(at, ".eslintrc.json"));
		}
	});

	test("a flat config gets --no-warn-ignored; a prettier key in package.json turns Prettier on", () => {
		writeFileSync(path.join(at, "eslint.config.js"), "export default [];");
		writeFileSync(path.join(at, "package.json"), JSON.stringify({ prettier: {} }));
		try {
			assert.deepEqual(kinds("a.ts"), ["format:prettier --write --ignore-unknown a.ts", "lint:eslint --fix --no-warn-ignored a.ts"]);
		} finally {
			rmSync(path.join(at, "eslint.config.js"));
			rmSync(path.join(at, "package.json"));
		}
	});
});
