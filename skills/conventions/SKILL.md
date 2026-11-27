---
name: conventions
description: How to find and follow the repository's coding conventions. Use before writing or changing UI components or pages, API routes or services, database schema or queries, data fetching, client state, or tests.
---

The repository decides how code is written here, not your defaults. Before writing code in an area you have not
touched in this session:

1. **Read the docs.** `CLAUDE.md` at the repository root, the convention and architecture docs it links, and
   `REVIEW.md` (what review checks). Their rules win over anything below.
2. **Read the neighbours.** Open two or three existing files that do the same job (a sibling route, component,
   query or test) and match their structure, naming, file placement, error handling and imports.
3. **Reuse before adding.** Search for an existing helper, component, schema or type before writing a new one.
   A new dependency, service or pattern needs the user's go-ahead.
4. **Never hand-edit generated files.** CLAUDE.md names them; when unsure, look for a "generated" header or the
   command that writes the file.
5. **Almost no comments.** Write one only where the code alone can't tell the next reader enough: a deliberate
   choice someone would otherwise "fix" back, a trap, or a reason that isn't visible in the code. Never restate the
   code, and never record history or how a decision was reached ("changed because…", "per the user", "was X"):
   decisions go in the commit message, the PR description or the epic's Decisions log. Old comments are hints, not
   rules; the repository's rules win where they ask for a kind of comment (doc comments on a public API).

When the docs and the code disagree, follow the docs and tell the user about the disagreement.
