// Checks what runway needs in this repository and prints one line per check:
//   PASS <check>: <detail>
//   WARN <check>: <detail>. Fix: <what to do>
//   FAIL <check>: <detail>. Fix: <what to do>
// Used by /runway:setup (every check) and /runway:epic-auto's preflight (--only protection).
//
//   node doctor.mjs [--only <check>] [--cwd <dir>]
// It changes nothing. It does not run the verify command: the setup skill does that, because it can take minutes.
// RUNWAY_GH_BIN replaces gh with `node <file>` (tests).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, repoOf } from "./config.mjs";
import { toolsFor } from "./post-edit.mjs";

const RULESET_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "ruleset.json");

function run(program, args, cwd) {
	const r = spawnSync(program[0], [...program.slice(1), ...args], { cwd, encoding: "utf8", windowsHide: true });
	return { ok: r.status === 0 && !r.error, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.error?.message ?? "").trim() };
}

const rulesetHelp = (repo) =>
	`add a branch ruleset that blocks force pushes and deletion and requires a PR: on GitHub under Settings → Rules → Rulesets, or with \`gh api repos/${repo ?? "<owner>/<repo>"}/rulesets --method POST --input "${RULESET_FILE}"\` (it covers the default branch). Rulesets on private repositories need a paid GitHub plan`;

// owner/name from a GitHub remote URL (https, ssh or scp-like), else undefined.
export function githubRepo(url) {
	const m = String(url ?? "")
		.trim()
		.match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
	return m ? `${m[1]}/${m[2]}` : undefined;
}

// From GitHub's answers: `gh api repos/{owner}/{repo}/rules/branches/<b>` (rulesets, an array of { type }) and
// `gh api repos/{owner}/{repo}/branches/<b>/protection` (classic protection, or undefined when there is none).
export function protectionFrom(rules, protection) {
	const types = new Set((Array.isArray(rules) ? rules : []).map((r) => r?.type));
	return {
		forcePush: types.has("non_fast_forward") || protection?.allow_force_pushes?.enabled === false,
		deletion: types.has("deletion") || protection?.allow_deletions?.enabled === false,
		pullRequest: types.has("pull_request") || Boolean(protection?.required_pull_request_reviews),
	};
}

const andList = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

// The lint rule that rejects skipped tests, if the repository's linter config turns one on.
export function skippedTestRule(top) {
	for (const name of ["biome.json", "biome.jsonc"]) {
		const file = path.join(top, name);
		if (!existsSync(file)) continue;
		const match = readFileSync(file, "utf8").match(/"noSkippedTests"\s*:\s*("(\w+)"|\{[^}]*"level"\s*:\s*"(\w+)")/);
		const level = match?.[2] ?? match?.[3];
		if (level && level !== "off") return { linter: "biome", rule: "lint/suspicious/noSkippedTests" };
		// Biome's recommended set includes it.
		if (!match) return { linter: "biome", rule: "lint/suspicious/noSkippedTests", maybe: true };
		return undefined;
	}
	const eslint = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs"]
		.map((n) => path.join(top, n))
		.find(existsSync);
	if (eslint) {
		const rule = readFileSync(eslint, "utf8").match(/["']?([\w@/-]*no-(skipped|disabled)-tests?)["']?\s*:/)?.[1];
		if (rule) return { linter: "eslint", rule };
	}
	return undefined;
}

// The tools post-edit would run on a TypeScript file here, by package name.
export function formatTools(top) {
	return toolsFor(top, "check.ts").map((step) => path.basename(path.dirname(path.dirname(step.script))));
}

export function checks(cwd, only, { gh = ["gh"] } = {}) {
	const lines = [];
	const say = (level, name, detail, fix) => lines.push(`${level} ${name}: ${detail}${fix ? `. Fix: ${fix}` : ""}`);
	const want = (name) => !only || only === name;
	const repo = repoOf(cwd);
	const loaded = loadConfig(cwd);
	const config = loaded.ok ? loaded.config : { baseBranch: "main", epicsDir: "docs/epics" };

	if (want("node")) {
		const major = Number(process.versions.node.split(".")[0]);
		if (major >= 22) say("PASS", "node", `Node ${process.versions.node}`);
		else say("FAIL", "node", `Node ${process.versions.node}`, "install Node 22 or later");
	}
	if (!repo) {
		say("FAIL", "git", "not a git repository", "run runway inside a git repository");
		return lines;
	}
	if (want("git")) say("PASS", "git", repo.top);

	if (want("config")) {
		if (loaded.ok) say("PASS", "config", `${loaded.file}: ${JSON.stringify(loaded.config)}`);
		else if (loaded.reason === "invalid") say("FAIL", "config", loaded.message, "correct the file (schema: schemas/runway.schema.json)");
		else say("FAIL", "config", "no runway.json", "/runway:setup writes one");
	}

	// The remote comes from git; gh is only asked once it is known to be signed in.
	const remote = run(["git"], ["remote", "get-url", "origin"], repo.top);
	const github = remote.ok ? githubRepo(remote.out) : undefined;
	const signedIn = run(gh, ["auth", "status"], repo.top).ok;
	if (want("github")) {
		if (signedIn) say("PASS", "gh", "signed in");
		else say("FAIL", "gh", "the GitHub CLI is missing or not signed in", "install gh, then `gh auth login` and `gh auth setup-git`");
		if (github) say("PASS", "github", `origin is ${github}`);
		else if (remote.ok) say("FAIL", "github", `origin is not on GitHub (${remote.out})`, "runway works with GitHub only");
		else say("FAIL", "github", "no remote named origin", "add the GitHub repository as origin");
	}

	if (want("base")) {
		const has = run(["git"], ["rev-parse", "--verify", "--quiet", `origin/${config.baseBranch}`], repo.top).ok;
		if (has) say("PASS", "base", `origin/${config.baseBranch}`);
		else say("FAIL", "base", `origin/${config.baseBranch} not found`, "`git fetch`, or set baseBranch in runway.json");
	}

	if (want("protection")) {
		if (!github) say("WARN", "protection", "cannot check: origin is not a GitHub repository", rulesetHelp());
		else if (!signedIn) say("WARN", "protection", "cannot check: gh is not signed in", "run `gh auth login`, then check again");
		else {
			const branch = encodeURIComponent(config.baseBranch);
			const parse = (r) => {
				try {
					return r.ok ? JSON.parse(r.out) : undefined;
				} catch {
					return undefined;
				}
			};
			const rules = parse(run(gh, ["api", `repos/${github}/rules/branches/${branch}`], repo.top));
			const classic = parse(run(gh, ["api", `repos/${github}/branches/${branch}/protection`], repo.top));
			const p = protectionFrom(rules, classic);
			if (p.forcePush && p.deletion && p.pullRequest)
				say("PASS", "protection", `${config.baseBranch} blocks force pushes, deletion and pushes without a PR on GitHub`);
			else {
				const missing = [!p.forcePush && "force pushes", !p.deletion && "deletion", !p.pullRequest && "pushes without a PR"];
				say("WARN", "protection", `${config.baseBranch} does not block ${andList(missing.filter(Boolean))} on GitHub`, rulesetHelp(github));
			}
		}
	}

	if (want("docs")) {
		const claudeMd = path.join(repo.top, "CLAUDE.md");
		const text = existsSync(claudeMd) ? readFileSync(claudeMd, "utf8") : "";
		if (/^#{1,4}\s*Checks\b/im.test(text)) say("PASS", "claude-md", "CLAUDE.md has a Checks section");
		else say("WARN", "claude-md", text ? "CLAUDE.md has no Checks section" : "no CLAUDE.md", "add a Checks section with the e2e, dev server and database commands");
		if (existsSync(path.join(repo.top, "REVIEW.md"))) say("PASS", "review-md", "REVIEW.md exists");
		else say("WARN", "review-md", "no REVIEW.md", "add the rules every change must follow (templates/review.md is a start)");
	}

	if (want("lint")) {
		const tools = formatTools(repo.top);
		if (tools.length) say("PASS", "format", `edits are formatted and linted with ${tools.join(" + ")}`);
		else
			say(
				"WARN",
				"format",
				"no Biome, Prettier or ESLint installed and configured at the repository root: edits are not formatted or linted as Claude makes them (the verify command still checks them)",
				"install dependencies if they are missing, or add a Biome, Prettier or ESLint config, if you want each edit fixed as it happens",
			);
		const rule = skippedTestRule(repo.top);
		if (rule) say("PASS", "skipped-tests", `${rule.linter} ${rule.maybe ? "probably rejects" : "rejects"} skipped tests (${rule.rule}): epic-plan adds a suppression comment with a reason to the skipped acceptance test`);
		else say("PASS", "skipped-tests", "no lint rule against skipped tests found");
	}
	return lines;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const args = process.argv.slice(2);
	const value = (flag) => {
		const i = args.indexOf(flag);
		return i >= 0 ? args[i + 1] : undefined;
	};
	const gh = process.env.RUNWAY_GH_BIN ? [process.execPath, process.env.RUNWAY_GH_BIN] : ["gh"];
	console.log(checks(value("--cwd") ?? process.cwd(), value("--only"), { gh }).join("\n"));
}
