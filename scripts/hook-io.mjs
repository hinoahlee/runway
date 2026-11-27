// Shared by the hook scripts: read the event Claude Code pipes in, and end the hook with a verdict.

export async function readEvent(stream = process.stdin) {
	let text = "";
	for await (const chunk of stream) text += chunk;
	try {
		return JSON.parse(text || "{}");
	} catch {
		return {};
	}
}

// Exit code 2 blocks the action; Claude Code shows stderr to Claude as the reason.
export function block(message) {
	process.stderr.write(`${message.trimEnd()}\n`);
	process.exit(2);
}

// The folder the session is working in. The event's cwd follows Claude when it moves into another checkout;
// CLAUDE_PROJECT_DIR stays at the folder the session started in, so it is only the fallback.
export function workDir(event) {
	return event.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

export function lastLines(text, count) {
	return String(text ?? "")
		.split(/\r?\n/)
		.slice(-count)
		.join("\n");
}
