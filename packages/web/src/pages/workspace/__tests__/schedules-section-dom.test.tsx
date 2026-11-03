// @vitest-environment happy-dom

import type { ChatParticipantDetail, CronJob, CronPreviewResponse, ListCronJobsResponse } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const cronApiMocks = vi.hoisted(() => ({
  listChatCronJobs: vi.fn(),
  previewChatCronJobs: vi.fn(),
  patchCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  memberId: "member-owner" as string | null,
}));

const toastMock = vi.hoisted(() => ({
  addToast: vi.fn(),
}));

vi.mock("../../../api/cron-jobs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/cron-jobs.js")>()),
  listChatCronJobs: cronApiMocks.listChatCronJobs,
  previewChatCronJobs: cronApiMocks.previewChatCronJobs,
  patchCronJob: cronApiMocks.patchCronJob,
  deleteCronJob: cronApiMocks.deleteCronJob,
}));

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => ({ memberId: authMock.memberId }),
}));

vi.mock("../../../components/ui/toast.js", () => ({
  useToast: () => ({ addToast: toastMock.addToast }),
}));

const OWNER_PARTICIPANT: ChatParticipantDetail = {
  type: "human",
  agentId: "human-agent-1",
  displayName: "Owner Human",
  avatarImageUrl: null,
  avatarColorToken: null,
} as unknown as ChatParticipantDetail;

const TARGET_AGENT: ChatParticipantDetail = {
  type: "agent",
  agentId: "agent-1",
  displayName: "Byte",
  avatarImageUrl: null,
  avatarColorToken: null,
} as unknown as ChatParticipantDetail;

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: overrides.id ?? "job-1",
    ownerMemberId: overrides.ownerMemberId ?? "member-owner",
    controlChatId: overrides.controlChatId ?? "chat-1",
    agentId: overrides.agentId ?? "agent-1",
    name: overrides.name ?? "Daily standup summary",
    chatMode: "reuse_control_chat",
    schedule: overrides.schedule ?? "0 9 * * 1-5",
    timezone: overrides.timezone ?? "America/New_York",
    prompt: overrides.prompt ?? "Summarize the standup.",
    state: overrides.state ?? "active",
    stateReason: overrides.stateReason ?? null,
    revision: overrides.revision ?? 3,
    nextRunAt: overrides.nextRunAt ?? "2030-01-05T14:00:00.000Z",
    outstanding: overrides.outstanding ?? null,
    createdAt: overrides.createdAt ?? "2030-01-01T00:00:00.000Z",
  };
}

function previewResponse(firstAt = "2030-01-05T14:00:00.000Z"): CronPreviewResponse {
  const start = new Date(firstAt).getTime();
  return {
    schedule: "0 9 * * 1-5",
    timezone: "America/New_York",
    occurrences: [0, 1, 2, 3, 4].map((i) => {
      const at = new Date(start + i * 86_400_000).toISOString();
      return { at, local: `${at} (job tz)`, timezone: "America/New_York" };
    }),
  };
}

let queryClient: QueryClient;
let root: Root | null = null;
let container: HTMLElement | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDom(element: ReactElement): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root?.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
  });
  await flush();
}

async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error("Expected element to click");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
}

function buttonByLabel(label: string): HTMLButtonElement | null {
  return document.querySelector(`button[aria-label="${label}"]`);
}

// The component-under-test formats dates with Intl's default (ambient)
// locale, so on a developer machine whose LANG is not English these
// hardcoded English assertions see translated output and fail. Pin the
// default locale for this file to keep the suite hermetic anywhere.
class DateTimeFormatEn extends Intl.DateTimeFormat {
  constructor(locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
    super(locales ?? "en-US", options);
  }
}
class RelativeTimeFormatEn extends Intl.RelativeTimeFormat {
  constructor(locales?: string | string[], options?: Intl.RelativeTimeFormatOptions) {
    super(locales ?? "en-US", options);
  }
}
const intlEn = Object.create(Intl) as typeof Intl;
Object.defineProperty(intlEn, "DateTimeFormat", { value: DateTimeFormatEn });
Object.defineProperty(intlEn, "RelativeTimeFormat", { value: RelativeTimeFormatEn });

beforeEach(() => {
  vi.stubGlobal("Intl", intlEn);
  vi.clearAllMocks();
  authMock.memberId = "member-owner";
  cronApiMocks.listChatCronJobs.mockResolvedValue({ items: [] } satisfies ListCronJobsResponse);
  cronApiMocks.previewChatCronJobs.mockResolvedValue(previewResponse());
  cronApiMocks.patchCronJob.mockImplementation(async (_id, body) => makeJob(body));
  cronApiMocks.deleteCronJob.mockResolvedValue({
    id: "job-1",
    deleted: true,
    acceptedWorkPreserved: false,
    lastTriggerMessageId: null,
  });
  document.body.innerHTML = "";
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (root) await act(async () => root?.unmount());
  root = null;
  container = null;
  document.body.innerHTML = "";
});

async function renderSection(jobs: CronJob[], chatId = "chat-1") {
  cronApiMocks.listChatCronJobs.mockResolvedValue({ items: jobs });
  const { SchedulesSection } = await import("../right-sidebar/schedules-section.js");
  await renderDom(<SchedulesSection chatId={chatId} participants={[OWNER_PARTICIPANT, TARGET_AGENT]} />);
}

describe("SchedulesSection rendering", () => {
  it("renders active count, state, schedule/timezone, agent, next run, and outstanding badge", async () => {
    await renderSection([
      makeJob({ outstanding: { messageId: "msg-1", status: "delivered" } }),
      makeJob({
        id: "job-2",
        name: "Weekly digest",
        state: "paused",
        stateReason: "owner_chat_deleted",
        nextRunAt: null,
      }),
    ]);

    expect(document.body.textContent).toContain("Schedules · 1");
    expect(document.body.textContent).toContain("Daily standup summary");
    expect(document.body.textContent).toContain("0 9 * * 1-5 · America/New_York");
    expect(document.body.textContent).toContain("Byte");
    expect(document.body.textContent).toContain("next in");
    expect(document.body.textContent).toContain("Trigger delivered");
    expect(document.body.textContent).toContain("Paused — the owner deleted this chat");
    expect(document.body.textContent).toContain("Weekly digest");
  });

  it("shows an identifiable loading row instead of looking schedule-free", async () => {
    cronApiMocks.listChatCronJobs.mockReturnValue(new Promise(() => {}));
    const { SchedulesSection } = await import("../right-sidebar/schedules-section.js");
    await renderDom(<SchedulesSection chatId="chat-1" participants={[]} />);

    expect(document.body.textContent).toContain("Schedules");
    expect(document.body.textContent).toContain("Loading schedules…");
  });

  it("hides entirely once the chat is known to have no schedules", async () => {
    await renderSection([]);
    expect(document.body.textContent).not.toContain("Schedules");
  });

  it("shows a retry row on load error instead of silently hiding schedules", async () => {
    cronApiMocks.listChatCronJobs.mockRejectedValue(new ApiError(500, "boom"));
    const { SchedulesSection } = await import("../right-sidebar/schedules-section.js");
    await renderDom(<SchedulesSection chatId="chat-1" participants={[]} />);

    expect(document.body.textContent).toContain("Schedules could not be loaded.");
    cronApiMocks.listChatCronJobs.mockResolvedValue({ items: [makeJob()] });
    await click(buttonByText("Retry"));
    expect(document.body.textContent).toContain("Daily standup summary");
  });

  it("expands a row to show prompt, visible absolute next run, and previewed upcoming runs", async () => {
    const longPrompt = "Line one\n\nLine two with details ".repeat(20);
    await renderSection([makeJob({ prompt: longPrompt })]);

    expect(document.body.textContent).not.toContain("Line two with details");
    await click(document.querySelector("button[aria-expanded]"));

    expect(document.body.textContent).toContain("Line two with details");
    // Absolute next run is visible text (keyboard/AT reachable), not only a tooltip.
    expect(document.body.textContent).toContain("Next run:");
    expect(document.body.textContent).toContain("Upcoming runs");
    expect(cronApiMocks.previewChatCronJobs).toHaveBeenCalledWith("chat-1", {
      schedule: "0 9 * * 1-5",
      timezone: "America/New_York",
    });
    expect(document.body.textContent).toContain("2030-01-05T14:00:00.000Z");
  });

  it("paused jobs still show prompt and future occurrences, labeled as if-resumed", async () => {
    await renderSection([makeJob({ state: "paused", stateReason: "user_paused", nextRunAt: null })]);
    await click(document.querySelector("button[aria-expanded]"));

    expect(document.body.textContent).toContain("Summarize the standup.");
    expect(document.body.textContent).toContain("Upcoming runs (if resumed)");
    expect(cronApiMocks.previewChatCronJobs).toHaveBeenCalled();
    expect(document.body.textContent).toContain("2030-01-05T14:00:00.000Z");
  });

  it("labels an unknown target agent without crashing", async () => {
    await renderSection([makeJob({ agentId: "agent-gone" })]);
    expect(document.body.textContent).toContain("Unknown agent");
  });
});

describe("SchedulesSection ownership", () => {
  it("shows lifecycle controls only to the owning member", async () => {
    await renderSection([makeJob()]);
    await click(document.querySelector("button[aria-expanded]"));
    expect(buttonByLabel("Pause schedule Daily standup summary")).toBeTruthy();
    expect(buttonByLabel("Delete schedule Daily standup summary")).toBeTruthy();
  });

  it("hides lifecycle controls from non-owner readers while keeping facts visible", async () => {
    authMock.memberId = "member-other";
    await renderSection([makeJob()]);
    await click(document.querySelector("button[aria-expanded]"));

    expect(document.body.textContent).toContain("Summarize the standup.");
    expect(buttonByLabel("Pause schedule Daily standup summary")).toBeNull();
    expect(buttonByLabel("Delete schedule Daily standup summary")).toBeNull();
    expect(buttonByLabel("Resume schedule Daily standup summary")).toBeNull();
  });
});

describe("SchedulesSection owner actions", () => {
  it("pauses in one click with the current revision and refreshes on success", async () => {
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    await renderSection([makeJob()]);
    await click(document.querySelector("button[aria-expanded]"));

    await click(buttonByLabel("Pause schedule Daily standup summary"));
    expect(cronApiMocks.patchCronJob).toHaveBeenCalledTimes(1);
    expect(cronApiMocks.patchCronJob).toHaveBeenCalledWith("job-1", { state: "paused" }, 3);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["chat-right-sidebar", "cron-jobs", "chat-1"] });
    expect(toastMock.addToast).toHaveBeenCalledWith({ title: "Schedule paused" });
  });

  it("resume confirm stays disabled during a reopen's unresolved forced refetch", async () => {
    await renderSection([makeJob({ state: "paused", stateReason: "user_paused", nextRunAt: null })]);
    await click(document.querySelector("button[aria-expanded]"));

    // First open succeeds, then cancel.
    await click(buttonByLabel("Resume schedule Daily standup summary"));
    expect(document.body.textContent).toContain("First run:");
    await click(buttonByText("Cancel"));

    // Reopen while the forced refetch is still in flight: TanStack keeps the
    // old success data, but confirmation must wait for THIS open's fetch.
    let resolveRefetch: ((value: CronPreviewResponse) => void) | null = null;
    cronApiMocks.previewChatCronJobs.mockImplementationOnce(
      () =>
        new Promise<CronPreviewResponse>((resolve) => {
          resolveRefetch = resolve;
        }),
    );
    await click(buttonByLabel("Resume schedule Daily standup summary"));

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Computing the first run…");
    expect(buttonByText("Resume schedule")?.disabled).toBe(true);

    await act(async () => resolveRefetch?.(previewResponse("2030-03-11T13:00:00.000Z")));
    await flush();
    expect(dialog?.textContent).toContain("First run:");
    expect(dialog?.textContent).toContain("Mar 11, 2030");
    expect(buttonByText("Resume schedule")?.disabled).toBe(false);
  });

  it("a failed refetch on reopen never falls back to the stale occurrence", async () => {
    await renderSection([makeJob({ state: "paused", stateReason: "user_paused", nextRunAt: null })]);
    await click(document.querySelector("button[aria-expanded]"));
    await click(buttonByLabel("Resume schedule Daily standup summary"));
    expect(document.body.textContent).toContain("First run:");
    await click(buttonByText("Cancel"));

    cronApiMocks.previewChatCronJobs.mockRejectedValueOnce(new ApiError(500, "refetch failed"));
    await click(buttonByLabel("Resume schedule Daily standup summary"));

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("could not be loaded");
    expect(dialog?.textContent).not.toContain("First run:");
    expect(buttonByText("Resume schedule")?.disabled).toBe(true);
  });

  it("resume preview uses the job's CURRENT schedule after a config change", async () => {
    await renderSection([makeJob({ state: "paused", stateReason: "user_paused", nextRunAt: null })]);
    await click(document.querySelector("button[aria-expanded]"));
    await click(buttonByLabel("Resume schedule Daily standup summary"));
    expect(cronApiMocks.previewChatCronJobs).toHaveBeenCalledWith("chat-1", {
      schedule: "0 9 * * 1-5",
      timezone: "America/New_York",
    });
    await click(buttonByText("Cancel"));

    // The owning agent edits the schedule; the next resume must confirm
    // against the new expression, not the cached old one.
    cronApiMocks.listChatCronJobs.mockResolvedValue({
      items: [
        makeJob({ state: "paused", stateReason: "user_paused", nextRunAt: null, schedule: "0 10 * * *", revision: 4 }),
      ],
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["chat-right-sidebar", "cron-jobs", "chat-1"] });
    });
    await flush();

    await click(buttonByLabel("Resume schedule Daily standup summary"));
    expect(cronApiMocks.previewChatCronJobs).toHaveBeenCalledWith("chat-1", {
      schedule: "0 10 * * *",
      timezone: "America/New_York",
    });
    await click(buttonByText("Resume schedule"));
    expect(cronApiMocks.patchCronJob).toHaveBeenCalledWith("job-1", { state: "active" }, 4);
  });
  it("resume dialog fetches a FRESH preview even when the expanded cache is warm", async () => {
    // Expanded detail fills the shared preview cache with occurrences A…
    cronApiMocks.previewChatCronJobs.mockResolvedValueOnce(previewResponse("2020-01-05T14:00:00.000Z"));
    await renderSection([makeJob({ state: "paused", stateReason: "user_paused", nextRunAt: null })]);
    await click(document.querySelector("button[aria-expanded]"));
    expect(document.body.textContent).toContain("2020-01-05T14:00:00.000Z");

    // …but the resume dialog must re-ask the Server and show occurrences B.
    cronApiMocks.previewChatCronJobs.mockResolvedValueOnce(previewResponse("2030-02-10T14:00:00.000Z"));
    await click(buttonByLabel("Resume schedule Daily standup summary"));

    expect(cronApiMocks.previewChatCronJobs).toHaveBeenCalledTimes(2);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("First run:");
    expect(dialog?.textContent).toContain("Feb 10, 2030");
    expect(dialog?.textContent).not.toContain("2020");
    expect(dialog?.textContent).toContain("Occurrences missed while paused are not replayed");

    await click(buttonByText("Resume schedule"));
    expect(cronApiMocks.patchCronJob).toHaveBeenCalledWith("job-1", { state: "active" }, 3);
    expect(toastMock.addToast).toHaveBeenCalledWith({ title: "Schedule resumed" });
  });

  it("resume confirm stays disabled until the fresh preview succeeds", async () => {
    let resolvePreview: ((value: CronPreviewResponse) => void) | null = null;
    cronApiMocks.previewChatCronJobs.mockImplementation(
      () =>
        new Promise<CronPreviewResponse>((resolve) => {
          resolvePreview = resolve;
        }),
    );
    await renderSection([makeJob({ state: "paused", stateReason: "user_paused", nextRunAt: null })]);
    await click(document.querySelector("button[aria-expanded]"));
    await click(buttonByLabel("Resume schedule Daily standup summary"));

    const confirm = buttonByText("Resume schedule");
    expect(confirm?.disabled).toBe(true);
    expect(document.body.textContent).toContain("Computing the first run…");

    await act(async () => resolvePreview?.(previewResponse()));
    await flush();
    expect(buttonByText("Resume schedule")?.disabled).toBe(false);
    await click(buttonByText("Resume schedule"));
    expect(cronApiMocks.patchCronJob).toHaveBeenCalledWith("job-1", { state: "active" }, 3);
  });

  it("preview failure blocks resume behind an explicit retry — no resume anyway", async () => {
    await renderSection([makeJob({ state: "paused", stateReason: "user_paused", nextRunAt: null })]);
    await click(document.querySelector("button[aria-expanded]"));
    // The dialog's forced-fresh fetch is the one that fails (the expanded
    // detail's earlier fetch already succeeded via the default mock).
    cronApiMocks.previewChatCronJobs.mockRejectedValueOnce(new ApiError(500, "no preview"));
    await click(buttonByLabel("Resume schedule Daily standup summary"));

    expect(document.body.textContent).toContain("could not be loaded");
    expect(buttonByText("Resume schedule")?.disabled).toBe(true);

    // Retry recovers; only then does resume become available.
    cronApiMocks.previewChatCronJobs.mockResolvedValueOnce(previewResponse());
    await click(buttonByText("Retry"));
    expect(document.body.textContent).toContain("First run:");
    expect(buttonByText("Resume schedule")?.disabled).toBe(false);

    await click(buttonByText("Resume schedule"));
    expect(cronApiMocks.patchCronJob).toHaveBeenCalledWith("job-1", { state: "active" }, 3);
  });

  it("a stale revision (409 with machine code) refetches, closes the dialog, and explains", async () => {
    cronApiMocks.patchCronJob.mockRejectedValue(
      new ApiError(409, "Revision mismatch", undefined, "CRON_JOB_REVISION_MISMATCH"),
    );
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    await renderSection([makeJob({ state: "paused", stateReason: "user_paused", nextRunAt: null })]);
    await click(document.querySelector("button[aria-expanded]"));
    await click(buttonByLabel("Resume schedule Daily standup summary"));
    await click(buttonByText("Resume schedule"));

    expect(cronApiMocks.patchCronJob).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["chat-right-sidebar", "cron-jobs", "chat-1"] });
    expect(document.body.textContent).not.toContain('Resume "Daily standup summary"?');
    expect(toastMock.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Schedule changed elsewhere" }));
  });

  it("a 409 WITHOUT the revision machine code is a generic error, not a stale-state reset", async () => {
    cronApiMocks.patchCronJob.mockRejectedValue(new ApiError(409, "Some other conflict"));
    await renderSection([makeJob({ state: "paused", stateReason: "user_paused", nextRunAt: null })]);
    await click(document.querySelector("button[aria-expanded]"));
    await click(buttonByLabel("Resume schedule Daily standup summary"));
    await click(buttonByText("Resume schedule"));

    expect(toastMock.addToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't update the schedule" }));
    expect(toastMock.addToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Schedule changed elsewhere" }),
    );
    // Dialog stays open — no false "state changed" reset.
    expect(document.body.textContent).toContain('Resume "Daily standup summary"?');
  });

  it("delete dialog carries irreversibility and accepted-work wording, then deletes with revision", async () => {
    await renderSection([makeJob()]);
    await click(document.querySelector("button[aria-expanded]"));
    await click(buttonByLabel("Delete schedule Daily standup summary"));

    expect(document.body.textContent).toContain('Delete "Daily standup summary"?');
    expect(document.body.textContent).toContain("permanently removes the schedule's configuration");
    expect(document.body.textContent).toContain("cannot be restored");
    expect(document.body.textContent).toContain("is not cancelled");

    await click(buttonByText("Delete schedule"));
    expect(cronApiMocks.deleteCronJob).toHaveBeenCalledTimes(1);
    expect(cronApiMocks.deleteCronJob).toHaveBeenCalledWith("job-1", 3);
    expect(toastMock.addToast).toHaveBeenCalledWith({ title: "Schedule deleted" });
  });

  it("prevents duplicate submissions while a mutation is in flight", async () => {
    let resolvePatch: ((job: CronJob) => void) | null = null;
    cronApiMocks.patchCronJob.mockImplementation(
      () =>
        new Promise<CronJob>((resolve) => {
          resolvePatch = resolve;
        }),
    );
    await renderSection([makeJob()]);
    await click(document.querySelector("button[aria-expanded]"));

    const pauseButton = buttonByLabel("Pause schedule Daily standup summary");
    await click(pauseButton);
    expect(cronApiMocks.patchCronJob).toHaveBeenCalledTimes(1);
    expect(buttonByLabel("Pause schedule Daily standup summary")?.disabled).toBe(true);

    await act(async () => resolvePatch?.(makeJob({ state: "paused" })));
    await flush();
    expect(cronApiMocks.patchCronJob).toHaveBeenCalledTimes(1);
  });
});

describe("SchedulesSection chat switching", () => {
  it("resets expansion state when the section is remounted for another chat", async () => {
    await renderSection([makeJob()]);
    await click(document.querySelector("button[aria-expanded]"));
    expect(document.body.textContent).toContain("Upcoming runs");

    // Simulate ChatRightSidebar's key-based remount on chat switch.
    await act(async () => root?.unmount());
    cronApiMocks.listChatCronJobs.mockResolvedValue({ items: [makeJob({ controlChatId: "chat-2" })] });
    const { SchedulesSection } = await import("../right-sidebar/schedules-section.js");
    await renderDom(<SchedulesSection key="schedules:chat-2" chatId="chat-2" participants={[TARGET_AGENT]} />);

    expect(document.body.textContent).not.toContain("Upcoming runs");
    expect(cronApiMocks.patchCronJob).not.toHaveBeenCalled();
    expect(cronApiMocks.deleteCronJob).not.toHaveBeenCalled();
  });
});

describe("SchedulesSection time freshness", () => {
  // Fake-timer-aware render/click/flush: the shared helpers wait on a real
  // setTimeout(0), which never fires once timers are faked.
  async function flushFake(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  async function renderFake(jobs: CronJob[]): Promise<void> {
    cronApiMocks.listChatCronJobs.mockResolvedValue({ items: jobs });
    const { SchedulesSection } = await import("../right-sidebar/schedules-section.js");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <SchedulesSection chatId="chat-1" participants={[OWNER_PARTICIPANT, TARGET_AGENT]} />
        </QueryClientProvider>,
      );
    });
    await flushFake(1);
  }

  async function clickFake(el: Element | null | undefined): Promise<void> {
    if (!el) throw new Error("Expected element to click");
    await act(async () => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flushFake(1);
  }

  it("relative next-run label keeps advancing while a row stays mounted", async () => {
    vi.useFakeTimers();
    try {
      const nextRunAt = new Date(Date.now() + 120_000).toISOString();
      await renderFake([makeJob({ nextRunAt })]);

      expect(document.body.textContent).toContain("in 2 minutes");

      // Structurally identical poll data cannot re-render by itself; the
      // explicit clock must advance the label past the 60s poll. (The last
      // tick at t=90s leaves 30s remaining, which rounds to one minute.)
      await flushFake(95_000);
      expect(document.body.textContent).toContain("in 1 minute");
      expect(document.body.textContent).not.toContain("in 2 minutes");
    } finally {
      vi.useRealTimers();
    }
  });

  it("expanded preview refetches on the interval so occurrences stay future", async () => {
    vi.useFakeTimers();
    try {
      cronApiMocks.previewChatCronJobs.mockResolvedValueOnce(previewResponse("2030-01-05T14:00:00.000Z"));
      await renderFake([makeJob()]);
      await clickFake(document.querySelector("button[aria-expanded]"));

      expect(cronApiMocks.previewChatCronJobs).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain("2030-01-05T14:00:00.000Z");

      cronApiMocks.previewChatCronJobs.mockResolvedValueOnce(previewResponse("2030-02-11T14:00:00.000Z"));
      await flushFake(60_000);

      expect(cronApiMocks.previewChatCronJobs).toHaveBeenCalledTimes(2);
      expect(document.body.textContent).toContain("2030-02-11T14:00:00.000Z");
      // The row never collapsed/reopened to get there.
      expect(document.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("schedules-section helpers", () => {
  it("formats future relative times without leaking browser-timezone absolutes", async () => {
    const { formatFutureRelative } = await import("../right-sidebar/schedules-section.js");
    const now = new Date("2030-01-01T00:00:00.000Z").getTime();
    expect(formatFutureRelative("2030-01-01T00:00:20.000Z", now)).toBe("in less than a minute");
    expect(formatFutureRelative("2030-01-01T00:05:00.000Z", now)).toBe("in 5 minutes");
    expect(formatFutureRelative("2030-01-01T03:00:00.000Z", now)).toBe("in 3 hours");
    expect(formatFutureRelative("2030-01-04T00:00:00.000Z", now)).toBe("in 3 days");
    expect(formatFutureRelative("2029-12-31T00:00:00.000Z", now)).toBe("due now");
    expect(formatFutureRelative("not-a-date", now)).toBe("—");
  });

  it("formats absolute instants in the job timezone with a zone name", async () => {
    const { formatAbsoluteInZone } = await import("../right-sidebar/schedules-section.js");
    const ny = formatAbsoluteInZone("2030-01-05T14:00:00.000Z", "America/New_York");
    expect(ny).toContain("9:00");
    expect(ny).toContain("EST");
    const shanghai = formatAbsoluteInZone("2030-01-05T14:00:00.000Z", "Asia/Shanghai");
    expect(shanghai).toContain("10:00");
    expect(formatAbsoluteInZone("2030-01-05T14:00:00.000Z", "Not/AZone")).toBe("2030-01-05T14:00:00.000Z");
    expect(formatAbsoluteInZone("bad", "America/New_York")).toBe("—");
  });

  it("maps pause reasons and counts active jobs", async () => {
    const { activeJobCount, pauseReasonLabel } = await import("../right-sidebar/schedules-section.js");
    expect(pauseReasonLabel("user_paused")).toBe("Paused by owner");
    expect(pauseReasonLabel("agent_manager_changed")).toContain("manager changed");
    expect(pauseReasonLabel("some_future_reason")).toBe("Paused — some_future_reason");
    expect(pauseReasonLabel(null)).toBe("Paused");
    expect(activeJobCount([makeJob(), makeJob({ id: "j2", state: "paused" })])).toBe(1);
  });
});
