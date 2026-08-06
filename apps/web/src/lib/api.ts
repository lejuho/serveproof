const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

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
  return localStorage.getItem("sp_access_token");
}

export function setTokens(accessToken: string, refreshToken: string) {
  localStorage.setItem("sp_access_token", accessToken);
  localStorage.setItem("sp_refresh_token", refreshToken);
}

export function clearTokens() {
  localStorage.removeItem("sp_access_token");
  localStorage.removeItem("sp_refresh_token");
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.auth !== false) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      typeof data.message === "string" ? data.message : `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}
