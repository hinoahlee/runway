// PostToolUse (Write, Edit): formats the edited file, then lints it with safe fixes. Remaining lint errors go back to
// Claude (exit 2). Works in the repository that holds the file (its own checkout, wherever the session started),
// uses that repository's own Biome, or Prettier + ESLint, from node_modules, and does nothing without them or where
// runway is not set up.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";
import { block, lastLines, readEvent, workDir } from "./hook-io.mjs";

const SCRIPT_FILES = /\.(m|c)?(j|t)sx?$/i;
const PRETTIER_FILES = /\.((m|c)?(j|t)sx?|jsonc?|css|scss|less|md|mdx|ya?ml|html|vue|svelte|graphql)$/i;

// Runs a package's bin with this Node, so no shell or .cmd shim is involved on Windows.
function binOf(root, pkg, bin) {
	const manifest = path.join(root, "node_modules", pkg, "package.json");
	if (!existsSync(manifest)) return undefined;
	const { bin: bins } = JSON.parse(readFileSync(manifest, "utf8"));
	const rel = typeof bins === "string" ? bins : bins?.[bin];
	return rel ? path.join(root, "node_modules", pkg, rel) : undefined;
}

function run(root, script, args) {
	const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", windowsHide: true });
	return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const hasConfig = (root, names) => names.some((name) => existsSync(path.join(root, name)));

// The repository's package.json, or {} when there is none or it cannot be read.
function manifestOf(root) {
	try {
		return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) ?? {};
	} catch {
		return {};
	}
}

const configNames = (base, exts) => exts.map((ext) => `${base}${ext}`);
const PRETTIER_CONFIGS = [
	...configNames(".prettierrc", ["", ".json", ".json5", ".yaml", ".yml", ".toml", ".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"]),
	...configNames("prettier.config", [".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"]),
];
const ESLINT_FLAT_CONFIGS = configNames("eslint.config", [".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"]);
const ESLINT_LEGACY_CONFIGS = configNames(".eslintrc", ["", ".js", ".cjs", ".json", ".yaml", ".yml"]);

// Biome, Prettier and ESLint each run only where the repository configures them: a package that is only in
// node_modules because another package depends on it (npm hoists those) must not format or lint this repository.
export function toolsFor(root, file) {
	const biome = binOf(root, "@biomejs/biome", "biome");
	if (biome && hasConfig(root, ["biome.json", "biome.jsonc"])) {
		// No extension list: Biome knows which files it handles (YAML since 2.x) and skips the rest itself.
		const common = ["--no-errors-on-unmatched", "--files-ignore-unknown=true", file];
		return [
			{ kind: "format", script: biome, args: ["format", "--write", ...common] },
			{ kind: "lint", script: biome, args: ["lint", "--write", ...common] },
		];
	}
	const steps = [];
	const manifest = manifestOf(root);
	const prettier = binOf(root, "prettier", "prettier");
	if (prettier && PRETTIER_FILES.test(file) && (hasConfig(root, PRETTIER_CONFIGS) || manifest.prettier)) {
		steps.push({ kind: "format", script: prettier, args: ["--write", "--ignore-unknown", file] });
	}
	const eslint = binOf(root, "eslint", "eslint");
	const flat = hasConfig(root, ESLINT_FLAT_CONFIGS);
	if (eslint && SCRIPT_FILES.test(file) && (flat || hasConfig(root, ESLINT_LEGACY_CONFIGS) || manifest.eslintConfig)) {
		// --no-warn-ignored exists only with a flat config; an .eslintrc repository would get "Invalid option".
		steps.push({ kind: "lint", script: eslint, args: ["--fix", ...(flat ? ["--no-warn-ignored"] : []), file] });
	}
	return steps;
}

// event: the PostToolUse event. Returns the problem to send back to Claude, or undefined.
export function postEdit(event) {
	const filePath = event.tool_input?.file_path;
	if (!filePath) return undefined;
	const absolute = path.resolve(workDir(event), filePath);
	if (!existsSync(absolute)) return undefined;
	// The repository the file lives in decides, so an edit in another checkout uses that checkout's tools and config.
	const loaded = loadConfig(path.dirname(absolute));
	if (!loaded.ok) return undefined;
	const root = loaded.repo.top;
	const file = path.relative(root, absolute).split(path.sep).join("/");
	if (file.startsWith("..") || path.isAbsolute(file) || /(^|\/)node_modules\//.test(file)) return undefined;

	for (const step of toolsFor(root, file)) {
		const { ok, output } = run(root, step.script, step.args);
		if (!ok && step.kind === "lint") {
			return `Lint errors remain in ${file} after safe fixes. Fix them:\n${lastLines(output.trim(), 60)}`;
		}
	}
	return undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const problem = postEdit(await readEvent());
	if (problem) block(problem);
}
