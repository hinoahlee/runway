// SessionStart, in a git repository only:
// - keeps runway's own output out of git without touching the repository's .gitignore, by adding the patterns to
//   the clone's local exclude file (.git/info/exclude, shared by its worktrees, never committed);
// - where runway is set up and a new session starts with uncommitted changes, records the tree, so the Stop gate can
//   tell the user's work in progress from Claude's changes;
// - where runway is not set up (no runway.json), shows the user one line pointing to /runway:setup, once per
//   repository. Plugins have no install hook, so this is where setup starts. Invalid settings are reported every time.
// Never blocks.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, repoOf } from "./config.mjs";
import { readEvent, workDir } from "./hook-io.mjs";
import { recordBaseline } from "./stop-gate.mjs";

export const PATTERNS = [".claude/worktrees/", ".claude/screenshots/", ".claude/logs/", ".runway/", ".playwright-mcp/"];
export const NOT_SET_UP =
	"runway is installed but not set up in this repository: run /runway:setup to set it up. Until then its Stop and format hooks do nothing here.";

export function excludeOutput(commonDir) {
	const file = path.join(commonDir, "info", "exclude");
	const current = existsSync(file) ? readFileSync(file, "utf8") : "";
	const present = new Set(current.split(/\r?\n/).map((line) => line.trim()));
	const missing = PATTERNS.filter((pattern) => !present.has(pattern));
	if (missing.length === 0) return;
	mkdirSync(path.dirname(file), { recursive: true });
	const separator = current === "" || current.endsWith("\n") ? "" : "\n";
	appendFileSync(file, `${separator}# runway plugin output\n${missing.join("\n")}\n`);
}

// The "not set up" note is shown once per repository (clone), then never again: records it in the git folder.
export function firstTime(commonDir) {
	const marker = path.join(commonDir, "runway", "setup-note-shown");
	if (existsSync(marker)) return false;
	try {
		mkdirSync(path.dirname(marker), { recursive: true });
		writeFileSync(marker, `${new Date().toISOString()}\n`);
	} catch {
		// Cannot record it: show it anyway.
	}
	return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const event = await readEvent();
	const cwd = workDir(event);
	const repo = repoOf(cwd);
	if (repo) {
		try {
			excludeOutput(repo.commonDir);
		} catch {
			// A read-only .git: nothing to exclude.
		}
		const loaded = loadConfig(cwd);
		if (loaded.reason === "invalid") {
			console.log(JSON.stringify({ systemMessage: `runway's settings are invalid: ${loaded.message}` }));
		} else if (!loaded.ok && firstTime(repo.commonDir)) {
			console.log(JSON.stringify({ systemMessage: NOT_SET_UP }));
		} else if (loaded.ok && (event.source ?? "startup") === "startup") {
			try {
				recordBaseline(loaded.repo, event.session_id);
			} catch {
				// Without a record the Stop gate only runs verify more often.
			}
		}
	}
}
