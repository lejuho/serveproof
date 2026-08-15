const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

type SessionSlot = "staff" | "worker";

const LEGACY_ACCESS_KEY = "sp_access_token";
const LEGACY_REFRESH_KEY = "sp_refresh_token";
const accessKey = (slot: SessionSlot) => `sp_${slot}_access_token`;
const refreshKey = (slot: SessionSlot) => `sp_${slot}_refresh_token`;

function decodeRole(token: string): string | null {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return null;
    const base64 = encoded
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    return (JSON.parse(atob(base64)) as { role?: string }).role ?? null;
  } catch {
    return null;
  }
}

function slotForRole(role: string | null): SessionSlot | null {
  if (!role) return null;
  return role === "WORKER" ? "worker" : "staff";
}

function slotForPage(): SessionSlot | null {
  if (typeof window === "undefined") return null;
  if (window.location.pathname.startsWith("/me")) return "worker";
  if (window.location.pathname.startsWith("/dashboard")) return "staff";
  return null;
}

/**
 * Keep manager and worker sessions independent. QA commonly opens /dashboard
 * and /me in separate tabs on the same origin; one shared token caused the
 * worker login to replace the manager token and venue APIs to return 403.
 */
function currentSlot(): SessionSlot | null {
  if (typeof window === "undefined") return null;
  const pageSlot = slotForPage();
  if (pageSlot) return pageSlot;
  return (
    slotForRole(decodeRole(localStorage.getItem(LEGACY_ACCESS_KEY) ?? "")) ??
    (localStorage.getItem(accessKey("staff")) ? "staff" : null) ??
    (localStorage.getItem(accessKey("worker")) ? "worker" : null)
  );
}

function migrateLegacySession(slot: SessionSlot): void {
  const legacyAccess = localStorage.getItem(LEGACY_ACCESS_KEY);
  if (!legacyAccess || slotForRole(decodeRole(legacyAccess)) !== slot) return;
  localStorage.setItem(accessKey(slot), legacyAccess);
  const legacyRefresh = localStorage.getItem(LEGACY_REFRESH_KEY);
  if (legacyRefresh) localStorage.setItem(refreshKey(slot), legacyRefresh);
  localStorage.removeItem(LEGACY_ACCESS_KEY);
  localStorage.removeItem(LEGACY_REFRESH_KEY);
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  const slot = currentSlot();
  if (!slot) return null;
  migrateLegacySession(slot);
  return localStorage.getItem(accessKey(slot));
}

export function setTokens(accessToken: string, refreshToken: string) {
  const slot = slotForRole(decodeRole(accessToken));
  if (!slot) throw new Error("Invalid access token role");

  // Preserve a pre-upgrade session for the other app area before removing
  // the old shared keys. This avoids forcing an unnecessary one-time login.
  const legacyAccess = localStorage.getItem(LEGACY_ACCESS_KEY);
  const legacySlot = legacyAccess ? slotForRole(decodeRole(legacyAccess)) : null;
  if (legacyAccess && legacySlot && legacySlot !== slot) {
    localStorage.setItem(accessKey(legacySlot), legacyAccess);
    const legacyRefresh = localStorage.getItem(LEGACY_REFRESH_KEY);
    if (legacyRefresh) localStorage.setItem(refreshKey(legacySlot), legacyRefresh);
  }

  localStorage.setItem(accessKey(slot), accessToken);
  localStorage.setItem(refreshKey(slot), refreshToken);
  localStorage.removeItem(LEGACY_ACCESS_KEY);
  localStorage.removeItem(LEGACY_REFRESH_KEY);
}

export function clearTokens() {
  const slot = currentSlot();
  if (slot) {
    localStorage.removeItem(accessKey(slot));
    localStorage.removeItem(refreshKey(slot));
  }
  localStorage.removeItem(LEGACY_ACCESS_KEY);
  localStorage.removeItem(LEGACY_REFRESH_KEY);
}

function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  const slot = currentSlot();
  if (!slot) return null;
  migrateLegacySession(slot);
  return localStorage.getItem(refreshKey(slot));
}

let refreshPromise: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const attemptedRefreshToken = getRefreshToken();
    if (!attemptedRefreshToken) return false;
    try {
      const response = await fetch(`${API_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: attemptedRefreshToken }),
      });
      if (!response.ok) {
        // Another tab may already have rotated this single-use refresh token.
        // In that case, use the newer pair it wrote instead of deleting it.
        if (getRefreshToken() !== attemptedRefreshToken && getToken()) return true;
        clearTokens();
        return false;
      }
      const tokens = (await response.json()) as { accessToken: string; refreshToken: string };
      setTokens(tokens.accessToken, tokens.refreshToken);
      return true;
    } catch {
      // A transient network failure should not destroy a still-valid session.
      return false;
    }
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const request = () => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.auth !== false) {
      const token = getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    return fetch(`${API_URL}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  };

  let res = await request();
  if (res.status === 401 && options.auth !== false && (await refreshSession())) {
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
