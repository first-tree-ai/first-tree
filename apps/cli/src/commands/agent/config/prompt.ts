import { readFileSync } from "node:fs";
import {
  type AgentResourceBindingInput,
  type EffectiveResourceRow,
  findAssembledBriefingFingerprint,
} from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../../cli/output.js";
import { credentialForOrigin } from "../../../core/access-token.js";
import { resolveServerUrl } from "../../../core/bootstrap.js";
import { getAgentResources, patchAgentResources, resolveAgentRecord } from "./_shared/fetchers.js";

/**
 * `agent config prompt ...` — the per-agent prompt fragment, as a
 * round-trippable read/write pair:
 *
 *     prompt show <agent> --raw   →  edit  →  prompt set <agent> -f <file>
 *
 * The fragment is the ONLY editable prompt source an agent owns. The
 * assembled `AGENTS.md` an agent sees on disk is a *generated* artifact
 * that additionally contains team prompt resources and runtime-injected
 * First Tree content — `prompt set` therefore rejects bodies that carry
 * the assembled briefing's fingerprints (see `findAssembledBriefingFingerprint`)
 * so the "copied the whole AGENTS.md back into config" mistake fails fast
 * with a pointer to the correct flow.
 */
export function registerAgentConfigPromptCommands(config: Command): void {
  const prompt = config
    .command("prompt")
    .description("Read / write the per-agent prompt fragment (the only agent-editable prompt source)");

  prompt
    .command("show <agent>")
    .description("Show the per-agent prompt fragment; --raw prints it verbatim for edit round-trips")
    .option("--raw", "Print only the stored fragment text, suitable for redirecting to a file")
    .action(async (agentName: string, opts: { raw?: boolean }) => {
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
      const credential = await credentialForOrigin(serverUrl);
      const { uuid } = await resolveAgentRecord(serverUrl, credential, agentName);
      const resources = await getAgentResources(serverUrl, credential, uuid);
      const fragment = inlineFragmentText(resources.bindings);

      if (opts.raw) {
        // Verbatim, byte-for-byte: no trimming and no appended newline, so
        // `show --raw > f.md` → `set -f f.md` round-trips without mutating
        // intentional leading/trailing whitespace in the stored fragment.
        if (fragment.length > 0) process.stdout.write(fragment);
        return;
      }

      process.stdout.write(`Agent: ${agentName} (${uuid})\n`);
      process.stdout.write("\nEffective prompt stack (assembled into AGENTS.md by the runtime):\n");
      const rows = resources.effective.prompts;
      if (rows.length === 0) process.stdout.write("  (none)\n");
      for (const row of rows) {
        process.stdout.write(`  - ${describePromptRow(row)}\n`);
      }
      // Display-only tidy-up; the stored fragment itself is never trimmed.
      const display = fragment.trim();
      process.stdout.write(`\nPer-agent fragment: ${display ? `(${fragment.length} chars)` : "(empty)"}\n`);
      if (display) process.stdout.write(`  > ${display.replace(/\n/g, "\n  > ")}\n`);
      process.stdout.write(
        "\nOnly the per-agent fragment is editable here — team prompts are managed in Cloud → Org Settings → Resources,\n" +
          "and so are inline replacements of team prompts (resource bindings).\n" +
          "Edit round-trip: prompt show <agent> --raw > f.md  →  edit f.md  →  prompt set <agent> -f f.md\n",
      );
    });

  prompt
    .command("set <agent>")
    .description("Replace the per-agent prompt fragment ONLY — never paste the assembled AGENTS.md")
    .option("-f, --file <path>", "Read prompt text from this file")
    .option("--force", "Override the assembled-briefing heading heuristic (the generated marker is never overridable)")
    .action(async (agentName: string, opts: { file?: string; force?: boolean }) => {
      const text = await readPromptInput(opts.file);
      guardAgainstAssembledBriefing(text, opts.force === true);
      await replaceInlineFragment(agentName, text);
    });
}

/**
 * Deprecated spelling kept for compatibility: `append-prompt` always
 * *replaced* the fragment despite its name. Same behavior as `prompt set`,
 * including the assembled-briefing guard.
 */
export function registerAgentConfigAppendPromptCommand(config: Command): void {
  config
    .command("append-prompt <agent>")
    .description("(deprecated — use `prompt set`) Replace the per-agent prompt fragment from -f file or stdin")
    .option("-f, --file <path>", "Read prompt text from this file")
    .option("--force", "Override the assembled-briefing heading heuristic")
    .action(async (agentName: string, opts: { file?: string; force?: boolean }) => {
      const text = await readPromptInput(opts.file);
      guardAgainstAssembledBriefing(text, opts.force === true);
      await replaceInlineFragment(agentName, text);
    });
}

/** Inline-fragment predicate — the binding rows `prompt set` owns. */
function isInlineFragmentBinding(binding: AgentResourceBindingInput): boolean {
  return (
    binding.type === "prompt" &&
    binding.mode === "include" &&
    !binding.resourceId &&
    !binding.replacesResourceId &&
    binding.inlinePromptBody !== null &&
    binding.inlinePromptBody !== undefined
  );
}

// No trimming: leading/trailing whitespace in a stored fragment is content
// (e.g. an indented code block), and `show --raw` promises a verbatim export.
function inlineFragmentText(bindings: ReadonlyArray<AgentResourceBindingInput>): string {
  return bindings
    .filter(isInlineFragmentBinding)
    .map((binding) => binding.inlinePromptBody ?? "")
    .join("\n\n");
}

function describePromptRow(row: EffectiveResourceRow): string {
  const scope = row.source === "inline_prompt" || row.source === "agent_extra" ? "agent" : "team";
  // An inline *replacement* of a team prompt is agent-specific but owned by
  // resource bindings, not by `prompt set` — never call it the fragment.
  const name =
    row.source === "inline_prompt"
      ? row.replacesResourceId
        ? `inline replacement of team prompt "${row.name}" (managed via resource bindings)`
        : "per-agent fragment"
      : row.name;
  const size = row.promptBody ? `${row.promptBody.length} chars` : "empty";
  const state = row.mode === "enabled" ? size : row.mode;
  return `[${scope}] ${name} (${state})`;
}

async function readPromptInput(file: string | undefined): Promise<string> {
  if (file) return readFileSync(file, "utf-8");
  if (!process.stdin.isTTY) {
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      process.stdin.on("data", (c: Buffer) => chunks.push(c));
      process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      process.stdin.on("error", reject);
    });
  }
  fail("MISSING_INPUT", "Provide -f <file> or pipe prompt text via stdin", 2);
}

/**
 * Reject prompt bodies that look like a copy of the generated AGENTS.md.
 * The `first-tree:generated` banner marker is conclusive and cannot be
 * forced past (the server rejects it too); briefing-heading matches are a
 * heuristic and yield to `--force`.
 */
function guardAgainstAssembledBriefing(text: string, force: boolean): void {
  const fingerprint = findAssembledBriefingFingerprint(text);
  if (!fingerprint) return;
  if (fingerprint.kind === "generated-marker") {
    fail(
      "ASSEMBLED_BRIEFING",
      `Input contains the generated-briefing marker "${fingerprint.match}" — this is a copy of the assembled AGENTS.md, ` +
        "not the per-agent fragment. AGENTS.md mixes team-shared and runtime-injected content; writing it back would " +
        "freeze that content into this agent's config. Fetch the editable fragment with " +
        "`agent config prompt show <agent> --raw`, edit that, and run `prompt set` again.",
      2,
    );
  }
  if (!force) {
    fail(
      "ASSEMBLED_BRIEFING_HEADING",
      `Input contains the briefing heading "${fingerprint.match}" — it looks like (part of) the assembled AGENTS.md ` +
        "rather than the per-agent fragment. Fetch the editable source with `agent config prompt show <agent> --raw`. " +
        "If this heading is intentional prompt content, re-run with --force.",
      2,
    );
  }
}

/** Replace the agent's inline prompt fragment binding (empty text clears it). */
async function replaceInlineFragment(agentName: string, text: string): Promise<void> {
  const serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
  const credential = await credentialForOrigin(serverUrl);
  const { uuid } = await resolveAgentRecord(serverUrl, credential, agentName);
  const current = await getAgentResources(serverUrl, credential, uuid);
  const removedOrders: number[] = [];
  const remaining = current.bindings.filter((binding) => {
    if (!isInlineFragmentBinding(binding)) return true;
    if (binding.order !== undefined) removedOrders.push(binding.order);
    return false;
  });
  const nextBindings = [...remaining];
  if (text.length > 0) {
    nextBindings.push({
      type: "prompt",
      mode: "include",
      resourceId: null,
      inlinePromptBody: text,
      order: removedOrders.length > 0 ? Math.min(...removedOrders) : remaining.length + 1,
    });
  }
  const updated = await patchAgentResources(serverUrl, credential, uuid, {
    expectedVersion: current.version,
    bindings: nextBindings,
  });
  success({ agentId: uuid, version: updated.version, append_length: text.length });
}
