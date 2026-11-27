// PreToolUse (Bash, PowerShell): blocks commands that destroy work or history unless the user runs or approves them,
// and, where runway is set up, opening a PR anywhere but in /runway:ship or /runway:epic-plan.
// A speed bump against mistakes, not a security boundary: a command can always be written in a way no pattern
// catches (a script, an alias, another program). GitHub branch rules are what protect the base branch.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.mjs";
import { block, readEvent, workDir } from "./hook-io.mjs";
import { checkCommit } from "./tests-first.mjs";

// The hook blocks every attempt, approved or not, so only the user can run it (`!<command>` in Claude Code).
const ASK = "Ask the user to run it themselves if they mean it (typing `!` before it in Claude Code runs it as the user). Do not retry it.";

// One command of a chain: everything up to the next ; & | or newline.
const ARG = "[^;&|\\n]*";
const gitCmd = (sub, rest) => new RegExp(`\\bgit\\b${ARG}\\b${sub}\\b${ARG}${rest}`, "i");

// Targets that wipe a whole drive or home folder, written with a variable or as a literal path.
const ROOT_OR_HOME = new RegExp(
	[
		"\\/|\\/\\*|~|~\\/|~\\/\\*|\\$home|\\$\\{home\\}|\\$home\\/\\*?|\\\\",
		"[a-z]:[\\\\/]?\\*?",
		"\\$env:userprofile[\\\\/]?\\*?|\\$env:homedrive[\\\\/]?\\*?|%userprofile%[\\\\/]?\\*?|%homedrive%[\\\\/]?\\*?",
		"[a-z]:[\\\\/]users([\\\\/][^\\\\/]+)?[\\\\/]?\\*?",
		"\\/(home|users)(\\/[^/]+)?\\/?\\*?",
		"\\/root\\/?\\*?",
	]
		.map((p) => `(?:${p})`)
		.join("|")
		.replace(/^/, "^(?:")
		.concat(")$"),
	"i",
);

const PROTECTED = ["main", "master"];

// Where runway is set up, PRs are opened only by the skills that review the branch or plan the epic first.
const PR_SKILLS = ["runway:ship", "runway:epic-plan"];
const PR_CREATE = /\bgh\b[^;&|\n]*\bpr\b[^;&|\n]*\b(create|new)\b/i;
const GH_PR = /\bgh\b[^;&|\n]*\bpr\b/i;
const SHIP_FIRST =
	"Tell the user to run `/runway:ship`, which reviews the branch, fixes what it finds and opens the PR (or to run `gh pr create` themselves with `!` if they mean to skip the review). Do not retry it.";

function rules(base, current, prAllowed) {
	const protectedNames = [...new Set([...PROTECTED, base].filter(Boolean))];
	const branches = protectedNames.map((b) => b.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
	const named = `(?:origin\\/)?(?:${branches.join("|")})`;
	return [
		{
			name: "git push --force",
			flags: true,
			test: (cmd) =>
				gitCmd("push", "(\\s--force(-with-lease|-if-includes)?\\b|\\s-[a-z]*f[a-z]*\\b|\\s\\+\\S)").test(cmd),
			why: "a force push rewrites shared history",
		},
		{
			name: `deleting the ${base ?? "main"} branch`,
			flags: true,
			test: (cmd) =>
				gitCmd("branch", `\\s(-[a-z]*d[a-z]*|--delete)\\b${ARG}\\s${named}(\\s|$)`).test(cmd) ||
				gitCmd("push", `(\\s--delete\\b${ARG}\\s${named}|\\s:${named})(\\s|$)`).test(cmd),
			why: "it deletes the branch everything is built on",
		},
		{
			name: `pushing to ${protectedNames.join(" / ")}`,
			flags: true,
			test: (cmd) => segments(cmd).some((tokens) => pushesTo(tokens, protectedNames, current)),
			why: "changes reach the base branch only through a PR the developer reviews and merges",
		},
		{
			name: "git reset --hard",
			flags: true,
			test: (cmd) => gitCmd("reset", "\\s--hard\\b").test(cmd),
			why: "it discards uncommitted work",
		},
		{
			name: "git clean -f",
			flags: true,
			test: (cmd) => gitCmd("clean", "\\s(-[a-z]*f[a-z]*|--force)\\b").test(cmd),
			why: "it deletes untracked files for good",
		},
		{
			name: "discarding every change in the working tree",
			test: (cmd) => segments(cmd).some(discardsTree),
			why: "it throws away uncommitted work",
		},
		{
			name: "git stash drop / clear",
			flags: true,
			test: (cmd) => /\bgit\b[^;&|\n]*\bstash\s+(drop|clear)\b/i.test(cmd),
			why: "it deletes stashed work",
		},
		{
			name: "DROP DATABASE / DROP TABLE",
			test: (cmd) => /\bdrop\s+(database|table|schema)\b/i.test(withoutMessages(cmd)),
			why: "it deletes data",
		},
		{
			name: "an ORM migrate reset",
			test: (cmd) =>
				/\b(migrate\s+reset|migrate:(reset|fresh|refresh)|db:reset|db\s+push\b[^;&|\n]*--force-reset|drizzle-kit\s+drop|knex\s+migrate:rollback\s+--all|sequelize\s+db:migrate:undo:all|typeorm\s+schema:drop)\b/i.test(
					withoutMessages(cmd),
				),
			why: "it drops and recreates the database",
		},
		{
			name: "gh pr merge",
			flags: true,
			test: (cmd) => /\bgh\b[^;&|\n]*\bpr\b[^;&|\n]*\bmerge\b/i.test(cmd),
			why: "merging is the developer's call, after their review",
		},
		{
			name: "gh pr create",
			flags: true,
			test: (cmd) => prAllowed === false && PR_CREATE.test(cmd),
			why: "in a repository set up for runway, PRs are opened by `/runway:ship` (or `/runway:epic-plan` for an epic's draft PR)",
			ask: SHIP_FIRST,
		},
		{
			name: "skipping git hooks",
			flags: true,
			test: (cmd) => /(^|\s)--no-verify\b/i.test(cmd) || segments(cmd).some(skipsHooks),
			why: "it skips the repository's git hooks",
		},
		{
			name: "recursive forced delete of a root or home folder",
			test: (cmd) => segments(cmd).some(wipesRootOrHome),
			why: "it deletes a whole drive or home folder",
		},
	];
}

// Quoted arguments that hold more than one word (a commit message, an echo) are not flags or refs: the rules about
// git flags ignore them, so `git commit -m "support the -n flag"` is allowed. A single quoted word ("+main") stays.
export function unquoted(command) {
	return command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (quoted) => {
		const inner = quoted.slice(1, -1);
		return /\s/.test(inner) ? '""' : inner;
	});
}

// The data rules (DROP TABLE, ORM resets) still read quoted text, so `psql -c "DROP TABLE x"` is caught, except in
// commands whose quoted text is a message: a commit, tag or PR title may say "drop table" without doing it.
const MESSAGE_COMMAND = /\bgit\b[^;&|\n]*\b(commit|tag|notes|stash|merge|revert)\b|\bgh\b[^;&|\n]*\b(pr|issue|release)\b/i;
function withoutMessages(command) {
	return command.replace(/[^;&|\n]+/g, (part) => (MESSAGE_COMMAND.test(part) ? unquoted(part) : part));
}

// base: the base branch from runway.json; branch: the branch checked out where the command runs (what a bare
// `git push` or `HEAD` pushes), when known; prAllowed: false where runway is set up and the session's latest slash
// command is not one of PR_SKILLS (undefined leaves `gh pr create` alone).
export function check(command, { base, branch, prAllowed } = {}) {
	const plain = unquoted(command);
	const rule = rules(base, branch, prAllowed).find((r) => r.test(r.flags ? plain : command));
	return rule ? `Blocked ${rule.name}: ${rule.why}. ${rule.ask ?? ASK}` : undefined;
}

// The slash command the user (or epic-auto's `claude -p "/runway:ship"`) typed last in this session, read from the
// transcript: "runway:ship", "commit", ... or undefined. Only prompts count: tool output that quotes a command
// (a transcript search, a log) is ignored. A skill's own follow-up questions don't end it: the user answering one
// is a plain message, not a new command.
export function lastSlashCommand(transcript) {
	const lines = String(transcript ?? "").split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!lines[i].includes("command-name")) continue;
		let entry;
		try {
			entry = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		if (entry.type !== "user" || entry.isMeta) continue;
		const content = entry.message?.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n")
					: "";
		const name = text.match(/^\s*(?:<command-message>[^<]*<\/command-message>\s*)?<command-name>\/?([^<\s]+)<\/command-name>/);
		if (name) return name[1];
	}
	return undefined;
}

function readTranscript(file) {
	try {
		return file ? readFileSync(file, "utf8") : "";
	} catch {
		return "";
	}
}

function segments(command) {
	return command
		.split(/&&|\|\||[;|\n]/)
		.map((part) =>
			part
				.trim()
				.split(/\s+/)
				// Quotes anywhere in a word ("$HOME"/*) are shell syntax, not part of the path.
				.map((token) => token.replace(/["']/g, "")),
		)
		.filter((tokens) => tokens[0]);
}

// A git command's own options (-C <dir>, -c <key=value>), its subcommand and the subcommand's arguments.
function gitParts(tokens) {
	const i = tokens.findIndex((t) => t.toLowerCase() === "git");
	if (i < 0) return undefined;
	const options = [];
	let k = i + 1;
	while (k < tokens.length && tokens[k].startsWith("-")) {
		const takesValue = tokens[k] === "-C" || tokens[k] === "-c";
		options.push(takesValue ? `${tokens[k]} ${tokens[k + 1] ?? ""}` : tokens[k]);
		k += takesValue ? 2 : 1;
	}
	return { options, verb: tokens[k]?.toLowerCase(), args: tokens.slice(k + 1) };
}

// git commit -n (any short-flag group with n), or hooks switched off with -c core.hooksPath=/dev/null (or empty).
function skipsHooks(tokens) {
	const git = gitParts(tokens);
	if (!git) return false;
	if (git.options.some((o) => /^-c core\.hookspath=(\/dev\/null|nul|)$/i.test(o))) return true;
	return git.verb === "commit" && git.args.some((a) => /^-[a-z]*n[a-z]*$/.test(a));
}

const PUSH_OPTIONS_WITH_VALUE = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

// git push that updates a protected branch: `git push origin main`, `HEAD:main`, `x:refs/heads/main`, --all or
// --mirror, or a bare `git push` / `git push origin HEAD` while a protected branch is checked out. Deleting one
// (`:main`) is the deletion rule's.
function pushesTo(tokens, names, current) {
	const git = gitParts(tokens);
	if (!git || git.verb !== "push") return false;
	const positional = [];
	for (let i = 0; i < git.args.length; i++) {
		const arg = git.args[i];
		if (arg === "--all" || arg === "--mirror") return true;
		if (arg === "--delete" || arg === "-d") return false;
		if (PUSH_OPTIONS_WITH_VALUE.has(arg)) i++;
		else if (!arg.startsWith("-")) positional.push(arg);
	}
	const destinations = positional.length < 2 ? [current] : positional.slice(1).map((spec) => {
		const [src, dst] = spec.replace(/^\+/, "").split(":");
		if (dst === undefined) return src === "HEAD" ? current : src;
		return dst === "HEAD" ? current : dst;
	});
	return destinations.some((d) => d && names.includes(d.replace(/^refs\/heads\//, "")));
}

const WHOLE_TREE =new Set([".", "./", ":/", "*", ":/*", ".\\"]);
const FORCE = (a) => a === "--force" || /^-[a-z]*f[a-z]*$/.test(a);

// git checkout -- . / git checkout . / git restore . (but not git restore --staged ., which only unstages), and
// git checkout -f / git switch -f / --discard-changes, which throw away every change while switching.
function discardsTree(tokens) {
	const git = gitParts(tokens);
	if (!git) return false;
	const { verb, args } = git;
	if (verb === "checkout" && args.some(FORCE)) return true;
	if (verb === "switch" && args.some((a) => FORCE(a) || a === "--discard-changes")) return true;
	if (!args.some((a) => WHOLE_TREE.has(a))) return false;
	if (verb === "checkout") return true;
	if (verb === "restore") {
		const staged = args.some((a) => a === "--staged" || a === "-S");
		const worktree = args.some((a) => a === "--worktree" || a === "-W");
		return !staged || worktree;
	}
	return false;
}

function wipesRootOrHome(tokens) {
	const words = tokens[0].toLowerCase() === "sudo" ? tokens.slice(1) : tokens;
	const [program = "", ...args] = words;
	const name = program.toLowerCase().replace(/\.exe$/, "");
	const targets = args.filter((a) => !a.startsWith("-") && !/^\/[a-z]$/i.test(a));
	if (!targets.some((t) => ROOT_OR_HOME.test(t))) return false;

	if (name === "rm") {
		const flags = args.filter((a) => a.startsWith("-")).map((a) => a.toLowerCase());
		const short = flags.filter((f) => !f.startsWith("--")).join("");
		const recursive = /r/.test(short) || flags.includes("--recursive");
		const force = /f/.test(short) || flags.includes("--force");
		if (recursive && force) return true;
	}
	if (["remove-item", "rm", "ri", "del", "erase", "rd", "rmdir"].includes(name)) {
		const params = args.map((a) => a.toLowerCase());
		const recurse = params.some((p) => /^-r(e(c(u(r(s(e)?)?)?)?)?)?$/.test(p));
		const force = params.some((p) => /^-fo(r(c(e)?)?)?$/.test(p));
		if (recurse && force) return true;
	}
	// cmd.exe: rd /s /q C:\
	if (["rd", "rmdir"].includes(name)) {
		const switches = args.map((a) => a.toLowerCase());
		if (switches.includes("/s") && switches.includes("/q")) return true;
	}
	return false;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const event = await readEvent();
	const loaded = event.cwd ? loadConfig(workDir(event)) : { ok: false };
	const head = event.cwd
		? spawnSync("git", ["branch", "--show-current"], { cwd: workDir(event), encoding: "utf8", windowsHide: true })
		: undefined;
	const branch = head?.status === 0 ? head.stdout.trim() || undefined : undefined;
	const command = String(event.tool_input?.command ?? "");
	// Reading the transcript only for commands that might open a PR keeps every other check fast.
	const prAllowed =
		loaded.ok && GH_PR.test(command)
			? PR_SKILLS.includes(lastSlashCommand(readTranscript(event.transcript_path)) ?? "")
			: undefined;
	const reason = check(command, {
		base: loaded.ok ? loaded.config.baseBranch : undefined,
		branch,
		prAllowed,
	});
	if (reason) block(reason);
	// Tests first, where runway is set up (checkCommit skips the base branch and merges in progress).
	if (loaded.ok && /\bgit\b[^;&|\n]*\bcommit\b/i.test(command)) {
		const problem = checkCommit({
			segs: segments(unquoted(command)),
			gitParts,
			raw: command,
			cwd: workDir(event),
			config: loaded.config,
		});
		if (problem) block(problem);
	}
}
