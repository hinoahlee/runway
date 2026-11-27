// Runs a hook script the way Claude Code does: the event as JSON on stdin, verdict in the exit code and stderr.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");

export function runHook(script, event, { env = {}, cwd } = {}) {
	const result = spawnSync(process.execPath, [path.join(scripts, script)], {
		input: JSON.stringify(event),
		encoding: "utf8",
		cwd,
		env: { ...process.env, CLAUDE_PROJECT_DIR: "", ...env },
	});
	return { code: result.status, stderr: result.stderr, stdout: result.stdout };
}
