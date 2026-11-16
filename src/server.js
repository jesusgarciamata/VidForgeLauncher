import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createAuth } from "./auth.js";
import { publicError, ApiError } from "./api-error.js";
import { NocoDbClient } from "./nocodb.js";
import { VidForgeClient } from "./vidforge.js";
import { StateStore } from "./state-store.js";
import { EnergyOrchestrator } from "./orchestrator.js";

const config = loadConfig();
const auth = createAuth(config);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(root, "public");

const nocodb = new NocoDbClient({ ...config.nocodb, timeoutMs: config.httpTimeoutMs });
const vidforge = new VidForgeClient({ ...config.vidforge, timeoutMs: config.httpTimeoutMs });
const orchestrator = new EnergyOrchestrator({
  nocodb,
  vidforge,
  store: new StateStore(config.stateFile),
  pollIntervalMs: config.pollIntervalMs,
  timezone: config.timezone,
});

function securityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

function json(response, status, value) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(value));
}

function redirect(response, location) {
  response.statusCode = 303;
  response.setHeader("Location", location);
  response.setHeader("Cache-Control", "no-store");
  response.end();
}

async function bodyText(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new ApiError("Solicitud demasiado grande", { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function jsonBody(request) {
  const type = request.headers["content-type"] || "";
  if (!type.startsWith("application/json")) {
    throw new ApiError("Content-Type debe ser application/json", { status: 415 });
  }
  const text = await bodyText(request);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError("JSON inválido", { status: 400 });
  }
}

function rejectCrossSite(request) {
  if (request.headers["sec-fetch-site"] === "cross-site") {
    throw new ApiError("Solicitud cross-site rechazada", { status: 403 });
  }
}

async function sendFile(response, name, contentType) {
  const contents = await readFile(join(publicDir, name));
  response.statusCode = 200;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", name.endsWith(".html") ? "no-store" : "public, max-age=300");
  response.end(contents);
}

async function handler(request, response) {
  securityHeaders(response);
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, { status: "ok" });
    }

    if (request.method === "GET" && url.pathname === "/login") {
      if (auth.authenticated(request)) return redirect(response, "/");
      return sendFile(response, "login.html", "text/html; charset=utf-8");
    }
    if (request.method === "GET" && url.pathname === "/login.js") {
      return sendFile(response, "login.js", "text/javascript; charset=utf-8");
    }
    if (request.method === "GET" && url.pathname === "/styles.css") {
      return sendFile(response, "styles.css", "text/css; charset=utf-8");
    }

    if (request.method === "POST" && url.pathname === "/login") {
      rejectCrossSite(request);
      const params = new URLSearchParams(await bodyText(request));
      if (!auth.validCredentials(params.get("username") || "", params.get("password") || "")) {
        return redirect(response, "/login?error=1");
      }
      response.setHeader("Set-Cookie", auth.createCookie());
      return redirect(response, "/");
    }

    const isApi = url.pathname.startsWith("/api/");
    if (!auth.authenticated(request)) {
      return isApi
        ? json(response, 401, { error: "Sesión requerida", code: "unauthorized" })
        : redirect(response, "/login");
    }

    if (request.method === "POST" && url.pathname === "/logout") {
      rejectCrossSite(request);
      response.setHeader("Set-Cookie", auth.clearCookie());
      return redirect(response, "/login");
    }

    if (request.method === "GET" && url.pathname === "/api/projects") {
      return json(response, 200, {
        projects: [orchestrator.publicState()],
        pollIntervalMs: config.pollIntervalMs,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/projects/start") {
      rejectCrossSite(request);
      const body = await jsonBody(request);
      if (!Array.isArray(body.projectIds) || !body.projectIds.includes("energy")) {
        throw new ApiError("Selecciona el proyecto Energy", { status: 400, code: "project_required" });
      }
      return json(response, 202, { project: await orchestrator.start() });
    }

    if (request.method === "POST" && url.pathname === "/api/projects/energy/retry") {
      rejectCrossSite(request);
      await jsonBody(request);
      return json(response, 202, { project: await orchestrator.retry() });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return sendFile(response, "index.html", "text/html; charset=utf-8");
    }
    if (request.method === "GET" && url.pathname === "/app.js") {
      return sendFile(response, "app.js", "text/javascript; charset=utf-8");
    }

    return json(response, 404, { error: "No encontrado" });
  } catch (error) {
    console.error(error);
    const safe = publicError(error);
    return json(response, safe.status, { error: safe.message, code: safe.code });
  }
}

await orchestrator.init();
const server = createServer(handler);
server.listen(config.port, "0.0.0.0", () => {
  console.log(`VidForgeLauncher escuchando en el puerto ${config.port}`);
});

function shutdown() {
  orchestrator.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
