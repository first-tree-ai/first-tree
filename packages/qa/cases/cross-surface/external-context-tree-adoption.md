---
id: external-context-tree-adoption
description: Validate the packaged external Context Tree CLI across installation, login, provider sessions, and rollback.
areas: [cross-surface]
surfaces: [cli, client]
---

# External Context Tree adoption

Use focused live validation before releasing this integration. Product tests own
repository validation, installer provenance, unchanged-content checks, and
provider selection. This case covers the installed artifact and effective
provider environment; adding it does not claim a live QA run.

Use an isolated account home, npm prefix, First Tree channel home, disposable
repository, and human-authorized provider credentials. Never reuse the operator's
Skill directories. Build and globally install the candidate CLI artifact.

1. Leave `context_tree.repository` unset. Confirm package installation and login
   do not install external Skills. Independently install the official Context
   Tree Skills for Claude and Codex, then log in again: all copies must survive.
2. In a fresh home, configure the disposable repository and log in. Confirm the
   installed dependency is the expected release, the new cleanup Skills are
   discoverable, and `context-tree` runs through the generated shim with the
   provider's actual PATH. Confirm login connects existing workspaces without
   changing their existing `AGENTS.md` or `CLAUDE.md` instructions.
3. Start ordinary Claude and Codex sessions. Resolve and read the configured tree
   from each session. Check the replacement Skill set and briefing agree. Check
   a Cursor session retains First Tree Skills and an appropriate unresolved
   context-source briefing instead of referring to unavailable external Skills.
4. Separately exercise Codex's workspace-only mode, whose HOME points at the
   workspace. Record the documented `NO_CONNECTION` limitation and whether setup
   can establish a usable connection within the sandbox; do not count an ordinary
   Codex session as evidence for this mode.
5. Repeat login, edit one installed Skill, then unset the repository and log in.
   Only recorded, unchanged First Tree installations should be removed. The
   edited copy, independent official copies, and foreign global binary must
   survive. Check the report and next-session First Tree Skill projection.

Report the artifact version, provider environments, observed reads, ownership
preservation results, and any unsupported boundary before release. Reset only
task-owned state and retain compatible QA infrastructure.
