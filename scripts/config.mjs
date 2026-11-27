// The repository's runway settings. They describe the repository (how to verify it, where epics live, which branch
// PRs target), so they are read from the repository, not from per-user plugin options. Two places, first wins:
//
//   <repo>/.claude/runway.json        committed: the whole team shares it
//   <git-common-dir>/runway.json      this clone only (inside .git, never committed)
//
// Neither file means runway is not set up in this repository: the Stop gate and post-edit do nothing, and the
// workflow skills point to /runway:setup. The schema is schemas/runway.schema.json.
//
//   node config.mjs [--cwd <dir>]   prints the resolved settings as JSON, or one line: NOT-SET-UP or INVALID <why>
//   node config.mjs --security-files <range> [--cwd <dir>]
//                                   prints the files changed in the git range that match securityPaths, or NONE
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// model: epic-auto's headless sessions. reviewModel: the code and security reviewers ("inherit" = the session's).
export const DEFAULTS = { epicsDir: "docs/epics", baseBranch: "main", model: "sonnet", reviewModel: "opus" };

// Where a change gets a security review whatever the spec's risk. Kept out of DEFAULTS so the settings every skill
// prints stay short; a securityPaths setting replaces the whole list.
export const SECURITY_PATHS = [
	"**/{api,routes,handlers,controllers,middleware,middlewares}/**",
	"**/{route,routes,handler,handlers,controller,middleware}.*",
	"**/*{auth,session,login,permission,secret,crypto,token}*",
	"**/*{auth,session,login,permission,secret,crypto,token}*/**",
	"**/{db,database,schema,schemas,migrations,prisma,drizzle}/**",
	"**/{schema.*,*.sql}",
	"**/{config,configs,env}/**",
	"**/{.env*,env.*,config.*,*.config.*,settings.*}",
	"**/{infra,infrastructure,terraform,k8s,kubernetes,helm,deploy,deployment}/**",
	"**/*.{tf,tfvars}",
	".github/**",
	"{.gitlab-ci.yml,.circleci/**,azure-pipelines.yml,Jenkinsfile}",
	"**/{Dockerfile*,*.dockerfile,.dockerignore,docker-compose*.{yml,yaml},compose*.{yml,yaml}}",
	"**/{package.json,package-lock.json,npm-shrinkwrap.json,pnpm-lock.yaml,pnpm-workspace.yaml,yarn.lock,bun.lock,bun.lockb,.npmrc}",
	"**/{requirements*.txt,pyproject.toml,poetry.lock,uv.lock,Pipfile,Pipfile.lock,Gemfile,Gemfile.lock,go.mod,go.sum,Cargo.toml,Cargo.lock,composer.json,composer.lock,pom.xml,build.gradle*}",
];

const KEYS = {
	verifyCommand: (v) => typeof v === "string" && v.trim() !== "",
	epicsDir: (v) => typeof v === "string" && v.trim() !== "" && !path.isAbsolute(v) && !v.split(/[\\/]/).includes(".."),
	baseBranch: (v) => typeof v === "string" && /^[\w./-]+$/.test(v) && !v.startsWith("-"),
	claudeSettings: (v) => (typeof v === "string" && v.trim() !== "") || (v !== null && typeof v === "object" && !Array.isArray(v)),
	// Passed on the command line: a model alias or id, never something that reads as a flag.
	model: (v) => typeof v === "string" && /^(?!-)[\w.[\]-]+$/.test(v),
	reviewModel: (v) => typeof v === "string" && /^(?!-)[\w.[\]-]+$/.test(v),
	testPaths: (v) => Array.isArray(v) && v.length > 0 && v.every((glob) => typeof glob === "string" && glob.trim() !== ""),
	securityPaths: (v) => Array.isArray(v) && v.every((glob) => typeof glob === "string" && glob.trim() !== ""),
};

// A glob over repository-relative paths, matched whole and ignoring case: ** spans folders, * and ? stay in one,
// {a,b} is either (and may nest).
export function globToRegExp(glob) {
	let i = 0;
	const parse = (inBraces) => {
		const alternatives = [];
		let out = "";
		while (i < glob.length) {
			const c = glob[i];
			if (c === "*" && glob[i + 1] === "*") {
				const atStart = i === 0 || glob[i - 1] === "/";
				i += 2;
				if (atStart && glob[i] === "/") {
					i++;
					out += "(?:.*/)?";
				} else out += ".*";
				continue;
			}
			i++;
			if (c === "*") out += "[^/]*";
			else if (c === "?") out += "[^/]";
			else if (c === "{") out += parse(true);
			else if (c === "," && inBraces) {
				alternatives.push(out);
				out = "";
			} else if (c === "}" && inBraces) return `(?:${[...alternatives, out].join("|")})`;
			else out += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
		}
		return inBraces ? `\\{${[...alternatives, out].join(",")}` : out;
	};
	return new RegExp(`^${parse(false)}$`, "i");
}

// The files among `files` (repository-relative) that match the security globs.
export function securityFiles(files, globs = SECURITY_PATHS) {
	const patterns = globs.map(globToRegExp);
	return files.filter((file) => patterns.some((pattern) => pattern.test(file.replaceAll("\\", "/"))));
}

function git(cwd, args) {
	const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
	return r.status === 0 && !r.error ? r.stdout.trim() : undefined;
}

// The repository a folder belongs to: its own top level and the .git folder it shares with any linked checkouts.
export function repoOf(cwd) {
	const top = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!top) return undefined;
	// --path-format needs git 2.31; older ones print the folder relative to cwd.
	const commonDir =
		git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) ??
		git(cwd, ["rev-parse", "--git-common-dir"]);
	if (!commonDir) return undefined;
	return { top: path.resolve(top), commonDir: path.resolve(cwd, commonDir) };
}

export function configFiles(repo) {
	return [path.join(repo.top, ".claude", "runway.json"), path.join(repo.commonDir, "runway.json")];
}

export function validate(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "it must be a JSON object";
	for (const key of Object.keys(raw)) {
		if (key === "$schema") continue;
		if (!KEYS[key]) return `unknown key "${key}"`;
		if (!KEYS[key](raw[key])) return `"${key}" has an invalid value`;
	}
	if (raw.verifyCommand === undefined) return `"verifyCommand" is required`;
	return undefined;
}

// { ok: true, config, file } | { ok: false, reason: "not-set-up" | "invalid", message }
export function loadConfig(cwd = process.cwd()) {
	const repo = repoOf(cwd);
	if (!repo) return { ok: false, reason: "not-set-up", message: "not a git repository" };
	const file = configFiles(repo).find((f) => existsSync(f));
	if (!file) return { ok: false, reason: "not-set-up", message: "no .claude/runway.json", repo };
	let raw;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		return { ok: false, reason: "invalid", message: `${file}: ${error.message}`, repo };
	}
	const problem = validate(raw);
	if (problem) return { ok: false, reason: "invalid", message: `${file}: ${problem}`, repo };
	const { $schema, ...rest } = raw;
	return { ok: true, config: { ...DEFAULTS, ...rest }, file, repo };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const args = process.argv.slice(2);
	const i = args.indexOf("--cwd");
	const cwd = i >= 0 ? args[i + 1] : process.cwd();
	const result = loadConfig(cwd);
	const range = args.indexOf("--security-files");
	if (range >= 0 && result.ok) {
		const changed = git(cwd, ["-c", "core.quotepath=off", "diff", "--name-only", args[range + 1] ?? ""]);
		if (changed === undefined) {
			console.log(`ERROR git diff --name-only ${args[range + 1] ?? ""} failed`);
			process.exitCode = 1;
		} else {
			const files = securityFiles(changed.split(/\r?\n/).filter(Boolean), result.config.securityPaths);
			console.log(files.length > 0 ? files.join("\n") : "NONE");
		}
	} else if (result.ok) console.log(JSON.stringify({ ...result.config, file: result.file }, null, 2));
	else if (result.reason === "invalid") console.log(`INVALID ${result.message}`);
	else {
		const where = result.repo ? ` Looked in: ${configFiles(result.repo).join(", ")}.` : "";
		console.log(`NOT-SET-UP runway is not set up in this repository (${result.message}). Run /runway:setup.${where}`);
	}
}
