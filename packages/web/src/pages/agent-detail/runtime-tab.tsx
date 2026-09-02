import { Navigate } from "react-router";
import { Section } from "../../components/ui/section.js";
import { EnvSection } from "./env-section.js";
import { FastModeSection } from "./fast-mode-section.js";
import { useAgentDetailContext } from "./layout-context.js";
import { ModelSection } from "./model-section.js";
import { ReasoningEffortSection } from "./reasoning-effort-section.js";
import { RuntimeSection, RuntimeSwitchRecoveryNotice } from "./runtime-section.js";
import { titleWithSemantics } from "./save-semantics.js";

export function RuntimeTab() {
  const ctx = useAgentDetailContext();
  // Human agents (and any role without canEditConfig) have no runtime to
  // configure. The tab is hidden from buildTabs, but a stale deep link to
  // /agents/:uuid/runtime would otherwise render a blank page; redirect to
  // Profile, which now hosts agent lifecycle controls (suspend / delete).
  if (!ctx.canEditConfig) return <Navigate to="../profile" replace />;

  const { config, configSave } = ctx;
  // Edits disable while a save is in flight, so the next PATCH always sees the
  // version the previous one wrote back — no self-conflicting 409 on rapid edits.
  const editsDisabled = ctx.agent.status !== "active" || configSave.pending;
  const canSwitchRuntime =
    !ctx.runtimeSwitchClaim &&
    ((!!ctx.agent.clientId && ctx.agent.status === "active") || (ctx.isUnclaimed && ctx.agent.status === "suspended"));
  const modelSettingsSaved =
    configSave.justSaved &&
    (configSave.savedField === "model" ||
      configSave.savedField === "effort" ||
      configSave.savedField === "serviceTier");
  const envSaved = configSave.justSaved && configSave.savedField === "env";

  return (
    <>
      {ctx.configLoading && (
        <div className="text-body" style={{ color: "var(--fg-3)" }}>
          Loading configuration…
        </div>
      )}
      {ctx.configError != null && (
        <div className="text-body" style={{ color: "var(--state-error)" }}>
          Failed to load configuration: {String(ctx.configError)}
        </div>
      )}

      {/* Execution (computer / runtime) on top — the agent's "where it runs"
          context. Then Model settings, then Env vars. Every section saves
          immediately. */}
      {config && (
        <div>
          {ctx.runtimeSwitchClaim && (
            <div style={{ marginBottom: "var(--sp-5)" }}>
              <RuntimeSwitchRecoveryNotice
                claim={ctx.runtimeSwitchClaim}
                pending={ctx.runtimeSwitchRecoveryPending}
                error={ctx.runtimeSwitchRecoveryError}
                onRecover={ctx.onRecoverRuntimeSwitch}
              />
            </div>
          )}
          <RuntimeSection
            runtimeProvider={ctx.setupRuntimeProvider}
            computerLabel={ctx.boundClientLabel}
            canBindComputer={ctx.isUnclaimed && ctx.agent.status === "active"}
            bindComputerPending={ctx.bindClientPending}
            onBindComputer={ctx.onOpenBindDialog}
            canSwitchRuntime={canSwitchRuntime}
            runtimeSwitchPending={ctx.runtimeSwitchPending}
            onSwitchRuntime={ctx.onOpenRuntimeSwitchDialog}
          />
        </div>
      )}

      {config && ctx.setupRuntimeProvider !== "zcode" && (
        <div style={{ marginTop: "var(--sp-8)" }}>
          <Section headingLevel={3} title={titleWithSemantics("Model settings", modelSettingsSaved)}>
            <ModelSection
              value={config.payload.model}
              onChange={(v) => configSave.save({ model: v }, { field: "model" })}
              disabled={editsDisabled}
              provider={ctx.setupRuntimeProvider}
              clientId={ctx.agent.clientId ?? null}
            />
            {/* Cursor has no separate reasoning-effort channel — effort/fast
                variants live in the provider-native model id, so the control
                is hidden rather than rendered empty. */}
            {ctx.setupRuntimeProvider !== "cursor" &&
            ctx.setupRuntimeProvider !== "kimi-code" &&
            ctx.setupRuntimeProvider !== "opencode" &&
            ctx.setupRuntimeProvider !== "pi" ? (
              <ReasoningEffortSection
                value={"reasoningEffort" in config.payload ? config.payload.reasoningEffort : ""}
                onChange={(v) => configSave.save({ reasoningEffort: v }, { field: "effort" })}
                disabled={editsDisabled}
                provider={ctx.setupRuntimeProvider}
              />
            ) : null}
            {config.payload.kind === "codex" ? (
              <FastModeSection
                serviceTier={config.payload.serviceTier}
                onChange={(serviceTier) => configSave.save({ serviceTier }, { field: "serviceTier" })}
                disabled={editsDisabled}
              />
            ) : null}
          </Section>
          {/* Only model/effort/service-tier failures belong here; env failures surface at the
              Env section (dialog for add/edit, toast for delete). */}
          {configSave.errorField === "model" ||
          configSave.errorField === "effort" ||
          configSave.errorField === "serviceTier" ? (
            configSave.conflict ? (
              <p className="text-body" style={{ color: "var(--state-blocked)", margin: "var(--sp-2) 0 0" }}>
                This agent's configuration was updated elsewhere; reloaded the latest values.
              </p>
            ) : configSave.saveError ? (
              <p className="text-body" style={{ color: "var(--state-error)", margin: "var(--sp-2) 0 0" }}>
                Failed to save: {configSave.saveError}
              </p>
            ) : null
          ) : null}
        </div>
      )}

      {/* Environment variables — saves immediately on add / edit / delete. */}
      {config && (
        <div style={{ marginTop: "var(--sp-8)" }}>
          <EnvSection
            items={config.payload.env}
            onSave={(next, opts) =>
              configSave.save({ env: next }, { field: "env", onSuccess: opts?.onSuccess, onError: opts?.onError })
            }
            disabled={ctx.agent.status !== "active"}
            saving={configSave.pending}
            saveError={
              configSave.errorField === "env"
                ? configSave.conflict
                  ? "This agent's configuration was updated elsewhere — reloaded the latest values. Re-enter and try again."
                  : configSave.saveError
                : null
            }
            saved={envSaved}
          />
        </div>
      )}
    </>
  );
}
