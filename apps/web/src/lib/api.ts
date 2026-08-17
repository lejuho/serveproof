const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export type AppMode = "staff" | "worker";

export interface StoredSession {
  id: string;
  email: string;
  role: string;
  modes: AppMode[];
  defaultMode: AppMode;
  updatedAt: number;
}

const LEGACY_ACCESS_KEY = "sp_access_token";
const LEGACY_REFRESH_KEY = "sp_refresh_token";
const legacyAccessKey = (mode: AppMode) => `sp_${mode}_access_token`;
const legacyRefreshKey = (mode: AppMode) => `sp_${mode}_refresh_token`;
const SESSION_INDEX_KEY = "sp_session_index_v2";
const ACTIVE_SESSION_KEY = "sp_active_session_id";
const ACTIVE_MODE_KEY = "sp_active_app_mode";
const LAST_SESSION_KEY = "sp_last_session_id";
const lastModeKey = (mode: AppMode) => `sp_last_${mode}_session_id`;
const sessionAccessKey = (id: string) => `sp_session_${id}_access_token`;
const sessionRefreshKey = (id: string) => `sp_session_${id}_refresh_token`;

interface TokenClaims {
  sub?: string;
  email?: string;
  role?: string;
  modes?: string[];
  exp?: number;
}

function decodeClaims(token: string): TokenClaims | null {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return null;
    const base64 = encoded
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    return JSON.parse(atob(base64)) as TokenClaims;
  } catch {
    return null;
  }
}

function legacyModeForRole(role: string | null | undefined): AppMode | null {
  if (!role) return null;
  return role === "WORKER" ? "worker" : "staff";
}

function modeForPage(): AppMode | null {
  if (typeof window === "undefined") return null;
  if (window.location.pathname.startsWith("/me")) return "worker";
  if (window.location.pathname.startsWith("/dashboard")) return "staff";
  return null;
}

function readSessionIndex(): StoredSession[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_INDEX_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): StoredSession[] => {
      if (!item || typeof item !== "object") return [];
      const raw = item as Record<string, unknown>;
      if (
        typeof raw.id !== "string" ||
        typeof raw.email !== "string" ||
        typeof raw.role !== "string" ||
        typeof raw.updatedAt !== "number"
      ) {
        return [];
      }
      const legacyMode: AppMode | null =
        raw.slot === "staff" || raw.slot === "worker" ? raw.slot : null;
      const modes: AppMode[] = Array.isArray(raw.modes)
        ? raw.modes.filter((mode): mode is AppMode => mode === "worker" || mode === "staff")
        : legacyMode
          ? [legacyMode]
          : [];
      if (modes.length === 0) return [];
      const defaultMode =
        (raw.defaultMode === "worker" || raw.defaultMode === "staff") &&
        modes.includes(raw.defaultMode)
          ? raw.defaultMode
          : modes[0]!;
      return [
        {
          id: raw.id,
          email: raw.email,
          role: raw.role,
          modes,
          defaultMode,
          updatedAt: raw.updatedAt,
        },
      ];
    });
  } catch {
    return [];
  }
}

function writeSessionIndex(sessions: StoredSession[]): void {
  localStorage.setItem(SESSION_INDEX_KEY, JSON.stringify(sessions));
}

function persistSession(
  accessToken: string,
  refreshToken: string,
  options: { activate: boolean; fallbackId?: string } = { activate: true },
): StoredSession {
  const claims = decodeClaims(accessToken);
  const legacyMode = legacyModeForRole(claims?.role);
  const modes = (claims?.modes ?? []).filter(
    (mode): mode is AppMode => mode === "worker" || mode === "staff",
  );
  if (modes.length === 0 && legacyMode) modes.push(legacyMode);
  if (modes.length === 0) throw new Error("Invalid access token capabilities");
  const id = claims?.sub || options.fallbackId;
  if (!id) throw new Error("Invalid access token subject");
  const defaultMode = legacyMode && modes.includes(legacyMode) ? legacyMode : modes[0]!;
  const session: StoredSession = {
    id,
    email: claims?.email ?? "",
    role: claims?.role ?? "",
    modes,
    defaultMode,
    updatedAt: Date.now(),
  };
  const existingSessions = readSessionIndex();
  const previous = existingSessions.find((item) => item.id === id);
  if (previous && previous.modes.some((mode) => !modes.includes(mode))) {
    for (const mode of previous.modes) {
      if (!modes.includes(mode) && localStorage.getItem(lastModeKey(mode)) === id) {
        localStorage.removeItem(lastModeKey(mode));
      }
    }
  }
  writeSessionIndex([...existingSessions.filter((item) => item.id !== id), session]);
  localStorage.setItem(sessionAccessKey(id), accessToken);
  if (refreshToken) localStorage.setItem(sessionRefreshKey(id), refreshToken);
  localStorage.setItem(LAST_SESSION_KEY, id);
  for (const mode of modes) localStorage.setItem(lastModeKey(mode), id);
  if (options.activate) sessionStorage.setItem(ACTIVE_SESSION_KEY, id);
  return session;
}

let legacyMigrationDone = false;

function migrateLegacySessions(): void {
  if (typeof window === "undefined" || legacyMigrationDone) return;
  legacyMigrationDone = true;
  const candidates: Array<{ accessKey: string; refreshKey: string; fallbackMode?: AppMode }> = [
    { accessKey: LEGACY_ACCESS_KEY, refreshKey: LEGACY_REFRESH_KEY },
    {
      accessKey: legacyAccessKey("staff"),
      refreshKey: legacyRefreshKey("staff"),
      fallbackMode: "staff",
    },
    {
      accessKey: legacyAccessKey("worker"),
      refreshKey: legacyRefreshKey("worker"),
      fallbackMode: "worker",
    },
  ];
  for (const candidate of candidates) {
    const accessToken = localStorage.getItem(candidate.accessKey);
    if (!accessToken) continue;
    const claims = decodeClaims(accessToken);
    const mode = legacyModeForRole(claims?.role) ?? candidate.fallbackMode;
    if (!mode) continue;
    try {
      persistSession(accessToken, localStorage.getItem(candidate.refreshKey) ?? "", {
        activate: false,
        fallbackId: claims?.sub ?? `legacy-${mode}`,
      });
    } catch {
      continue;
    }
    localStorage.removeItem(candidate.accessKey);
    localStorage.removeItem(candidate.refreshKey);
  }
}

function sessionHasToken(session: StoredSession): boolean {
  return Boolean(localStorage.getItem(sessionAccessKey(session.id)));
}

function findSession(id: string | null): StoredSession | null {
  if (!id) return null;
  return (
    readSessionIndex().find((session) => session.id === id && sessionHasToken(session)) ?? null
  );
}

function currentSession(): StoredSession | null {
  if (typeof window === "undefined") return null;
  migrateLegacySessions();
  const sessions = readSessionIndex()
    .filter(sessionHasToken)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const requiredMode = modeForPage();
  const active = findSession(sessionStorage.getItem(ACTIVE_SESSION_KEY));
  // The selected identity belongs to the tab. Do not silently replace it with
  // another saved account merely because the URL points at a different view.
  if (active) return active;
  if (requiredMode) {
    const lastForMode = findSession(localStorage.getItem(lastModeKey(requiredMode)));
    const selected =
      (lastForMode?.modes.includes(requiredMode) ? lastForMode : null) ??
      sessions.find((session) => session.modes.includes(requiredMode)) ??
      null;
    if (selected) {
      sessionStorage.setItem(ACTIVE_SESSION_KEY, selected.id);
      sessionStorage.setItem(ACTIVE_MODE_KEY, requiredMode);
    }
    return selected;
  }
  const selected =
    active ?? findSession(localStorage.getItem(LAST_SESSION_KEY)) ?? sessions[0] ?? null;
  if (selected) sessionStorage.setItem(ACTIVE_SESSION_KEY, selected.id);
  return selected;
}

function removeSession(id: string): void {
  const removed = findSession(id);
  writeSessionIndex(readSessionIndex().filter((session) => session.id !== id));
  localStorage.removeItem(sessionAccessKey(id));
  localStorage.removeItem(sessionRefreshKey(id));
  if (sessionStorage.getItem(ACTIVE_SESSION_KEY) === id) {
    sessionStorage.removeItem(ACTIVE_SESSION_KEY);
  }
  if (localStorage.getItem(LAST_SESSION_KEY) === id) localStorage.removeItem(LAST_SESSION_KEY);
  if (removed) {
    for (const mode of removed.modes) {
      if (localStorage.getItem(lastModeKey(mode)) === id) {
        localStorage.removeItem(lastModeKey(mode));
      }
    }
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function getStoredSessions(): StoredSession[] {
  if (typeof window === "undefined") return [];
  migrateLegacySessions();
  return readSessionIndex()
    .filter(sessionHasToken)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function destinationFor(mode: AppMode): string {
  return mode === "worker" ? "/me" : "/dashboard";
}

export function activateSession(id: string, requestedMode?: AppMode): string | null {
  const session = findSession(id);
  if (!session) return null;
  const tabMode = sessionStorage.getItem(ACTIVE_MODE_KEY);
  const mode =
    (requestedMode && session.modes.includes(requestedMode) ? requestedMode : null) ??
    ((tabMode === "worker" || tabMode === "staff") && session.modes.includes(tabMode)
      ? tabMode
      : null) ??
    session.defaultMode;
  sessionStorage.setItem(ACTIVE_SESSION_KEY, id);
  sessionStorage.setItem(ACTIVE_MODE_KEY, mode);
  localStorage.setItem(LAST_SESSION_KEY, id);
  localStorage.setItem(lastModeKey(mode), id);
  return destinationFor(mode);
}

export function switchAppMode(mode: AppMode): string | null {
  const session = currentSession();
  if (!session?.modes.includes(mode)) return null;
  sessionStorage.setItem(ACTIVE_MODE_KEY, mode);
  localStorage.setItem(lastModeKey(mode), session.id);
  return destinationFor(mode);
}

export function getCurrentSession(): StoredSession | null {
  return currentSession();
}

export async function syncCurrentSession(): Promise<StoredSession | null> {
  const session = currentSession();
  if (!session) return null;
  const accessToken = localStorage.getItem(sessionAccessKey(session.id));
  if (!accessToken) return null;
  try {
    const response = await fetch(`${API_URL}/auth/session`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return session;
    const data = (await response.json()) as { email?: string; modes?: string[] };
    const modes = (data.modes ?? []).filter(
      (mode): mode is AppMode => mode === "worker" || mode === "staff",
    );
    if (modes.length === 0) return session;
    const updated: StoredSession = {
      ...session,
      email: data.email ?? session.email,
      modes,
      defaultMode: modes.includes(session.defaultMode) ? session.defaultMode : modes[0]!,
    };
    writeSessionIndex([...readSessionIndex().filter((item) => item.id !== session.id), updated]);
    for (const mode of session.modes) {
      if (!modes.includes(mode) && localStorage.getItem(lastModeKey(mode)) === session.id) {
        localStorage.removeItem(lastModeKey(mode));
      }
    }
    for (const mode of modes) localStorage.setItem(lastModeKey(mode), session.id);
    return updated;
  } catch {
    return session;
  }
}

export function getToken(): string | null {
  const session = currentSession();
  return session ? localStorage.getItem(sessionAccessKey(session.id)) : null;
}

export function setTokens(accessToken: string, refreshToken: string): void {
  persistSession(accessToken, refreshToken, { activate: true });
}

export function clearTokens(): void {
  const session = currentSession();
  if (session) removeSession(session.id);
}

function getRefreshToken(id: string): string | null {
  return localStorage.getItem(sessionRefreshKey(id));
}

const refreshPromises = new Map<string, Promise<boolean>>();

async function withRefreshLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(`serveproof-refresh-${sessionId}`, { mode: "exclusive" }, task);
  }
  return task();
}

async function refreshSession(staleAccessToken?: string | null): Promise<boolean> {
  const session =
    (staleAccessToken
      ? readSessionIndex().find(
          (item) => localStorage.getItem(sessionAccessKey(item.id)) === staleAccessToken,
        )
      : null) ?? currentSession();
  if (!session) return false;
  const existing = refreshPromises.get(session.id);
  if (existing) return existing;
  const pending = withRefreshLock(session.id, async () => {
    const latestAccessToken = localStorage.getItem(sessionAccessKey(session.id));
    if (staleAccessToken && latestAccessToken && latestAccessToken !== staleAccessToken)
      return true;
    const attemptedRefreshToken = getRefreshToken(session.id);
    if (!attemptedRefreshToken) {
      removeSession(session.id);
      return false;
    }
    try {
      const response = await fetch(`${API_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: attemptedRefreshToken }),
      });
      if (!response.ok) {
        const currentRefreshToken = getRefreshToken(session.id);
        const currentAccessToken = localStorage.getItem(sessionAccessKey(session.id));
        if (
          currentRefreshToken &&
          currentRefreshToken !== attemptedRefreshToken &&
          currentAccessToken
        ) {
          return true;
        }
        removeSession(session.id);
        return false;
      }
      const tokens = (await response.json()) as { accessToken: string; refreshToken: string };
      persistSession(tokens.accessToken, tokens.refreshToken, { activate: true });
      return true;
    } catch {
      return false;
    }
  }).finally(() => {
    refreshPromises.delete(session.id);
  });
  refreshPromises.set(session.id, pending);
  return pending;
}

export async function restoreSession(): Promise<string | null> {
  const session = currentSession();
  if (!session) return null;
  const accessToken = localStorage.getItem(sessionAccessKey(session.id));
  const claims = accessToken ? decodeClaims(accessToken) : null;
  const usable = Boolean(accessToken && claims?.exp && claims.exp * 1000 > Date.now() + 10_000);
  if (!usable && !(await refreshSession(accessToken))) return null;
  const refreshed = await syncCurrentSession();
  if (!refreshed) return null;
  const requiredMode = modeForPage();
  const savedMode = sessionStorage.getItem(ACTIVE_MODE_KEY);
  const mode =
    (requiredMode && refreshed.modes.includes(requiredMode) ? requiredMode : null) ??
    ((savedMode === "worker" || savedMode === "staff") && refreshed.modes.includes(savedMode)
      ? savedMode
      : null) ??
    refreshed.defaultMode;
  sessionStorage.setItem(ACTIVE_MODE_KEY, mode);
  return destinationFor(mode);
}

export async function logoutSession(): Promise<void> {
  const session = currentSession();
  if (!session) return;
  const refreshToken = getRefreshToken(session.id);
  try {
    if (refreshToken) {
      await fetch(`${API_URL}/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
    }
  } catch {
    // Local logout must still complete when the API is temporarily unreachable.
  } finally {
    removeSession(session.id);
  }
}

export async function api<T = unknown>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    auth?: boolean;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  let tokenUsed: string | null = null;
  const request = () => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...options.headers,
    };
    if (options.auth !== false) {
      tokenUsed = getToken();
      if (tokenUsed) headers.Authorization = `Bearer ${tokenUsed}`;
    }
    return fetch(`${API_URL}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  };
  let res = await request();
  if (res.status === 401 && options.auth !== false && (await refreshSession(tokenUsed))) {
    res = await request();
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      typeof data.message === "string" ? data.message : `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}
