export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      typeof error.detail === "string"
        ? error.detail
        : ru.serverError(response.status),
    );
  }
  return response.json() as Promise<T>;
}
import { ru } from "./i18n/ru";
