import { ApiError } from "./api-error.js";

function safeBodyText(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 2_000);
  }
}

export async function requestJson(url, {
  method = "GET",
  headers = {},
  body,
  timeoutMs = 30_000,
} = {}) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error?.name === "TimeoutError" ? "Tiempo de espera agotado" : error.message;
    throw new ApiError(`No se pudo conectar con ${new URL(url).host}: ${reason}`, {
      code: "network_error",
    });
  }

  const text = await response.text();
  const parsed = safeBodyText(text);
  if (!response.ok) {
    const detail = typeof parsed === "object" && parsed?.error ? `: ${parsed.error}` : "";
    throw new ApiError(`La API respondió HTTP ${response.status}${detail}`, {
      status: response.status,
      body: parsed,
      code: "upstream_error",
    });
  }
  return parsed;
}
