import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  authSession,
  claimHook,
  createHook,
  exchangeHandoff,
  githubSignInUrl,
  websocketUrl,
} from "./api";
import {
  formatBytes,
  formatExactTimestamp,
  formatExpiry,
  formatOffsetTimestamp,
  formatRelativeTimestamp,
  formatUtcOffset,
  localUtcOffsetHours,
  handoffCapabilityFromHash,
  interactionMatches,
  mergeInteraction,
  prettyBody,
  viewCapabilityFromPath,
} from "./model";
import {
  loadOwnerProvision,
  saveOwnerProvision,
} from "./session";
import type {
  ExposureSummary,
  HookProvision,
  Interaction,
  StreamFrame,
} from "./types";

type ConnectionState = "idle" | "connecting" | "live" | "disconnected" | "error";
type InspectorTab = "body" | "query" | "headers" | "metadata";
type Theme = "light" | "dark";
type TimeZoneMode = "local" | `offset:${number}`;

function initialTheme(): Theme {
  const stored = window.localStorage.getItem("hooktry-theme");
  if (stored === "light" || stored === "dark") return stored;
  return "light";
}

function initialTimeZoneMode(): TimeZoneMode {
  const stored = window.localStorage.getItem("hooktry-time-zone");
  if (stored === "local" || stored?.startsWith("offset:")) {
    return stored as TimeZoneMode;
  }
  return "local";
}

const UTC_OFFSET_OPTIONS = Array.from(
  { length: 27 },
  (_, index) => index - 12,
).filter((offset) => offset !== 0);

function timeZoneModeLabel(mode: TimeZoneMode): string {
  if (mode === "local") {
    return `Local (${formatUtcOffset(localUtcOffsetHours())})`;
  }
  return formatUtcOffset(Number.parseFloat(mode.slice("offset:".length)));
}

function comparisonTimestamp(unixMs: number, mode: TimeZoneMode): string {
  if (mode === "local") return formatExactTimestamp(unixMs, "local");
  return formatOffsetTimestamp(
    unixMs,
    Number.parseFloat(mode.slice("offset:".length)),
  );
}


function exactTimeParts(
  unixMs: number,
  mode: TimeZoneMode | "utc",
): { date: string; time: string; zone: string } {
  const isUtc = mode === "utc";
  const offsetHours =
    typeof mode === "string" && mode.startsWith("offset:")
      ? Number.parseFloat(mode.slice("offset:".length))
      : null;
  const shiftedMs =
    offsetHours == null ? unixMs : unixMs + offsetHours * 3_600_000;
  const date = new Date(shiftedMs);
  const timeZone =
    isUtc || offsetHours != null ? "UTC" : undefined;

  const dateText = new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(date);

  const timeText = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false,
    timeZone,
  }).format(date);

  const zone =
    isUtc
      ? "UTC"
      : offsetHours != null
        ? formatUtcOffset(offsetHours)
        : new Intl.DateTimeFormat(undefined, {
            timeZoneName: "short",
          })
            .formatToParts(new Date(unixMs))
            .find((part) => part.type === "timeZoneName")?.value ?? "";

  return { date: dateText, time: timeText, zone };
}

function isPreviewHost(): boolean {
  return /^pr-\d+-/.test(window.location.hostname);
}

export function App() {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  const [provision, setProvision] = useState<HookProvision | null>(() =>
    loadOwnerProvision(window.location.pathname),
  );
  const [summary, setSummary] = useState<ExposureSummary | null>(
    provision,
  );
  const [interactions, setInteractions] = useState<Interaction[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<InspectorTab>("body");
  const [creating, setCreating] = useState(false);
  const [newHookOpen, setNewHookOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [openingHandoff, setOpeningHandoff] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [interactionPaneWidth, setInteractionPaneWidth] = useState(360);
  const [theme, setTheme] = useState<Theme>(() => initialTheme());
  const [timeZoneMode, setTimeZoneMode] = useState<TimeZoneMode>(() =>
    initialTimeZoneMode(),
  );

  const viewCapability = viewCapabilityFromPath(pathname);
  const handoffCapability =
    pathname === "/open"
      ? handoffCapabilityFromHash(window.location.hash)
      : null;
  const viewing = Boolean(viewCapability || provision);
  const owner = Boolean(provision);
  const activeSummary = summary ?? provision;

  const viewWebSocketUrl = useMemo(() => {
    if (provision) return provision.view_websocket_url;
    if (!viewCapability) return null;
    return websocketUrl(window.location.href);
  }, [provision, viewCapability]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("hooktry-theme", theme);
    const themeColor = document.querySelector('meta[name="theme-color"]');
    themeColor?.setAttribute("content", theme === "dark" ? "#0d0f12" : "#f4f3f7");
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem("hooktry-time-zone", timeZoneMode);
  }, [timeZoneMode]);

  useEffect(() => {
    if (!newHookOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !creating) {
        setNewHookOpen(false);
        setError(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [newHookOpen, creating]);

  useEffect(() => {
    const onPopState = () => {
      const nextPath = window.location.pathname;
      setPathname(nextPath);
      const stored = loadOwnerProvision(nextPath);
      setProvision(stored);
      setSummary(stored);
      setInteractions([]);
      setSelectedId(null);
      setSearch("");
      setError(null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!handoffCapability) return;

    let cancelled = false;
    setOpeningHandoff(true);
    setError(null);

    void exchangeHandoff(handoffCapability)
      .then((ownerProvision) => {
        if (cancelled) return;

        saveOwnerProvision(ownerProvision);
        const viewPath = new URL(
          ownerProvision.view_url,
          window.location.href,
        ).pathname;
        window.history.replaceState({}, "", viewPath);
        setPathname(viewPath);
        setProvision(ownerProvision);
        setSummary(ownerProvision);
        setInteractions([]);
        setSelectedId(null);
        setSearch("");
        setTab("body");
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to open this Hook handoff.",
        );
      })
      .finally(() => {
        if (!cancelled) setOpeningHandoff(false);
      });

    return () => {
      cancelled = true;
    };
  }, [handoffCapability]);

  useEffect(() => {
    if (!viewWebSocketUrl) {
      setConnection("idle");
      return;
    }

    let stopped = false;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (stopped) return;

      setConnection("connecting");
      socket = new WebSocket(viewWebSocketUrl);

      socket.addEventListener("open", () => {
        if (!stopped) setConnection("live");
      });

      socket.addEventListener("message", (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as StreamFrame;
          if (frame.type === "ready") {
            setSummary(frame.exposure);
            return;
          }

          if (frame.type === "snapshot") {
            const next = frame.interactions
              .slice()
              .sort((a, b) => b.sequence - a.sequence);
            setInteractions(next);
            setSelectedId((current) => current ?? next[0]?.interaction_id ?? null);
            return;
          }

          if (frame.type === "interaction") {
            setInteractions((current) =>
              mergeInteraction(current, frame.interaction),
            );
            setSelectedId((current) => current ?? frame.interaction.interaction_id);
            setSummary((current) => {
              if (!current || frame.interaction.sequence <= current.request_count) {
                return current;
              }
              return {
                ...current,
                request_count: frame.interaction.sequence,
                retained_bytes:
                  current.retained_bytes + frame.interaction.body_bytes,
              };
            });
            return;
          }

          if (frame.type === "resync_required") {
            socket?.close(1012, "resync_required");
          }
        } catch {
          setError("Received an unreadable stream frame.");
        }
      });

      socket.addEventListener("close", () => {
        if (stopped) return;
        setConnection("disconnected");
        retry = setTimeout(connect, 1200);
      });

      socket.addEventListener("error", () => {
        if (!stopped) setConnection("error");
      });
    };

    connect();

    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close(1000, "viewer_changed");
    };
  }, [viewWebSocketUrl]);

  useEffect(() => {
    if (!provision || provision.claimed) return;

    const url = new URL(window.location.href);
    if (url.searchParams.get("claim") !== "1") return;

    url.searchParams.delete("claim");
    window.history.replaceState(
      {},
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
    void completeClaim(provision);
  }, [provision]);

  const filtered = useMemo(
    () => interactions.filter((interaction) => interactionMatches(interaction, search)),
    [interactions, search],
  );
  const selected =
    interactions.find((interaction) => interaction.interaction_id === selectedId) ??
    filtered[0] ??
    null;

  async function handleCreate() {
    setCreating(true);
    setError(null);

    try {
      const created = await createHook();
      saveOwnerProvision(created);
      const path = new URL(created.view_url, window.location.href).pathname;
      window.history.pushState({}, "", path);
      setPathname(path);
      setProvision(created);
      setSummary(created);
      setInteractions([]);
      setSelectedId(null);
      setSearch("");
      setTab("body");
      setNewHookOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create Hook.");
    } finally {
      setCreating(false);
    }
  }

  async function handleClaim() {
    if (!provision || provision.claimed || claiming) return;

    setClaiming(true);
    setError(null);

    try {
      const session = await authSession();
      if (!session.authenticated) {
        const returnTo = `${pathname}?claim=1`;
        window.location.assign(githubSignInUrl(returnTo));
        return;
      }

      await claimCurrent(provision);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to start claim flow.",
      );
    } finally {
      setClaiming(false);
    }
  }

  async function completeClaim(current: HookProvision) {
    if (claiming) return;

    setClaiming(true);
    setError(null);
    try {
      const session = await authSession();
      if (!session.authenticated) {
        throw new Error("GitHub sign-in did not create a Hooktry session.");
      }
      await claimCurrent(current);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Unable to claim Hook.",
      );
    } finally {
      setClaiming(false);
    }
  }

  async function claimCurrent(current: HookProvision) {
    const claimed = await claimHook(current.claim_url);
    const updated: HookProvision = {
      ...current,
      ...claimed,
    };
    saveOwnerProvision(updated);
    setProvision(updated);
    setSummary(claimed);
  }

  function handleNewHook() {
    setError(null);
    setNewHookOpen(true);
  }

  function closeNewHook() {
    if (creating) return;
    setNewHookOpen(false);
    setError(null);
  }

  async function copy(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((current) => (current === key ? null : current)), 1200);
    } catch {
      setError("Clipboard access was denied by the browser.");
    }
  }

  function startPaneResize(event: React.PointerEvent<HTMLDivElement>) {
    if (window.innerWidth <= 650) return;

    const startX = event.clientX;
    const startWidth = interactionPaneWidth;

    const onMove = (moveEvent: PointerEvent) => {
      const next = Math.min(560, Math.max(280, startWidth + moveEvent.clientX - startX));
      setInteractionPaneWidth(next);
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("resizing-pane");
    };

    document.body.classList.add("resizing-pane");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  return (
    <div className="app-shell">
      <Sidebar viewing={viewing} onNewHook={handleNewHook} theme={theme} />
      <main className="main">
        <Topbar
          theme={theme}
          onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        />

        {handoffCapability ? (
          <HandoffLanding opening={openingHandoff} error={error} />
        ) : !viewing ? (
          <Landing creating={creating} error={error} onCreate={handleCreate} />
        ) : (
          <section className={`workspace ${interactions.length === 0 ? "workspace-empty" : ""}`}>
            <HookHeader
              provision={provision}
              summary={activeSummary}
              viewUrl={provision?.view_url ?? `${window.location.origin}${pathname}`}
              copied={copied}
              claiming={claiming}
              onClaim={handleClaim}
              onCopy={copy}
              onNewHook={handleNewHook}
              nowMs={nowMs}
              connection={connection}
            />

            {error ? <div className="error-banner">{error}</div> : null}

            <div
              className="workspace-grid"
              style={{ gridTemplateColumns: `${interactionPaneWidth}px 1px minmax(0, 1fr)` }}
            >
              <InteractionList
                interactions={filtered}
                total={interactions.length}
                selectedId={selected?.interaction_id ?? null}
                search={search}
                onSearch={setSearch}
                onSelect={setSelectedId}
                nowMs={nowMs}
                timeZoneMode={timeZoneMode}
                onTimeZoneMode={setTimeZoneMode}
              />
              <div
                className="pane-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize interaction list"
                title="Drag to resize the interaction list"
                onPointerDown={startPaneResize}
              />
              <Inspector
                interaction={selected}
                tab={tab}
                onTab={setTab}
                copied={copied}
                onCopy={copy}
                timeZoneMode={timeZoneMode}
              />
            </div>
          </section>
        )}
      </main>

      {newHookOpen ? (
        <NewHookModal
          creating={creating}
          error={error}
          onClose={closeNewHook}
          onCreate={handleCreate}
        />
      ) : null}
    </div>
  );
}

function Sidebar({
  viewing,
  onNewHook,
  theme,
}: {
  viewing: boolean;
  onNewHook: () => void;
  theme: Theme;
}) {
  const buildSha = import.meta.env.VITE_BUILD_SHA || "dev";
  const buildPr = (import.meta.env.VITE_BUILD_PR as string | undefined)?.trim() || null;
  const shortBuildSha = buildSha === "dev" ? buildSha : buildSha.slice(0, 7);
  const buildHref =
    buildSha === "dev"
      ? null
      : `https://github.com/hooktry/hooktry/commit/${buildSha}`;
  const prHref = buildPr
    ? `https://github.com/hooktry/hooktry/pull/${buildPr}`
    : null;

  return (
    <aside className="sidebar">
      <div className="brand">
        <a className="brand-home" href="/" aria-label="Go to Hooktry home" title="Go to Hooktry home">
          <img
            className="brand-logo brand-lockup"
            src={
              theme === "dark"
                ? "/brand/hooktry-lockup-inverse.svg"
                : "/brand/hooktry-lockup-primary.svg"
            }
            alt="Hooktry"
          />
          <img
            className="brand-logo brand-mark-logo"
            src={
              theme === "dark"
                ? "/brand/hooktry-mark-inverse.svg"
                : "/brand/hooktry-mark-primary.svg"
            }
            alt=""
            aria-hidden="true"
          />
        </a>
      </div>

      <nav className="nav">
        <button className="nav-item active" type="button" title="Hooks">
          <span>Hooks</span>
          <kbd>H</kbd>
        </button>

        <div className="nav-section">Evidence</div>
        <span className="nav-tooltip-wrap" title="Recordings - coming soon">
          <button className="nav-item nav-item-pending" type="button" disabled>
            Recordings
          </button>
        </span>
        <span className="nav-tooltip-wrap" title="Replays - coming soon">
          <button className="nav-item nav-item-pending" type="button" disabled>
            Replays
          </button>
        </span>
        <span className="nav-tooltip-wrap" title="Contracts - coming soon">
          <button className="nav-item nav-item-pending" type="button" disabled>
            Contracts
          </button>
        </span>
        <span className="nav-tooltip-wrap" title="Scenarios - coming soon">
          <button className="nav-item nav-item-pending" type="button" disabled>
            Scenarios
          </button>
        </span>
      </nav>

      <div className="sidebar-footer">
        {viewing ? (
          <button className="button secondary full" type="button" onClick={onNewHook} title="Create a new ephemeral Hook">
            + New Hook
          </button>
        ) : null}

        <div className="build-meta">
          {buildHref ? (
            <a href={buildHref} target="_blank" rel="noreferrer" title={buildSha}>
              build {shortBuildSha}
            </a>
          ) : (
            <span>build {shortBuildSha}</span>
          )}
          {prHref ? (
            <>
              <span className="build-meta-sep">·</span>
              <a href={prHref} target="_blank" rel="noreferrer" title={`Open pull request #${buildPr}`}>
                PR #{buildPr}
              </a>
            </>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function Topbar({
  theme,
  onToggleTheme,
}: {
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const buildSha = import.meta.env.VITE_BUILD_SHA || "dev";
  const buildPr = (import.meta.env.VITE_BUILD_PR as string | undefined)?.trim() || null;
  const shortBuildSha = buildSha === "dev" ? buildSha : buildSha.slice(0, 7);
  const preview = isPreviewHost();
  const buildHref =
    buildSha === "dev"
      ? null
      : `https://github.com/hooktry/hooktry/commit/${buildSha}`;
  const prHref = buildPr
    ? `https://github.com/hooktry/hooktry/pull/${buildPr}`
    : null;

  return (
    <header className="topbar">
      <div className="breadcrumb">
        <span>Workspace</span>
        <span className="sep">/</span>
        <strong>Hooks</strong>
      </div>
      <div className="topbar-actions">
        {preview ? (
          <div className="preview-build-meta" aria-label="Preview build information">
            {prHref ? (
              <a href={prHref} target="_blank" rel="noreferrer">
                PR #{buildPr}
              </a>
            ) : null}
            {prHref ? <span>·</span> : null}
            {buildHref ? (
              <a href={buildHref} target="_blank" rel="noreferrer" title={buildSha}>
                {shortBuildSha}
              </a>
            ) : (
              <span>{shortBuildSha}</span>
            )}
          </div>
        ) : null}
        <button
          className="theme-toggle"
          type="button"
          onClick={onToggleTheme}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {theme === "dark" ? (
            <svg aria-hidden="true" viewBox="0 0 20 20" focusable="false">
              <circle cx="10" cy="10" r="3.25" />
              <path d="M10 2.25v1.5M10 16.25v1.5M2.25 10h1.5M16.25 10h1.5M4.52 4.52l1.06 1.06M14.42 14.42l1.06 1.06M15.48 4.52l-1.06 1.06M5.58 14.42l-1.06 1.06" />
            </svg>
          ) : (
            <svg aria-hidden="true" viewBox="0 0 20 20" focusable="false">
              <path d="M15.8 12.7A6.3 6.3 0 0 1 7.3 4.2 6.3 6.3 0 1 0 15.8 12.7Z" />
            </svg>
          )}
        </button>
      </div>
    </header>
  );
}

function HandoffLanding({
  opening,
  error,
}: {
  opening: boolean;
  error: string | null;
}) {
  return (
    <section className="landing">
      <div className="landing-card">
        <div className="eyebrow">OWNER HANDOFF</div>
        <h1>{opening ? "Opening your Hook…" : "Unable to open this Hook"}</h1>
        <p>
          {opening
            ? "Hooktry is exchanging a one-time owner handoff for this browser."
            : error ?? "This handoff may have expired or already been used."}
        </p>
        <div className="landing-footnote">
          Handoff links are single-use and do not grant webhook senders ownership.
        </div>
      </div>
    </section>
  );
}

function HookCreationContent({
  creating,
  error,
  context,
  onCreate,
  onCancel,
}: {
  creating: boolean;
  error: string | null;
  context: "root" | "existing-hook";
  onCreate: () => void;
  onCancel?: () => void;
}) {
  const isExistingHook = context === "existing-hook";

  return (
    <>
      <div className="creation-card-head">
        <span className="creation-card-title">{isExistingHook ? "New Hook" : "Webhook receiver"}</span>
        <span className="creation-mode"><span className="dot" /> Ephemeral</span>
      </div>

      <div className="creation-overview">
        <h1 id={isExistingHook ? "new-hook-title" : undefined}>
          {isExistingHook ? "A fresh endpoint." : "Catch every request."}
        </h1>
        <p>
          {isExistingHook
            ? "Create a new webhook receiver. Your current Hook stays open until it is ready."
            : "Create a webhook URL. Inspect requests live and share a read-only viewer."}
        </p>
        <div className="creation-features">
          <span><i /> Live capture</span>
          <span><i /> Read-only sharing</span>
          <span><i /> No account needed</span>
        </div>
      </div>

      <div className="creation-limits">
        <div className="creation-section-head">
          <strong>Included limits</strong>
          <span className="creation-plan">Free · anonymous</span>
        </div>
        <div className="policy-grid">
          <Policy value="5 days" label="Endpoint lifetime" detail="Claim to keep it" />
          <Policy value="100" label="Captured requests" detail="Per Hook" />
          <Policy value="5 MiB" label="Request body" detail="Per request" />
          <Policy value="50 MiB" label="Body retention" detail="Per Hook" />
        </div>
      </div>

      {error ? <div className="error-inline" role="alert">{error}</div> : null}

      <div className="creation-footer">
        <span className="creation-footer-note">{isExistingHook ? "A separate receiver" : "Free · no sign-up"}</span>
        <div className="creation-actions">
          {isExistingHook && onCancel ? (
            <button className="button secondary creation-action-button" type="button" onClick={onCancel} disabled={creating}>
              Cancel
            </button>
          ) : null}
          <button className="button primary creation-action-button creation-primary-button" type="button" onClick={onCreate} disabled={creating}>
            {creating ? "Creating…" : "Create Hook"}
            {!creating ? <span aria-hidden="true">↗</span> : null}
          </button>
        </div>
      </div>

      {!isExistingHook ? (
        <div className="landing-footnote">
          Share the viewer URL to give read-only access. Claim your Hook to keep it beyond its anonymous lifetime.
        </div>
      ) : null}
    </>
  );
}

function Landing({
  creating,
  error,
  onCreate,
}: {
  creating: boolean;
  error: string | null;
  onCreate: () => void;
}) {
  return (
    <section className="landing">
      <div className="landing-card creation-card">
        <HookCreationContent
          creating={creating}
          error={error}
          context="root"
          onCreate={onCreate}
        />
      </div>
    </section>
  );
}

function Policy({ value, label, detail }: { value: string; label: string; detail: string }) {
  return (
    <div className="policy">
      <div className="policy-description"><span className="policy-dot" /><span>{label}</span><small>{detail}</small></div>
      <strong>{value}</strong>
    </div>
  );
}

function HookHeader({
  provision,
  summary,
  viewUrl,
  copied,
  claiming,
  onClaim,
  onCopy,
  onNewHook,
  nowMs,
  connection,
}: {
  provision: HookProvision | null;
  summary: ExposureSummary | null;
  viewUrl: string;
  copied: string | null;
  claiming: boolean;
  onClaim: () => void;
  onCopy: (value: string, key: string) => void;
  onNewHook: () => void;
  nowMs: number;
  connection: ConnectionState;
}) {
  return (
    <div className="hook-header">
      <div className="hook-header-inner">
        <div className="hook-title-row">
          <div className="hook-identity">
            <div className="hook-kicker-row">
              <span className="hook-type-label">TYPE</span>
              <span className="hook-kind">
                {summary?.claimed ? "PERSISTENT HOOK" : "EPHEMERAL HOOK"}
              </span>
              <span className={`hook-status hook-status-${connection}`}>
                <span className="dot" />
                {connectionLabel(connection)}
              </span>
              {summary?.claimed ? (
                <span className="badge claimed-badge">claimed · persistent</span>
              ) : null}
            </div>

            {summary ? (
              <div className="hook-id-row">
                <span className="hook-id-label">HOOK ID</span>
                <code className="hook-id" aria-label={summary.exposure_id}>
                  <span className="hook-id-full" aria-hidden="true">
                    {summary.exposure_id}
                  </span>
                  <span className="hook-id-short" aria-hidden="true">
                    {shortId(summary.exposure_id)}
                  </span>
                </code>
                <button
                  className="icon-button hook-id-copy"
                  type="button"
                  aria-label="Copy Hook ID"
                  title="Copy Hook ID"
                  onClick={() => onCopy(summary.exposure_id, "exposure-id")}
                >
                  {copied === "exposure-id" ? (
                    <span className="icon-button-text">Copied</span>
                  ) : (
                    <svg aria-hidden="true" viewBox="0 0 20 20" focusable="false">
                      <rect x="7" y="7" width="9" height="9" rx="1.5" />
                      <path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-7A1.5 1.5 0 0 0 3 5.5v7A1.5 1.5 0 0 0 4.5 14H7" />
                    </svg>
                  )}
                </button>
                <button
                  className="button secondary new-hook-button inline-new-hook"
                  type="button"
                  title="Create a new ephemeral Hook"
                  onClick={onNewHook}
                >
                  <span className="new-hook-label-full">+ New Hook</span>
                  <span className="new-hook-label-short">+ New</span>
                </button>
              </div>
            ) : (
              <div className="hook-loading">Loading viewer…</div>
            )}
          </div>
        </div>

        {provision ? (
          <div className="public-ingress">
            <div className="capability-heading">PUBLIC INGRESS</div>
            <div className="url-box public-ingress-row">
              <code>{provision.hook_url}</code>
              <button
                className="copy-button"
                type="button"
                title="Copy Webhook URL"
                onClick={() => onCopy(provision.hook_url, "hook")}
              >
                {copied === "hook" ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        ) : null}

        <div className="viewer-capability">
          <div className="viewer-capability-head">
            <span className="viewer-capability-label">VIEWER URL</span>
            {!provision ? (
              <span
                className="viewer-capability-badge"
                title="This URL can view captured requests but cannot send, claim, or manage the Hook"
              >
                read-only
              </span>
            ) : null}
          </div>

          <div className="viewer-capability-row">
            <code>{viewUrl}</code>
            <button
              className="viewer-copy-button"
              type="button"
              title="Copy Viewer URL"
              onClick={() => onCopy(viewUrl, "view")}
            >
              {copied === "view" ? "Copied" : "Copy"}
            </button>
          </div>

          {!provision ? (
            <div className="viewer-capability-note">
              Hook and claim capabilities cannot be derived from this URL.
            </div>
          ) : null}
        </div>

        <div className="metrics">
          <Metric
            label="Requests"
            value={summary ? `${summary.request_count} / ${summary.request_limit}` : "—"}
          />
          <Metric
            label="Retained"
            value={summary ? `${formatBytes(summary.retained_bytes)} / ${formatBytes(summary.max_retained_bytes)}` : "—"}
          />
          <Metric
            label="Max body"
            value={summary ? formatBytes(summary.max_body_bytes) : "—"}
          />
          <Metric
            label="Expires"
            value={
              summary?.claimed
                ? "persistent"
                : formatExpiry(summary?.expires_at_unix_seconds, nowMs)
            }
            action={
              provision && !summary?.claimed ? (
                <button
                  className="button secondary compact claim-metric"
                  type="button"
                  title="Keep this Hook by claiming it into a workspace"
                  onClick={onClaim}
                  disabled={claiming}
                >
                  {claiming ? "Claiming…" : "Claim"}
                </button>
              ) : null
            }
          />

        <details className="mobile-hook-details">
          <summary>Details</summary>
          <div className="mobile-hook-details-content">
            <div className="mobile-detail-section">
              <div className="capability-heading">VIEWER URL</div>
              <div className="viewer-capability-row mobile-viewer-row">
                <code>{viewUrl}</code>
                <button
                  className="viewer-copy-button"
                  type="button"
                  title="Copy Viewer URL"
                  onClick={() => onCopy(viewUrl, "view")}
                >
                  {copied === "view" ? "Copied" : "Copy"}
                </button>
              </div>
              {!provision ? (
                <div className="viewer-capability-note">
                  Hook and claim capabilities cannot be derived from this URL.
                </div>
              ) : null}
            </div>

            <div className="mobile-metrics-list">
              <div className="mobile-metric-row">
                <span>Requests</span>
                <strong>{summary ? `${summary.request_count} / ${summary.request_limit}` : "—"}</strong>
              </div>
              <div className="mobile-metric-row">
                <span>Retained</span>
                <strong>
                  {summary
                    ? `${formatBytes(summary.retained_bytes)} / ${formatBytes(summary.max_retained_bytes)}`
                    : "—"}
                </strong>
              </div>
              <div className="mobile-metric-row">
                <span>Max body</span>
                <strong>{summary ? formatBytes(summary.max_body_bytes) : "—"}</strong>
              </div>
              <div className="mobile-metric-row">
                <span>Expires</span>
                <strong>
                  {summary?.claimed
                    ? "persistent"
                    : formatExpiry(summary?.expires_at_unix_seconds, nowMs)}
                </strong>
              </div>
            </div>

            {provision && !summary?.claimed ? (
              <button
                className="button secondary mobile-claim-button"
                type="button"
                title="Keep this Hook by claiming it into a workspace"
                onClick={onClaim}
                disabled={claiming}
              >
                {claiming ? "Claiming…" : "Claim Hook"}
              </button>
            ) : null}
          </div>
        </details>
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  action,
}: {
  label: string;
  value: string;
  action?: ReactNode;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <div className="metric-value">
        <strong>{value}</strong>
        {action}
      </div>
    </div>
  );
}

function InteractionList({
  interactions,
  total,
  selectedId,
  search,
  onSearch,
  onSelect,
  nowMs,
  timeZoneMode,
  onTimeZoneMode,
}: {
  interactions: Interaction[];
  total: number;
  selectedId: string | null;
  search: string;
  onSearch: (value: string) => void;
  onSelect: (id: string) => void;
  nowMs: number;
  timeZoneMode: TimeZoneMode;
  onTimeZoneMode: (mode: TimeZoneMode) => void;
}) {
  return (
    <section className={`panel interaction-panel ${total === 0 ? "interaction-panel-empty" : ""}`}>
      <div className="panel-header">
        <div>
          <strong>Interactions</strong>
          <span className="count">{total}</span>
        </div>
        <div className="panel-header-actions">
          <select
            className="time-zone-select"
            aria-label="Timestamp timezone"
            value={timeZoneMode}
            onChange={(event) => onTimeZoneMode(event.target.value as TimeZoneMode)}
          >
            <option value="local">{timeZoneModeLabel("local")}</option>
            <optgroup label="UTC offsets">
              {UTC_OFFSET_OPTIONS.map((offset) => (
                <option key={offset} value={`offset:${offset}`}>
                  {formatUtcOffset(offset)}
                </option>
              ))}
            </optgroup>
          </select>
          <span className="live-hint">live stream</span>
        </div>
      </div>
      <div className="search-row">
        <input
          aria-label="Filter interactions"
          placeholder="Filter method, path, header, body…"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
        />
      </div>
      <div className="interaction-list">
        {interactions.length === 0 ? (
          <div className="empty-list">
            <strong>{search ? "No matches" : "Waiting for a request"}</strong>
            <span>
              {search
                ? "Try another filter."
                : "Send an HTTP request to the public ingress URL."}
            </span>
          </div>
        ) : (
          interactions.map((interaction) => (
            <div
              key={interaction.interaction_id}
              role="button"
              tabIndex={0}
              className={`interaction-row ${selectedId === interaction.interaction_id ? "selected" : ""}`}
              onClick={() => onSelect(interaction.interaction_id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(interaction.interaction_id);
                }
              }}
            >
              <div className="interaction-main">
                <span className={`method method-${interaction.method.toLowerCase()}`}>
                  {interaction.method}
                </span>
                <span className="path">
                  {interaction.path}
                  {interaction.query ? <span className="query">?{interaction.query}</span> : null}
                </span>
                <RelativeInteractionTime
                  unixMs={interaction.received_at_unix_ms}
                  nowMs={nowMs}
                  timeZoneMode={timeZoneMode}
                />
              </div>
              <div className="interaction-meta">
                <span>#{interaction.sequence}</span>
                <span>{formatBytes(interaction.body_bytes)}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function RelativeInteractionTime({
  unixMs,
  nowMs,
  timeZoneMode,
}: {
  unixMs: number;
  nowMs: number;
  timeZoneMode: TimeZoneMode;
}) {
  const [open, setOpen] = useState(false);
  const comparisonTime = comparisonTimestamp(unixMs, timeZoneMode);
  const comparisonLabel = timeZoneModeLabel(timeZoneMode);
  const utcTime = formatExactTimestamp(unixMs, "utc");
  const comparisonParts = exactTimeParts(unixMs, timeZoneMode);
  const utcParts = exactTimeParts(unixMs, "utc");
  const comparisonZone =
    timeZoneMode === "local" ? comparisonParts.zone : "";
  const relative = formatRelativeTimestamp(unixMs, nowMs);

  return (
    <span
      className={`interaction-time-wrap ${open ? "open" : ""}`}
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        setOpen((current) => !current);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          setOpen((current) => !current);
        }
        if (event.key === "Escape") setOpen(false);
      }}
      onBlur={() => setOpen(false)}
      aria-label={`${relative}. ${comparisonLabel}: ${comparisonTime}. UTC: ${utcTime}`}
      title="Show exact timestamps"
    >
      <span className="interaction-time">{relative}</span>
      <span className="interaction-time-chevron" aria-hidden="true">⌄</span>
      <span className="time-popover" role="tooltip">
        <span className="time-popover-caret" aria-hidden="true" />
        <span className="time-row active">
          <strong>{timeZoneMode === "local" ? "LOCAL" : comparisonLabel}</strong>
          <span className="time-row-value">
            <span className="time-row-clock">
              <code>{comparisonParts.time}</code>
              {comparisonZone ? (
                <span className="time-row-zone">{comparisonZone}</span>
              ) : null}
            </span>
            <span className="time-row-date">{comparisonParts.date}</span>
          </span>
        </span>
        <span className="time-row">
          <strong>UTC</strong>
          <span className="time-row-value">
            <span className="time-row-clock">
              <code>{utcParts.time}</code>
            </span>
            <span className="time-row-date">{utcParts.date}</span>
          </span>
        </span>
      </span>
    </span>
  );
}

function Inspector({
  interaction,
  tab,
  onTab,
  copied,
  onCopy,
  timeZoneMode,
}: {
  interaction: Interaction | null;
  tab: InspectorTab;
  onTab: (tab: InspectorTab) => void;
  copied: string | null;
  onCopy: (value: string, key: string) => void;
  timeZoneMode: TimeZoneMode;
}) {
  if (!interaction) {
    return (
      <section className="panel inspector-panel empty-inspector inspector-empty">
        <div>
          <div className="eyebrow">INSPECTOR</div>
          <h2>No Interaction selected</h2>
          <p>The newest request will be selected automatically.</p>
        </div>
      </section>
    );
  }

  const body = prettyBody(interaction);
  const activeTab: InspectorTab = tab;
  const queryEntries = interaction.query
    ? Array.from(new URLSearchParams(interaction.query).entries())
    : [];
  const metadataEntries = [
    ["Interaction ID", interaction.interaction_id],
    ["Exposure ID", interaction.exposure_id],
    ["Sequence", String(interaction.sequence)],
    ["Received", comparisonTimestamp(interaction.received_at_unix_ms, timeZoneMode)],
    ["Body bytes", String(interaction.body_bytes)],
    ["Body encoding", interaction.body_encoding],
  ] as const;

  const copyTarget =
    activeTab === "body"
      ? { label: "body", value: body }
      : activeTab === "query"
        ? {
            label: "query",
            value: queryEntries.map(([name, value]) => `${name}=${value}`).join("\n"),
          }
        : activeTab === "headers"
          ? {
              label: "headers",
              value: interaction.headers.map(([name, value]) => `${name}: ${value}`).join("\n"),
            }
          : {
              label: "metadata",
              value: JSON.stringify(
                {
                  interaction_id: interaction.interaction_id,
                  exposure_id: interaction.exposure_id,
                  sequence: interaction.sequence,
                  received_at: new Date(interaction.received_at_unix_ms).toISOString(),
                  body_bytes: interaction.body_bytes,
                  body_encoding: interaction.body_encoding,
                },
                null,
                2,
              ),
            };

  return (
    <section className="panel inspector-panel inspector-panel-selected">
      <div className="inspector-head">
        <div>
          <div className="request-line">
            <span className={`method method-${interaction.method.toLowerCase()}`}>
              {interaction.method}
            </span>
            <span className="request-sequence" title={`Interaction #${interaction.sequence}`}>
              #{interaction.sequence}
            </span>
            <strong>{interaction.path}</strong>
            {interaction.query ? <span className="query">?{interaction.query}</span> : null}
          </div>
          <div className="interaction-id-row">
            <span className="interaction-id-label">INTERACTION ID</span>
            <code>{interaction.interaction_id}</code>
          </div>
        </div>
        <button
          className="button secondary compact inspector-copy-button"
          type="button"
          onClick={() => onCopy(copyTarget.value, copyTarget.label)}
          disabled={!copyTarget.value}
          title={copyTarget.value ? `Copy ${copyTarget.label}` : `No ${copyTarget.label} to copy`}
        >
          {copied === copyTarget.label ? "Copied" : `Copy ${copyTarget.label}`}
        </button>
      </div>

      <div className="tabs">
        <Tab active={activeTab === "body"} onClick={() => onTab("body")}>
          Body
        </Tab>
        <Tab active={activeTab === "query"} onClick={() => onTab("query")}>
          Query
        </Tab>
        <Tab active={activeTab === "headers"} onClick={() => onTab("headers")}>
          Headers <span className="tab-count">{interaction.headers.length}</span>
        </Tab>
        <Tab active={activeTab === "metadata"} onClick={() => onTab("metadata")}>
          Metadata <span className="tab-count">{metadataEntries.length}</span>
        </Tab>
      </div>

      <div className="inspector-content">
        {activeTab === "body" ? (
          body ? (
            <pre className="body-view" data-encoding={interaction.body_encoding}>
              {body}
            </pre>
          ) : (
            <div className="body-empty-state">
              <strong>No request body</strong>
              <span>0 bytes received</span>
            </div>
          )
        ) : null}

        {activeTab === "query" ? (
          queryEntries.length > 0 ? (
            <div className="kv-table">
              {queryEntries.map(([name, value], index) => (
                <div className="kv-row" key={`${name}-${index}`}>
                  <code>{name}</code>
                  <code>{value}</code>
                </div>
              ))}
            </div>
          ) : (
            <div className="body-empty-state">
              <strong>No query parameters</strong>
              <span>0 parameters received</span>
            </div>
          )
        ) : null}

        {activeTab === "headers" ? (
          <>
            <div className="inspector-note">
              Captured as received. Header sets vary by client and may include transport-added headers.
            </div>
            <div className="kv-table">
              {interaction.headers.map(([name, value], index) => (
              <div className="kv-row" key={`${name}-${index}`}>
                <code>{name}</code>
                <code>{value}</code>
              </div>
              ))}
            </div>
          </>
        ) : null}

        {activeTab === "metadata" ? (
          <div className="kv-table">
            {metadataEntries.map(([label, value]) => (
              <KeyValue key={label} label={label} value={value} />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button className={active ? "tab active" : "tab"} type="button" onClick={onClick}>
      {children}
    </button>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="kv-row">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

function NewHookModal({
  creating,
  error,
  onClose,
  onCreate,
}: {
  creating: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: () => void;
}) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="landing-card creation-card new-hook-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-hook-title"
      >
        <button
          className="modal-close"
          type="button"
          aria-label="Close new Hook dialog"
          title="Close"
          onClick={onClose}
          disabled={creating}
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" focusable="false">
            <path d="M5 5l10 10M15 5L5 15" />
          </svg>
        </button>

        <HookCreationContent
          creating={creating}
          error={error}
          context="existing-hook"
          onCreate={onCreate}
          onCancel={onClose}
        />
      </section>
    </div>
  );
}

function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case "live":
      return "Live";
    case "connecting":
      return "Connecting";
    case "disconnected":
      return "Reconnecting";
    case "error":
      return "Stream error";
    default:
      return "Idle";
  }
}

function shortId(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-6)}`;
}
