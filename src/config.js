const REQUIRED_ENV = [
  "DASHBOARD_USERNAME",
  "DASHBOARD_PASSWORD",
  "SESSION_SECRET",
  "NOCODB_BASE_URL",
  "NOCODB_API_TOKEN",
  "NOCODB_TABLE_ID",
  "VIDFORGE_BASE_URL",
  "VIDFORGE_API_KEY",
];

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

function positiveInteger(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} debe ser un entero positivo`);
  }
  return value;
}

function booleanValue(name, fallback) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} debe ser true o false`);
}

function baseUrl(name) {
  const value = required(name).replace(/\/+$/, "");
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${name} debe usar http o https`);
  }
  return value;
}

export function loadConfig() {
  for (const name of REQUIRED_ENV) required(name);

  const apiVersion = process.env.NOCODB_API_VERSION?.trim().toLowerCase() || "v2";
  if (!['v2', 'v3'].includes(apiVersion)) {
    throw new Error("NOCODB_API_VERSION debe ser v2 o v3");
  }
  if (apiVersion === "v3" && !process.env.NOCODB_BASE_ID?.trim()) {
    throw new Error("NOCODB_BASE_ID es obligatorio al usar NocoDB v3");
  }

  const sessionSecret = required("SESSION_SECRET");
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET debe tener al menos 32 caracteres");
  }

  return {
    port: positiveInteger("APP_PORT", 3000),
    timezone: process.env.APP_TIMEZONE?.trim() || "America/Mexico_City",
    cookieSecure: booleanValue("COOKIE_SECURE", true),
    stateFile: process.env.STATE_FILE?.trim() || "./data/state.json",
    pollIntervalMs: positiveInteger("POLL_INTERVAL_MS", 300_000),
    httpTimeoutMs: positiveInteger("HTTP_TIMEOUT_MS", 30_000),
    dashboard: {
      username: required("DASHBOARD_USERNAME"),
      password: required("DASHBOARD_PASSWORD"),
      sessionSecret,
    },
    nocodb: {
      baseUrl: baseUrl("NOCODB_BASE_URL"),
      token: required("NOCODB_API_TOKEN"),
      apiVersion,
      baseId: process.env.NOCODB_BASE_ID?.trim() || "",
      tableId: required("NOCODB_TABLE_ID"),
    },
    vidforge: {
      baseUrl: baseUrl("VIDFORGE_BASE_URL"),
      apiKey: required("VIDFORGE_API_KEY"),
    },
  };
}
