import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "vfl_session";
const SESSION_SECONDS = 12 * 60 * 60;

function equalText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) {
    timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return timingSafeEqual(a, b);
}

function sign(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((item) => item.trim()).filter(Boolean).map((item) => {
      const index = item.indexOf("=");
      if (index === -1) return [item, ""];
      return [item.slice(0, index), decodeURIComponent(item.slice(index + 1))];
    }),
  );
}

export function createAuth(config) {
  const { username, password, sessionSecret } = config.dashboard;

  function validCredentials(candidateUser, candidatePassword) {
    const validUser = equalText(candidateUser, username);
    const validPassword = equalText(candidatePassword, password);
    return validUser && validPassword;
  }

  function createCookie() {
    const body = Buffer.from(JSON.stringify({
      sub: username,
      exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS,
    })).toString("base64url");
    const value = `${body}.${sign(body, sessionSecret)}`;
    const secure = config.cookieSecure ? "; Secure" : "";
    return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure}`;
  }

  function clearCookie() {
    const secure = config.cookieSecure ? "; Secure" : "";
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
  }

  function authenticated(request) {
    const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
    if (!token) return false;
    const [body, signature] = token.split(".");
    if (!body || !signature || !equalText(signature, sign(body, sessionSecret))) return false;
    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      return payload.sub === username && Number(payload.exp) > Math.floor(Date.now() / 1000);
    } catch {
      return false;
    }
  }

  return { validCredentials, createCookie, clearCookie, authenticated };
}
