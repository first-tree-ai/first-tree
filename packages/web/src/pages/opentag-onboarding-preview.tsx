import { orderRuntimeProvidersByPreference, type RuntimeProvider, runtimeProviderLabel } from "@first-tree/shared";
import { ArrowRight, Check, ExternalLink } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { type ReactElement, type ReactNode, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import type { HubClient } from "../api/activity.js";
import { ConnectedComputerSelect, ConnectedComputerSummary } from "../components/connected-computer-select.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { OptionCard } from "../components/ui/option-card.js";
import { resolveComputerSelection, resolveRuntimeSelection } from "../features/agent-setup/computer-selection.js";
import { CommandBox, FlowHint } from "./onboarding/flow-ui.js";
import "./opentag-onboarding-preview-brand.css";

/**
 * DEV-only state-coverage prototype for the confirmed four-step OpenTag shell.
 *
 * One direction, not a visual variant exercise: `step`, `state`, and
 * `viewport` make every review target shareable while fixtures stay local and
 * deterministic. This route never calls an API or writes lifecycle state.
 */

const PREVIEW_STEPS = ["focus", "computer", "feishu", "first-task"] as const;
type PreviewStep = (typeof PREVIEW_STEPS)[number];
type PreviewViewport = "desktop" | "mobile";

const STATE_OPTIONS = {
  focus: [{ value: "ready", label: "Ready / valid" }],
  computer: [
    { value: "no-computer", label: "No computer / waiting" },
    { value: "command-error", label: "Setup command error" },
    { value: "ready", label: "One computer / selectable" },
    { value: "multiple-computers", label: "Multiple computers / choose" },
    { value: "checking", label: "Checking coding agents" },
    { value: "no-coding-agent", label: "No supported coding agent" },
  ],
  feishu: [
    { value: "ready", label: "Bot ready to connect" },
    { value: "provisioning", label: "Provisioning / waiting" },
  ],
  "first-task": [
    { value: "waiting", label: "Waiting for real message" },
    { value: "completed", label: "Completed endpoint" },
  ],
} as const;

type PreviewState = (typeof STATE_OPTIONS)[PreviewStep][number]["value"];
type ComputerPreviewState = (typeof STATE_OPTIONS.computer)[number]["value"];

const STEP_META: Record<
  PreviewStep,
  {
    number: number;
    group: "Create agent" | "Start in Feishu";
    railTitle: string;
    railDetail: string;
    title: string;
    lead: string;
  }
> = {
  focus: {
    number: 1,
    group: "Create agent",
    railTitle: "Shape your agent",
    railDetail: "Focus & name",
    title: "What should your agent do?",
    lead: "Choose the kind of work you want to delegate. We'll use the matching template as its starting setup, and you can refine it later.",
  },
  computer: {
    number: 2,
    group: "Create agent",
    railTitle: "Set up its runtime",
    railDetail: "Computer & coding agent",
    title: "Connect your computer",
    lead: "Connect or choose the computer where your agent will work. We'll use an available coding agent on it.",
  },
  feishu: {
    number: 3,
    group: "Start in Feishu",
    railTitle: "Add it to Feishu",
    railDetail: "Connect its bot",
    title: "Add OpenTag to Feishu",
    lead: "Create the bot, then confirm it in Feishu.",
  },
  "first-task": {
    number: 4,
    group: "Start in Feishu",
    railTitle: "Start working together",
    railDetail: "First task",
    title: "Send your first task",
    lead: "Send the bot a private message, or @mention it in a group. This page updates automatically.",
  },
};

const FOCUS_OPTIONS = [
  {
    slug: "team-assistant",
    name: "Team Assistant",
    tagline: "For team questions, decisions, and follow-through.",
    example: "Summarize today's decisions for the wider team",
  },
  {
    slug: "software-engineer",
    name: "Software Engineer",
    tagline: "For debugging, code review, and implementation planning.",
    example: "Turn the requirements from this discussion into an implementation plan.",
  },
  {
    slug: "researcher",
    name: "Researcher",
    tagline: "For evidence gathering, comparison, and decision support.",
    example: "Research this market and identify the main competitors and differentiators.",
  },
] as const;

const DEFAULT_STATE: Record<PreviewStep, PreviewState> = {
  focus: "ready",
  computer: "no-computer",
  feishu: "ready",
  "first-task": "waiting",
};

// Opaque deterministic fixture for the server-authored `bootstrapCommand`.
// The Preview passes it through unchanged; production OpenTag receives the
// real release-channel-aware value from `useComputerConnection`.
const PREVIEW_SERVER_BOOTSTRAP_COMMAND =
  "curl -fsSL https://download.first-tree.ai/releases/prod/install.sh | sh\n" +
  "~/.local/bin/first-tree login ft_preview_only";
const PREVIEW_FEISHU_URL = "https://open.feishu.cn/app/preview-only-registration";
const PREVIEW_FIRST_USE_CHAT_ID = "preview-first-feishu-task";

const PREVIEW_COMPUTERS = [
  previewComputer("preview-macbook", "Gandy's MacBook", "darwin", "2026-08-13T10:00:00.000Z"),
  previewComputer("preview-studio", "Team Studio", "linux", "2026-08-13T09:00:00.000Z"),
];

const PREVIEW_CODING_AGENTS: Readonly<Record<string, readonly RuntimeProvider[]>> = {
  "preview-macbook": ["claude-code", "codex"],
  "preview-studio": ["claude-code"],
};

function previewComputer(id: string, hostname: string, os: string, lastSeenAt: string): HubClient {
  return {
    id,
    userId: null,
    status: "connected",
    authState: "ok",
    binName: "first-tree",
    sdkVersion: null,
    hostname,
    os,
    agentCount: 0,
    connectedAt: lastSeenAt,
    lastSeenAt,
    capabilities: {},
  };
}
export function OpenTagOnboardingPreviewPage(): ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const step = parseStep(searchParams.get("step"));
  const state = parseState(step, searchParams.get("state"));
  const viewport = parseViewport(searchParams.get("viewport"));

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "OpenTag onboarding preview";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  const setPreview = (next: { step?: PreviewStep; state?: PreviewState; viewport?: PreviewViewport }): void => {
    const nextStep = next.step ?? step;
    const nextState = next.state ?? (next.step ? DEFAULT_STATE[nextStep] : state);
    setSearchParams({ step: nextStep, state: nextState, viewport: next.viewport ?? viewport }, { replace: true });
  };

  return (
    <div className="min-h-screen bg-sunken" style={{ paddingBottom: "var(--sp-20)" }}>
      <div
        className="mx-auto min-h-screen bg-background"
        style={
          viewport === "mobile"
            ? { maxWidth: "calc(var(--sp-95) + var(--sp-2_5))", boxShadow: "var(--shadow-md)" }
            : undefined
        }
      >
        <PreviewShell step={step} state={state} viewport={viewport}>
          <StepContent
            step={step}
            state={state}
            viewport={viewport}
            onAdvance={(nextStep) => setPreview({ step: nextStep })}
            onStateChange={(nextState) => setPreview({ state: nextState })}
          />
        </PreviewShell>
      </div>
      <PreviewController
        step={step}
        state={state}
        viewport={viewport}
        onStepChange={(nextStep) => setPreview({ step: nextStep })}
        onStateChange={(nextState) => setPreview({ state: nextState })}
        onViewportChange={(nextViewport) => setPreview({ viewport: nextViewport })}
      />
    </div>
  );
}

function PreviewShell({
  step,
  state,
  viewport,
  children,
}: {
  step: PreviewStep;
  state: PreviewState;
  viewport: PreviewViewport;
  children: ReactNode;
}): ReactElement {
  const meta = STEP_META[step];
  const pageCopy =
    step === "first-task" && state === "completed"
      ? {
          title: "Your first task is ready",
          lead: "Keep the conversation in Feishu. You can follow the work and its full history here.",
        }
      : meta;
  const mobile = viewport === "mobile";
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header
        className="flex items-center justify-between border-b border-border-faint"
        style={{ padding: "var(--sp-4) var(--sp-5)" }}
      >
        <OpenTagBrand />
        <Button type="button" variant="link" className="h-auto p-0 text-body">
          Sign out
        </Button>
      </header>

      <div
        className={mobile ? "mx-auto flex w-full flex-1 flex-col" : "mx-auto grid w-full flex-1"}
        style={
          mobile
            ? { maxWidth: "var(--sp-95)", padding: "var(--sp-6) var(--sp-5) var(--sp-10)" }
            : {
                maxWidth: "calc(var(--sp-95) * 2 + var(--sp-70) + var(--sp-10))",
                gridTemplateColumns: "calc(var(--sp-45) + var(--sp-7)) minmax(0, calc(var(--sp-95) * 2 + var(--sp-2)))",
                columnGap: "var(--sp-10)",
                padding: "var(--sp-10) var(--sp-5)",
              }
        }
      >
        {mobile ? <MobileProgress activeIndex={meta.number - 1} /> : <DesktopRail step={step} />}
        <main className="min-w-0">
          <p className="text-eyebrow" style={{ margin: 0, color: "var(--fg-3)" }}>
            Step {meta.number} of 4 · {meta.group}
          </p>
          <h1 className="text-title font-semibold" style={{ margin: "var(--sp-3) 0 var(--sp-3)", color: "var(--fg)" }}>
            {pageCopy.title}
          </h1>
          <p
            className="text-body"
            style={{ margin: "0 0 var(--sp-8)", color: "var(--fg-3)", maxWidth: "var(--sp-95)" }}
          >
            {pageCopy.lead}
          </p>
          {children}
        </main>
      </div>
    </div>
  );
}

function DesktopRail({ step }: { step: PreviewStep }): ReactElement {
  return (
    <nav aria-label="OpenTag setup progress">
      <RailGroup label="Create agent" steps={PREVIEW_STEPS.slice(0, 2)} activeStep={step} />
      <div style={{ marginTop: "var(--sp-8)" }}>
        <RailGroup label="Start in Feishu" steps={PREVIEW_STEPS.slice(2)} activeStep={step} />
      </div>
    </nav>
  );
}

function RailGroup({
  label,
  steps,
  activeStep,
}: {
  label: string;
  steps: readonly PreviewStep[];
  activeStep: PreviewStep;
}): ReactElement {
  return (
    <div>
      <p className="text-eyebrow" style={{ margin: "0 0 var(--sp-4)", color: "var(--fg-3)" }}>
        {label}
      </p>
      <ol className="flex flex-col" style={{ margin: 0, padding: 0, listStyle: "none", gap: "var(--sp-5)" }}>
        {steps.map((candidate) => {
          const meta = STEP_META[candidate];
          const active = candidate === activeStep;
          const complete = meta.number < STEP_META[activeStep].number;
          return (
            <li key={candidate} className="flex items-start" style={{ gap: "var(--sp-3)" }}>
              <span
                aria-hidden="true"
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-full)] text-caption font-semibold"
                style={{
                  border: active || complete ? "none" : "var(--hairline) solid var(--border-strong)",
                  background: active ? "var(--primary)" : complete ? "var(--bg-active)" : "transparent",
                  color: active ? "var(--primary-on)" : "var(--fg-3)",
                }}
              >
                {complete ? <Check className="h-3.5 w-3.5" /> : meta.number}
              </span>
              <span className="min-w-0">
                <span
                  className={`block text-body ${active ? "font-semibold" : "font-medium"}`}
                  style={{ color: active ? "var(--fg)" : "var(--fg-2)" }}
                >
                  {meta.railTitle}
                </span>
                <span className="block text-caption" style={{ color: "var(--fg-4)" }}>
                  {meta.railDetail}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function MobileProgress({ activeIndex }: { activeIndex: number }): ReactElement {
  return (
    <div
      className="mb-10 grid grid-cols-4"
      role="progressbar"
      aria-label="OpenTag setup progress"
      aria-valuemin={1}
      aria-valuemax={4}
      aria-valuenow={activeIndex + 1}
      style={{ gap: "var(--sp-2)" }}
    >
      {PREVIEW_STEPS.map((step, index) => (
        <span
          key={step}
          aria-hidden="true"
          className="h-1 rounded-[var(--radius-full)]"
          style={{ background: index <= activeIndex ? "var(--primary)" : "var(--border)" }}
        />
      ))}
    </div>
  );
}

function StepContent({
  step,
  state,
  viewport,
  onAdvance,
  onStateChange,
}: {
  step: PreviewStep;
  state: PreviewState;
  viewport: PreviewViewport;
  onAdvance: (step: PreviewStep) => void;
  onStateChange: (state: PreviewState) => void;
}): ReactElement {
  switch (step) {
    case "focus":
      return <FocusAndNameStep mobile={viewport === "mobile"} onAdvance={() => onAdvance("computer")} />;
    case "computer":
      return (
        <ComputerStep
          key={state}
          state={parseComputerState(state)}
          mobile={viewport === "mobile"}
          onAdvance={() => onAdvance("feishu")}
          onStateChange={onStateChange}
        />
      );
    case "feishu":
      return state === "provisioning" ? (
        <FeishuProvisioningStep />
      ) : (
        <FeishuReadyStep mobile={viewport === "mobile"} onConnect={() => onStateChange("provisioning")} />
      );
    case "first-task":
      return state === "completed" ? <FirstTaskCompletedStep /> : <FirstTaskWaitingStep />;
  }
}

function FocusAndNameStep({ mobile, onAdvance }: { mobile: boolean; onAdvance: () => void }): ReactElement {
  const [focus, setFocus] = useState<(typeof FOCUS_OPTIONS)[number]["slug"]>("team-assistant");
  const [name, setName] = useState("gandy2025 assistant");
  const selected = FOCUS_OPTIONS.find((option) => option.slug === focus) ?? FOCUS_OPTIONS[0];
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-7)" }}>
      <fieldset className="flex flex-col" style={{ gap: "var(--sp-3)", margin: 0, padding: 0, border: 0 }}>
        <legend className="sr-only">Work focus</legend>
        {FOCUS_OPTIONS.map((option) => (
          <OptionCard
            key={option.slug}
            name="preview-work-focus"
            checked={focus === option.slug}
            onSelect={() => setFocus(option.slug)}
          >
            <span className="min-w-0 flex-1">
              <span className={mobile ? "block" : "flex items-center"} style={{ gap: "var(--sp-4)" }}>
                <span className="text-subtitle font-semibold">{option.name}</span>
                {option.slug === "team-assistant" ? (
                  <span
                    className="block text-eyebrow"
                    style={{ marginTop: mobile ? "var(--sp-1)" : 0, color: "var(--fg-3)" }}
                  >
                    Best for most teams
                  </span>
                ) : null}
              </span>
              <span className="mt-1 block text-body" style={{ color: "var(--fg-3)" }}>
                {option.tagline}
              </span>
            </span>
          </OptionCard>
        ))}
      </fieldset>

      <LabeledDetail label="Example task">{selected.example}</LabeledDetail>

      <div className="flex flex-col" style={{ gap: "var(--sp-2)" }}>
        <label htmlFor="preview-agent-name" className="text-label font-semibold" style={{ color: "var(--fg-2)" }}>
          Agent name
        </label>
        <Input id="preview-agent-name" value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
      </div>

      <div className="flex">
        <Button
          type="button"
          variant="cta"
          className={mobile ? "w-full" : undefined}
          disabled={!name.trim()}
          onClick={onAdvance}
        >
          Set up its runtime <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function ComputerStep({
  state,
  mobile,
  onAdvance,
  onStateChange,
}: {
  state: ComputerPreviewState;
  mobile: boolean;
  onAdvance: () => void;
  onStateChange: (state: PreviewState) => void;
}): ReactElement {
  if (state === "no-computer" || state === "command-error") {
    return (
      <ComputerRecoveryStep commandError={state === "command-error"} onRetry={() => onStateChange("no-computer")} />
    );
  }

  const computers = state === "multiple-computers" ? PREVIEW_COMPUTERS : PREVIEW_COMPUTERS.slice(0, 1);
  return (
    <ComputerSelectionStep
      computers={computers}
      capabilitiesLoaded={state !== "checking"}
      noCodingAgent={state === "no-coding-agent"}
      mobile={mobile}
      onAdvance={onAdvance}
    />
  );
}

function ComputerRecoveryStep({ commandError, onRetry }: { commandError: boolean; onRetry: () => void }): ReactElement {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-6)" }}>
      <div className="flex flex-col" style={{ gap: "var(--sp-3)" }}>
        <p className="text-label font-semibold" style={{ margin: 0, color: "var(--fg-2)" }}>
          Connect your computer
        </p>
        <p className="text-body" style={{ margin: 0, color: "var(--fg-3)" }}>
          Connect the computer where you want this agent to work.
        </p>
        {commandError ? (
          <FlowHint tone="error" role="alert">
            We couldn't prepare the setup command.
          </FlowHint>
        ) : (
          <>
            <p className="text-label font-medium" style={{ margin: 0, color: "var(--fg-2)" }}>
              Open Terminal on that computer and run:
            </p>
            <CommandBox command={PREVIEW_SERVER_BOOTSTRAP_COMMAND} />
          </>
        )}
      </div>
      {commandError ? (
        <Button type="button" className="w-fit" onClick={onRetry}>
          Try again
        </Button>
      ) : (
        <PreviewStatusRow state="waiting" label="Waiting for your computer to connect…" />
      )}
      <Button type="button" variant="link" className="h-auto w-fit p-0 text-label">
        Back to focus & name
      </Button>
    </div>
  );
}

function ComputerSelectionStep({
  computers,
  capabilitiesLoaded,
  noCodingAgent,
  mobile,
  onAdvance,
}: {
  computers: HubClient[];
  capabilitiesLoaded: boolean;
  noCodingAgent: boolean;
  mobile: boolean;
  onAdvance: () => void;
}): ReactElement {
  const clientIds = useMemo(() => computers.map((computer) => computer.id), [computers]);
  const [currentClientId, setCurrentClientId] = useState<string | null>(null);
  const [explicitClientId, setExplicitClientId] = useState<string | null>(null);
  const selectedClientId = resolveComputerSelection({
    clientIds,
    currentClientId,
    explicitlySelectedClientId: explicitClientId,
    requireExplicitWhenMultiple: true,
  });
  const selectedComputer = computers.find((computer) => computer.id === selectedClientId) ?? null;
  const orderedCodingAgents = useMemo(
    () =>
      selectedClientId && capabilitiesLoaded && !noCodingAgent
        ? orderRuntimeProvidersByPreference(PREVIEW_CODING_AGENTS[selectedClientId] ?? [])
        : [],
    [capabilitiesLoaded, noCodingAgent, selectedClientId],
  );
  const [currentCodingAgent, setCurrentCodingAgent] = useState<RuntimeProvider | null>(null);
  const [codingAgentSelectionIsManual, setCodingAgentSelectionIsManual] = useState(false);
  const codingAgentSelection = resolveRuntimeSelection({
    currentRuntime: currentCodingAgent,
    selectionIsManual: codingAgentSelectionIsManual,
    readyRuntimes: orderedCodingAgents,
  });

  useEffect(() => {
    setCurrentClientId((current) => (current === selectedClientId ? current : selectedClientId));
  }, [selectedClientId]);

  useEffect(() => {
    setCurrentCodingAgent((current) =>
      current === codingAgentSelection.runtime ? current : codingAgentSelection.runtime,
    );
    setCodingAgentSelectionIsManual((current) =>
      current === codingAgentSelection.selectionIsManual ? current : codingAgentSelection.selectionIsManual,
    );
  }, [codingAgentSelection.runtime, codingAgentSelection.selectionIsManual]);

  const selectedCodingAgent = codingAgentSelection.runtime;
  const canCreate =
    !!selectedClientId &&
    !!selectedCodingAgent &&
    orderedCodingAgents.includes(selectedCodingAgent) &&
    capabilitiesLoaded;

  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-7)" }}>
      <fieldset className="flex flex-col" style={{ gap: "var(--sp-3)", margin: 0, padding: 0, border: 0 }}>
        <legend className="text-label font-semibold" style={{ color: "var(--fg-2)" }}>
          {computers.length > 1 ? "Choose a computer" : "Computer"}
        </legend>
        {computers.length > 1 ? (
          <ConnectedComputerSelect
            clients={computers}
            value={selectedClientId}
            onChange={(clientId) => {
              setExplicitClientId(clientId);
              setCurrentClientId(clientId);
            }}
            id="preview-opentag-runtime-computer"
          />
        ) : selectedComputer ? (
          <ConnectedComputerSummary client={selectedComputer} />
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col" style={{ gap: "var(--sp-3)", margin: 0, padding: 0, border: 0 }}>
        <legend className="text-label font-semibold" style={{ color: "var(--fg-2)" }}>
          Coding agent
        </legend>
        {selectedComputer ? (
          !capabilitiesLoaded ? (
            <p className="text-body" role="status" style={{ margin: 0, color: "var(--fg-3)" }}>
              Checking available coding agents…
            </p>
          ) : orderedCodingAgents.length === 0 ? (
            <FlowHint role="status">
              No supported coding agent was found on this computer. Install one, then we'll check again.
            </FlowHint>
          ) : (
            <div className="flex flex-wrap" style={{ gap: "var(--sp-2)" }}>
              {orderedCodingAgents.map((provider) => (
                <OptionCard
                  key={provider}
                  name="preview-opentag-coding-agent"
                  layout="pill"
                  checked={selectedCodingAgent === provider}
                  onSelect={() => {
                    setCurrentCodingAgent(provider);
                    setCodingAgentSelectionIsManual(true);
                  }}
                >
                  <span className="text-body">{runtimeProviderLabel(provider)}</span>
                </OptionCard>
              ))}
            </div>
          )
        ) : null}
      </fieldset>

      <LabeledDetail label="Draft agent">gandy2025 assistant · Team Assistant</LabeledDetail>
      <div className="flex">
        <Button
          type="button"
          variant="cta"
          className={mobile ? "w-full" : undefined}
          disabled={!canCreate}
          onClick={onAdvance}
        >
          Create agent <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function FeishuReadyStep({ mobile, onConnect }: { mobile: boolean; onConnect: () => void }): ReactElement {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-7)" }}>
      <div className="flex">
        <Button type="button" variant="cta" className={mobile ? "w-full" : undefined} onClick={onConnect}>
          Add OpenTag to Feishu <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function FeishuProvisioningStep(): ReactElement {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
      <PreviewFeishuRegistrationQr />
      <PreviewStatusRow state="waiting" label="Waiting for Feishu to confirm the bot…" />
    </div>
  );
}

function PreviewFeishuRegistrationQr(): ReactElement {
  return (
    <div className="flex flex-col items-center" style={{ gap: "var(--sp-3)", padding: "var(--sp-4) 0" }}>
      <QRCodeSVG
        value={PREVIEW_FEISHU_URL}
        className="h-[var(--sp-45)] w-[var(--sp-45)]"
        title="Feishu bot registration QR code"
      />
      <div className="text-label text-center" style={{ color: "var(--fg-3)" }}>
        Scan with Feishu and confirm creating the bot. This page updates automatically.
      </div>
      <Button size="xs" variant="outline" asChild>
        <a href={PREVIEW_FEISHU_URL} target="_blank" rel="noreferrer">
          Open confirmation page <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </Button>
    </div>
  );
}

function FirstTaskWaitingStep(): ReactElement {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-5)" }}>
      <PreviewStatusRow state="waiting" label="Waiting for the first message…" />
    </div>
  );
}

function FirstTaskCompletedStep(): ReactElement {
  return (
    <div className="flex flex-col" style={{ gap: "var(--sp-7)" }}>
      <PreviewStatusRow state="ok" label="gandy2025 assistant received its first task from Feishu." />
      <Button asChild className="w-fit">
        <a href={`/?c=${encodeURIComponent(PREVIEW_FIRST_USE_CHAT_ID)}`}>
          View task <ArrowRight className="h-4 w-4" />
        </a>
      </Button>
    </div>
  );
}

function LabeledDetail({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div>
      <p className="text-label font-semibold" style={{ margin: "0 0 var(--sp-2)", color: "var(--fg-2)" }}>
        {label}
      </p>
      <p className="text-body" style={{ margin: 0, color: "var(--fg-2)" }}>
        {children}
      </p>
    </div>
  );
}

function OpenTagBrand(): ReactElement {
  return (
    <span className="inline-flex items-center" style={{ gap: "var(--sp-2_25)" }}>
      <span className="opentag-preview-logo" aria-hidden="true" />
      <span className="opentag-preview-wordmark">OpenTag</span>
    </span>
  );
}

function PreviewStatusRow({ state, label }: { state: "waiting" | "ok"; label: ReactNode }): ReactElement {
  return (
    <div
      className="inline-flex items-center text-label"
      role="status"
      aria-live="polite"
      style={{ gap: "var(--sp-2)", color: "var(--fg-3)" }}
    >
      {state === "ok" ? (
        <Check className="h-3.5 w-3.5" style={{ color: "var(--success)" }} aria-hidden="true" />
      ) : (
        <span
          aria-hidden="true"
          style={{
            width: "var(--sp-2)",
            height: "var(--sp-2)",
            borderRadius: "var(--radius-full)",
            border: "var(--hairline) solid var(--border-strong)",
            background: "var(--bg-raised)",
          }}
        />
      )}
      <span>{label}</span>
    </div>
  );
}

function PreviewController({
  step,
  state,
  viewport,
  onStepChange,
  onStateChange,
  onViewportChange,
}: {
  step: PreviewStep;
  state: PreviewState;
  viewport: PreviewViewport;
  onStepChange: (step: PreviewStep) => void;
  onStateChange: (state: PreviewState) => void;
  onViewportChange: (viewport: PreviewViewport) => void;
}): ReactElement {
  return (
    <aside
      aria-label="Preview controls"
      className={
        viewport === "mobile" ? "fixed right-3 bottom-3 z-50" : "fixed bottom-3 left-1/2 z-50 -translate-x-1/2"
      }
    >
      <details
        className="surface-overlay"
        open={viewport === "desktop"}
        style={{ padding: "var(--sp-3)", maxWidth: "calc(100vw - var(--sp-6))" }}
      >
        <summary className="cursor-pointer text-eyebrow font-semibold uppercase" style={{ color: "var(--fg-3)" }}>
          Preview only
        </summary>
        <div className="flex flex-wrap items-end" style={{ gap: "var(--sp-3)", paddingTop: "var(--sp-2)" }}>
          <PreviewSelect label="Step" value={step} onChange={(value) => onStepChange(parseStep(value))}>
            {PREVIEW_STEPS.map((option) => (
              <option key={option} value={option}>
                {STEP_META[option].number}. {STEP_META[option].railTitle}
              </option>
            ))}
          </PreviewSelect>
          <PreviewSelect label="State" value={state} onChange={(value) => onStateChange(parseState(step, value))}>
            {STATE_OPTIONS[step].map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </PreviewSelect>
          <PreviewSelect label="Viewport" value={viewport} onChange={(value) => onViewportChange(parseViewport(value))}>
            <option value="desktop">Desktop</option>
            <option value="mobile">Mobile · 390</option>
          </PreviewSelect>
        </div>
      </details>
    </aside>
  );
}

function PreviewSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}): ReactElement {
  return (
    <label className="flex flex-col" style={{ gap: "var(--sp-1)" }}>
      <span className="text-eyebrow uppercase" style={{ color: "var(--fg-3)" }}>
        {label}
      </span>
      <select
        className="h-8 rounded-[var(--radius-input)] border border-input bg-background px-2 text-label text-foreground focus-visible:border-ring focus-visible:outline-none"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </label>
  );
}

function parseStep(value: string | null): PreviewStep {
  return PREVIEW_STEPS.find((step) => step === value) ?? "focus";
}

function parseState(step: PreviewStep, value: string | null): PreviewState {
  return STATE_OPTIONS[step].find((state) => state.value === value)?.value ?? DEFAULT_STATE[step];
}

function parseComputerState(value: PreviewState): ComputerPreviewState {
  return STATE_OPTIONS.computer.find((state) => state.value === value)?.value ?? "no-computer";
}

function parseViewport(value: string | null): PreviewViewport {
  return value === "mobile" ? "mobile" : "desktop";
}
