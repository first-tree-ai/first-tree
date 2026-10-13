import { OPENTAG_ENTRY_PATH } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { RouteTracker } from "./analytics.js";
import { AuthProvider } from "./auth/auth-context.js";
import { RequireAuth } from "./auth/require-auth.js";
import { Layout } from "./components/layout.js";
import { Button } from "./components/ui/button.js";
import { ToastProvider } from "./components/ui/toast.js";
import { PulseProvider } from "./hooks/pulse-context.js";
import { useMobileExperienceState } from "./hooks/use-mobile-experience.js";
import { useContextTreeSetupPreviewBootstrapState } from "./hooks/use-server-channel.js";
import { ChannelsTab } from "./pages/agent-detail/channels-tab.js";
import { ProfileTab } from "./pages/agent-detail/profile-tab.js";
import { PromptTab } from "./pages/agent-detail/prompt-tab.js";
import { RepositoriesTab } from "./pages/agent-detail/repositories-tab.js";
import { ResourcesTab } from "./pages/agent-detail/resources-tab.js";
import { RuntimeTab } from "./pages/agent-detail/runtime-tab.js";
import { UsageTab } from "./pages/agent-detail/usage-tab.js";
import { AgentDetailPage } from "./pages/agent-detail.js";
import { ContextPage } from "./pages/context.js";
import { DocPage } from "./pages/docs/doc-page.js";
import { DocsListPage } from "./pages/docs/docs-list-page.js";
import { InviteAcceptPage } from "./pages/invite-accept.js";
import { LoginPage } from "./pages/login.js";
import { MobileInstallPage } from "./pages/mobile/install.js";
import { MobileMePage } from "./pages/mobile/me.js";
import { MobileShell } from "./pages/mobile/shell.js";
import { MobileStandaloneOpenTracker } from "./pages/mobile/standalone-open-tracker.js";
import { MobileTeamPage } from "./pages/mobile/team.js";
import { MobileWorkPage } from "./pages/mobile/work.js";
import { OAuthCompletePage } from "./pages/oauth-complete.js";
import { GithubConnectedPage } from "./pages/onboarding/github-connected.js";
import { OnboardingPage } from "./pages/onboarding/onboarding-page.js";
import { OpenTagPage } from "./pages/opentag/opentag-page.js";
import { QuickstartPage } from "./pages/quickstart/quickstart-page.js";
import { SettingsAccountPage } from "./pages/settings/account.js";
import { SettingsComputersPage } from "./pages/settings/computers.js";
import { SettingsContextTreePage } from "./pages/settings/context-tree.js";
import { SettingsGithubPage } from "./pages/settings/github.js";
import { SettingsGitlabPage } from "./pages/settings/gitlab.js";
import { SettingsIntegrationsLayout } from "./pages/settings/integrations.js";
import { SettingsRepositoriesPage } from "./pages/settings/repositories.js";
import { SettingsResourcesPage } from "./pages/settings/resources.js";
import { SettingsSetupPage } from "./pages/settings/setup.js";
import { SettingsLayout } from "./pages/settings.js";
import { TeamPage } from "./pages/team/index.js";
import { TemplateDetailPage } from "./pages/templates/template-detail-page.js";
import { TemplateLibraryPage } from "./pages/templates/template-library-page.js";
import { WorkspacePage } from "./pages/workspace/index.js";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

const ContextPreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/context-preview.js").then((module) => ({ default: module.ContextPreviewPage })))
  : null;

const ContextTreePreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/context-tree-preview.js").then((module) => ({ default: module.ContextTreePreviewPage })))
  : null;

const ChatRowAvatarPreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/chat-row-avatar-preview.js").then((module) => ({ default: module.ChatRowAvatarPreviewPage })),
    )
  : null;

const ConversationListPreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/conversation-list-preview.js").then((module) => ({
        default: module.ConversationListPreviewPage,
      })),
    )
  : null;

const ComposeStatusBarPreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/compose-status-bar-preview.js").then((module) => ({
        default: module.ComposeStatusBarPreviewPage,
      })),
    )
  : null;

const ChatOfflineNoticePreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/chat-offline-notice-preview.js").then((module) => ({
        default: module.ChatOfflineNoticePreviewPage,
      })),
    )
  : null;

const RequestDockPreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/request-dock-preview.js").then((module) => ({
        default: module.RequestDockPreviewPage,
      })),
    )
  : null;

const OnboardingPreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/onboarding-preview.js").then((module) => ({ default: module.OnboardingPreviewPage })))
  : null;

const OpenTagOnboardingPreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/opentag-onboarding-preview.js").then((module) => ({
        default: module.OpenTagOnboardingPreviewPage,
      })),
    )
  : null;

const OnboardingOrientationPreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/onboarding-orientation-preview.js").then((module) => ({
        default: module.OnboardingOrientationPreviewPage,
      })),
    )
  : null;

const OnboardingOrientationVideoPreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/onboarding-orientation-video-preview.js").then((module) => ({
        default: module.OnboardingOrientationVideoPreviewPage,
      })),
    )
  : null;

const TeamPreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/team-preview.js").then((module) => ({ default: module.TeamPreviewPage })))
  : null;

const ResourcesPreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/resources-preview.js").then((module) => ({ default: module.ResourcesPreviewPage })))
  : null;

const AgentDetailPreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/agent-detail-preview.js").then((module) => ({ default: module.AgentDetailPreviewPage })))
  : null;

const CommandPalettePreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/command-palette-preview.js").then((module) => ({ default: module.CommandPalettePreviewPage })),
    )
  : null;

const UserMenuPreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/user-menu-preview.js").then((module) => ({ default: module.UserMenuPreviewPage })))
  : null;

const SupportMenuPreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/support-menu-preview.js").then((module) => ({ default: module.SupportMenuPreviewPage })))
  : null;

const ChatSummaryPreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/chat-summary-preview.js").then((module) => ({ default: module.ChatSummaryPreviewPage })))
  : null;

const MobilePreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/mobile-preview.js").then((module) => ({ default: module.MobilePreviewPage })))
  : null;

const InstallGuidePreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/install-guide-preview.js").then((module) => ({ default: module.InstallGuidePreviewPage })),
    )
  : null;

const TeamSwitcherPreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/team-switcher-preview.js").then((module) => ({ default: module.TeamSwitcherPreviewPage })),
    )
  : null;

const SettingsGithubPreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/settings-github-preview.js").then((module) => ({ default: module.SettingsGithubPreviewPage })),
    )
  : null;

const SetupPreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/setup-preview.js").then((module) => ({ default: module.SetupPreviewPage })))
  : null;

const SettingsContextTreePreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/settings-context-tree-preview.js").then((module) => ({
        default: module.SettingsContextTreePreviewPage,
      })),
    )
  : null;

// Public fixture preview for the BYO Context Tree handoff. It is compiled into
// hosted builds so staging can expose it, but the route gate below fails closed
// on production and unknown channels. It has no auth or backend mutations.
const ContextTreeSetupPreviewPage = lazy(() =>
  import("./pages/context-tree-setup-preview.js").then((module) => ({
    default: module.ContextTreeSetupPreviewPage,
  })),
);

// Living design-system reference (companion to DESIGN.md). Unlike the previews
// above this ships in prod too, so it can be opened on a deployed URL — it has
// no auth-gated data, only tokens and `components/ui` primitives.
const StyleguidePreviewPage = lazy(() =>
  import("./pages/styleguide-preview.js").then((module) => ({ default: module.StyleguidePreviewPage })),
);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          {/* Keep URL-backed user navigation from being starved by continuous live runtime updates. */}
          <BrowserRouter unstable_useTransitions={false}>
            <MobileExperienceHead />
            <MobileStandaloneOpenTracker />
            <RouteTracker />
            <Routes>
              {/* Public routes — no auth required */}
              <Route path="/login" element={<LoginPage />} />
              {/* /signup retired — Continue with GitHub on /login covers signup. */}
              <Route path="/signup" element={<Navigate to="/login" replace />} />
              <Route path="/auth/github/complete" element={<OAuthCompletePage />} />
              <Route path="/auth/complete" element={<OAuthCompletePage />} />
              {/* Public: the connect-code install popup lands here to auto-close. */}
              <Route path="/onboarding/connected" element={<GithubConnectedPage />} />
              <Route path="/invite/:token" element={<InviteAcceptPage />} />
              {/* Public official Template Library + detail. `/templates/:slug?use=1`
                  is the canonical use-intent URL; the detail page itself routes
                  logged-out visitors through /login and signed-in members into
                  onboarding or an explicit Team choice. */}
              <Route path="/templates" element={<TemplateLibraryPage />} />
              <Route path="/templates/:slug" element={<TemplateDetailPage />} />
              <Route path="/m/install" element={<MobileInstallRoute />} />
              <Route path="/preview/context-tree-setup" element={<ContextTreeSetupPreviewRoute />} />
              {ContextPreviewPage ? (
                <Route
                  path="/preview/context"
                  element={
                    <Suspense fallback={null}>
                      <ContextPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {ContextTreePreviewPage ? (
                <Route
                  path="/preview/context-tree/*"
                  element={
                    <Suspense fallback={null}>
                      <ContextTreePreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {ChatRowAvatarPreviewPage ? (
                <Route
                  path="/preview/chat-row-avatar"
                  element={
                    <Suspense fallback={null}>
                      <ChatRowAvatarPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {ConversationListPreviewPage ? (
                <Route
                  path="/preview/conversation-list"
                  element={
                    <Suspense fallback={null}>
                      <ConversationListPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {ComposeStatusBarPreviewPage ? (
                <Route
                  path="/preview/compose-status-bar"
                  element={
                    <Suspense fallback={null}>
                      <ComposeStatusBarPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {ChatOfflineNoticePreviewPage ? (
                <Route
                  path="/preview/chat-offline-notice"
                  element={
                    <Suspense fallback={null}>
                      <ChatOfflineNoticePreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {RequestDockPreviewPage ? (
                <Route
                  path="/preview/request-dock"
                  element={
                    <Suspense fallback={null}>
                      <RequestDockPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {CommandPalettePreviewPage ? (
                <Route
                  path="/preview/command-palette"
                  element={
                    <Suspense fallback={null}>
                      <CommandPalettePreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {UserMenuPreviewPage ? (
                <Route
                  path="/preview/user-menu"
                  element={
                    <Suspense fallback={null}>
                      <UserMenuPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {SupportMenuPreviewPage ? (
                <Route
                  path="/preview/support-menu"
                  element={
                    <Suspense fallback={null}>
                      <SupportMenuPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {TeamSwitcherPreviewPage ? (
                <Route
                  path="/preview/team-switcher"
                  element={
                    <Suspense fallback={null}>
                      <TeamSwitcherPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {ChatSummaryPreviewPage ? (
                <Route
                  path="/preview/chat-summary"
                  element={
                    <Suspense fallback={null}>
                      <ChatSummaryPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {MobilePreviewPage ? (
                <Route
                  path="/preview/mobile"
                  element={
                    <Suspense fallback={null}>
                      <MobilePreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {InstallGuidePreviewPage ? (
                <Route
                  path="/preview/install-guide"
                  element={
                    <Suspense fallback={null}>
                      <InstallGuidePreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {SettingsGithubPreviewPage ? (
                <Route
                  path="/preview/settings-github"
                  element={
                    <Suspense fallback={null}>
                      <SettingsGithubPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {SetupPreviewPage ? (
                <Route
                  path="/preview/setup"
                  element={
                    <Suspense fallback={null}>
                      <SetupPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {SettingsContextTreePreviewPage ? (
                <Route
                  path="/preview/settings-context-tree"
                  element={
                    <Suspense fallback={null}>
                      <SettingsContextTreePreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {OnboardingPreviewPage ? (
                <Route
                  path="/preview/onboarding"
                  element={
                    <Suspense fallback={null}>
                      <OnboardingPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {OpenTagOnboardingPreviewPage ? (
                <Route
                  path="/preview/opentag-onboarding"
                  element={
                    <Suspense fallback={null}>
                      <OpenTagOnboardingPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {OnboardingOrientationPreviewPage ? (
                <Route
                  path="/preview/onboarding-orientation"
                  element={
                    <Suspense fallback={null}>
                      <OnboardingOrientationPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {OnboardingOrientationVideoPreviewPage ? (
                <Route
                  path="/preview/onboarding-orientation-video"
                  element={
                    <Suspense fallback={null}>
                      <OnboardingOrientationVideoPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {TeamPreviewPage ? (
                <Route
                  path="/preview/team"
                  element={
                    <Suspense fallback={null}>
                      <TeamPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {ResourcesPreviewPage ? (
                <Route
                  path="/preview/resources"
                  element={
                    <Suspense fallback={null}>
                      <ResourcesPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {AgentDetailPreviewPage ? (
                <Route
                  path="/preview/agent-detail/*"
                  element={
                    <Suspense fallback={null}>
                      <AgentDetailPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              <Route
                path="/preview/styleguide"
                element={
                  <Suspense fallback={null}>
                    <StyleguidePreviewPage />
                  </Suspense>
                }
              />
              {/* Auth-required pages. Onboarding is a standalone full-screen
                /onboarding route (below); the workspace root redirects users
                who haven't finished setup into it. */}
              <Route element={<RequireAuth />}>
                {/* Standalone onboarding — full-screen, outside the workspace
                    chrome. The workspace root redirects incomplete users
                    here; this route redirects back once setup is complete. */}
                <Route path="/onboarding" element={<OnboardingPage />} />
                {/* OpenTag entry — its own full-screen guided handoff, outside
                    the workspace chrome and outside the `/onboarding` gate.
                    A logged-out visit takes the ordinary deep-link route
                    (/login -> OAuth with `next`), and the server preserves
                    this exact destination through solo signup. */}
                <Route path={OPENTAG_ENTRY_PATH} element={<OpenTagPage />} />
                <Route element={<MobileExperienceGate />}>
                  <Route path="m" element={<Navigate to="/m/chat" replace />} />
                  <Route path="m/chat" element={<MobileWorkPage />} />
                  <Route path="m/team" element={<MobileTeamPage />} />
                  <Route path="m/me" element={<MobileMePage />} />
                  <Route path="m/*" element={<Navigate to="/m/chat" replace />} />
                </Route>
                <Route
                  element={
                    <PulseProvider>
                      <Layout />
                    </PulseProvider>
                  }
                >
                  <Route index element={<WorkspaceEntry />} />
                  {/* Growth quickstart (landing-campaign trial). Lives INSIDE
                      the Layout group so the trial chat renders with full
                      workspace chrome — but as its own route, NOT the gated
                      index, so an un-onboarded trial user is not bounced to
                      /onboarding. It owns its own campaign completion semantics
                      and never writes onboarding stamps. */}
                  <Route path="quickstart" element={<QuickstartPage />} />
                  <Route path="context" element={<ContextPage />} />
                  <Route path="context/docs" element={<DocsListPage />} />
                  <Route path="context/docs/:slug" element={<DocPage />} />
                  <Route path="agents/:uuid" element={<AgentDetailPage />}>
                    <Route index element={<Navigate to="profile" replace />} />
                    <Route path="profile" element={<ProfileTab />} />
                    <Route path="channels" element={<ChannelsTab />} />
                    <Route path="responsibilities" element={<Navigate to="../profile" replace />} />
                    <Route path="runtime" element={<RuntimeTab />} />
                    <Route path="prompt" element={<PromptTab />} />
                    <Route path="capabilities" element={<ResourcesTab />} />
                    <Route path="repositories" element={<RepositoriesTab />} />
                    <Route path="usage" element={<UsageTab />} />
                  </Route>

                  {/* Team — flat roster page, no sub-nav. Org-scoped admin
                      configuration (team profile / context tree / resources)
                      lives under /settings, not as a peer of the
                      people-and-agents view. */}
                  <Route path="team" element={<TeamPage />} />

                  {/* Settings master-detail. Setup is the permanent role-aware
                      overview; /onboarding remains the standalone first-run flow. */}
                  <Route path="settings" element={<SettingsLayout />}>
                    <Route index element={<Navigate to="account" replace />} />
                    <Route path="account" element={<SettingsAccountPage />} />
                    <Route path="repositories" element={<SettingsRepositoriesPage />} />
                    <Route path="context" element={<SettingsContextTreePage />} />
                    <Route path="resources" element={<SettingsResourcesPage />} />
                    <Route path="computers" element={<SettingsComputersPage />} />
                    <Route path="integrations" element={<SettingsIntegrationsLayout />}>
                      <Route index element={<Navigate to="github" replace />} />
                      <Route path="github" element={<SettingsGithubPage />} />
                      <Route path="gitlab" element={<SettingsGitlabPage />} />
                    </Route>
                    <Route path="setup" element={<SettingsSetupPage />} />
                  </Route>
                </Route>
              </Route>
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

function ContextTreeSetupPreviewRoute() {
  const { channel, commandTemplate, settled } = useContextTreeSetupPreviewBootstrapState();
  if (!settled) return null;
  if (!import.meta.env.DEV && channel !== "staging") return <Navigate to="/" replace />;
  if (!commandTemplate) return <ContextTreeSetupPreviewUnavailable />;
  return (
    <Suspense fallback={null}>
      <ContextTreeSetupPreviewPage bootstrapCommandTemplate={commandTemplate} />
    </Suspense>
  );
}

function ContextTreeSetupPreviewUnavailable() {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
      <section className="w-full max-w-lg rounded-[var(--radius-panel)] border border-border bg-card p-6 text-center sm:p-8">
        <p className="text-label font-semibold uppercase tracking-wide text-fg-3">Context Tree setup preview</p>
        <h1 className="mt-2 text-title font-semibold">Preview unavailable</h1>
        <p className="mx-auto mt-3 max-w-md text-body text-fg-2">
          This deployment has not published its setup command yet. Reload after the staging update completes.
        </p>
        <Button type="button" className="mt-5" onClick={() => window.location.reload()}>
          Reload preview
        </Button>
      </section>
    </main>
  );
}

function WorkspaceEntry() {
  const location = useLocation();
  const mobileExperience = useMobileExperienceState();
  if (!mobileExperience.settled) return null;
  if (mobileExperience.enabled && shouldOpenMobileRoot(location)) {
    return <Navigate to="/m/chat" replace />;
  }
  return <WorkspacePage />;
}

function shouldOpenMobileRoot(location: ReturnType<typeof useLocation>): boolean {
  if (location.pathname !== "/" || location.search || location.hash) return false;
  if (typeof window === "undefined") return false;

  const mediaQuery = window.matchMedia?.("(max-width: 47.999rem)");
  if (mediaQuery) return mediaQuery.matches;

  return window.innerWidth > 0 && window.innerWidth < 768;
}

function MobileExperienceGate() {
  const mobileExperience = useMobileExperienceState();
  if (!mobileExperience.settled) return null;
  if (!mobileExperience.enabled) return <Navigate to="/" replace />;

  return (
    <PulseProvider>
      <MobileShell />
    </PulseProvider>
  );
}

function MobileInstallRoute() {
  const mobileExperience = useMobileExperienceState();
  if (!mobileExperience.settled) return null;
  if (!mobileExperience.enabled) return <Navigate to="/" replace />;
  return <MobileInstallPage />;
}

function MobileExperienceHead() {
  const { enabled } = useMobileExperienceState();

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;

    const elements = [
      createHeadElement("link", { rel: "manifest", href: "/manifest.webmanifest" }),
      createHeadElement("link", { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" }),
      createHeadElement("meta", { name: "mobile-web-app-capable", content: "yes" }),
      createHeadElement("meta", { name: "apple-mobile-web-app-capable", content: "yes" }),
      createHeadElement("meta", { name: "apple-mobile-web-app-title", content: "First Tree" }),
      createHeadElement("meta", { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" }),
    ];

    for (const element of elements) {
      document.head.appendChild(element);
    }

    return () => {
      for (const element of elements) {
        element.remove();
      }
    };
  }, [enabled]);

  return null;
}

function createHeadElement(tagName: "link" | "meta", attributes: Record<string, string>): HTMLElement {
  const element = document.createElement(tagName);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  element.dataset.mobileExperience = "true";
  return element;
}
