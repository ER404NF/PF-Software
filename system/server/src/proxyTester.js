import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import { isIP } from "node:net";
import { diagnosticError } from "./errorCatalog.js";

const HOST_RE = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const PROTOCOLS = new Set(["http", "https", "socks5"]);
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PROVIDERS = Object.freeze([
  { id: "ifconfig-co", url: "https://ifconfig.co/json" },
  { id: "ipify", url: "https://api.ipify.org/?format=json" },
]);

export class ProxyTestError extends Error {
  constructor(code, options = {}) {
    const diagnostic = diagnosticError(code, options);
    super(diagnostic.name, { cause: options.cause });
    this.name = "ProxyTestError";
    this.code = code;
    this.status = code === "P101" || code === "P108" ? 400 : 502;
    this.diagnostic = diagnostic;
  }
}

export function validateProxyForTest(proxy) {
  if (!proxy || typeof proxy !== "object" || !PROTOCOLS.has(proxy.protocol)
    || !Number.isSafeInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535
    || typeof proxy.username !== "string" || typeof proxy.password !== "string") {
    throw new ProxyTestError("P108");
  }
  const host = String(proxy.host || "").trim();
  if (!host || (!isIP(host) && !HOST_RE.test(host))) throw new ProxyTestError("P101");
  return { ...proxy, host };
}

function classifyTransportError(error, fallback = "P103") {
  if (error instanceof ProxyTestError) return error;
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(error?.code) || error?.message === "socket timeout") {
    return new ProxyTestError("P105", { cause: error, technical: { reason: error?.code || "timeout" } });
  }
  if (error?.code === "ECONNREFUSED") return new ProxyTestError("P104", { cause: error, technical: { reason: error.code } });
  if (["ENETUNREACH", "EHOSTUNREACH", "ECONNRESET", "EPIPE"].includes(error?.code)) {
    return new ProxyTestError("P103", { cause: error, technical: { reason: error.code } });
  }
  return new ProxyTestError(fallback, { cause: error, technical: { reason: error?.code || error?.name } });
}

class SocketReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.error = null;
    this.ended = false;
    this.onData = chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.flush(); };
    this.onError = error => { this.error = error; this.flush(); };
    this.onEnd = () => { this.ended = true; this.flush(); };
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("end", this.onEnd);
    socket.on("close", this.onEnd);
  }
  dispose() {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("end", this.onEnd);
    this.socket.off("close", this.onEnd);
  }
  flush() { for (const waiter of this.waiters.splice(0)) waiter(); }
  async wait() {
    if (this.error) throw this.error;
    if (this.ended) return;
    await new Promise(resolve => this.waiters.push(resolve));
    if (this.error) throw this.error;
  }
  async readExactly(length) {
    while (this.buffer.length < length) {
      if (this.ended) throw Object.assign(new Error("proxy closed the connection"), { code: "ECONNRESET" });
      await this.wait();
    }
    const value = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return value;
  }
  async readUntil(marker, maxBytes = 64 * 1024) {
    const needle = Buffer.from(marker);
    while (true) {
      const at = this.buffer.indexOf(needle);
      if (at >= 0) {
        const end = at + needle.length;
        const value = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end);
        return value;
      }
      if (this.buffer.length > maxBytes) throw new ProxyTestError("P109", { why: "The proxy returned an oversized response header." });
      if (this.ended) throw Object.assign(new Error("proxy closed before completing its response"), { code: "ECONNRESET" });
      await this.wait();
    }
  }
  async readAll(maxBytes = 1024 * 1024) {
    while (!this.ended) {
      if (this.buffer.length > maxBytes) throw new ProxyTestError("P109", { why: "The verification response was too large." });
      await this.wait();
    }
    return this.buffer;
  }
}

function connect({ host, port, secure, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tls.connect({ host, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: true })
      : net.connect({ host, port });
    const event = secure ? "secureConnect" : "connect";
    const fail = error => { socket.destroy(); reject(error); };
    socket.setTimeout(timeoutMs, () => fail(Object.assign(new Error("socket timeout"), { code: "ETIMEDOUT" })));
    socket.once("error", fail);
    socket.once(event, () => {
      socket.off("error", fail);
      socket.setTimeout(timeoutMs);
      resolve(socket);
    });
  });
}

async function socks5Connect(socket, proxy, target) {
  const reader = new SocketReader(socket);
  const hasAuth = Boolean(proxy.username);
  socket.write(Buffer.from([5, 1, hasAuth ? 2 : 0]));
  const greeting = await reader.readExactly(2);
  if (greeting[0] !== 5 || greeting[1] === 0xff) throw new ProxyTestError("P106");
  if (greeting[1] === 2) {
    const user = Buffer.from(proxy.username);
    const password = Buffer.from(proxy.password);
    if (user.length > 255 || password.length > 255) throw new ProxyTestError("P108");
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password]));
    const auth = await reader.readExactly(2);
    if (auth[0] !== 1 || auth[1] !== 0) throw new ProxyTestError("P107");
  } else if (greeting[1] !== 0) {
    throw new ProxyTestError("P106");
  }
  const name = Buffer.from(target.hostname);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name,
    Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff])]));
  const head = await reader.readExactly(4);
  if (head[0] !== 5) throw new ProxyTestError("P106");
  if (head[1] !== 0) throw new ProxyTestError(head[1] === 2 ? "P107" : "P109", { technical: { socksReply: head[1] } });
  const addressLength = head[3] === 1 ? 4 : head[3] === 4 ? 16 : head[3] === 3 ? (await reader.readExactly(1))[0] : 0;
  if (!addressLength) throw new ProxyTestError("P106");
  await reader.readExactly(addressLength + 2);
  reader.dispose();
}

function proxyAuthorization(proxy) {
  return !proxy.username ? ""
    : `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64")}\r\n`;
}

async function httpConnectTunnel(socket, proxy, target) {
  const reader = new SocketReader(socket);
  socket.write(`CONNECT ${target.hostname}:${target.port} HTTP/1.1\r\nHost: ${target.hostname}:${target.port}\r\n${proxyAuthorization(proxy)}Connection: keep-alive\r\n\r\n`);
  const headerBytes = await reader.readUntil("\r\n\r\n");
  const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(headerBytes.toString("latin1"))?.[1]);
  reader.dispose();
  if (!status) throw new ProxyTestError("P106");
  if (status === 407) throw new ProxyTestError("P107");
  if (status < 200 || status >= 300) throw new ProxyTestError("P109", { technical: { httpStatus: status } });
}

function secureTargetSocket(socket, target, timeoutMs) {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({ socket, servername: isIP(target.hostname) ? undefined : target.hostname, rejectUnauthorized: true });
    const fail = error => { secured.destroy(); reject(error); };
    secured.setTimeout(timeoutMs, () => fail(Object.assign(new Error("socket timeout"), { code: "ETIMEDOUT" })));
    secured.once("error", fail);
    secured.once("secureConnect", () => {
      secured.off("error", fail);
      resolve(secured);
    });
  });
}

function decodeChunked(body) {
  const chunks = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd < 0) throw new Error("invalid chunked response");
    const size = Number.parseInt(body.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0], 16);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid chunk length");
    offset = lineEnd + 2;
    if (size === 0) break;
    chunks.push(body.subarray(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}

async function readHttpResponse(socket) {
  const reader = new SocketReader(socket);
  const headerBytes = await reader.readUntil("\r\n\r\n");
  const headerText = headerBytes.toString("latin1");
  const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(headerText)?.[1]);
  if (!status) throw new ProxyTestError("P106");
  if (status === 407) throw new ProxyTestError("P107");
  const remainder = await reader.readAll();
  reader.dispose();
  const body = /transfer-encoding:\s*chunked/i.test(headerText) ? decodeChunked(remainder) : remainder;
  return { status, body: body.toString("utf8") };
}

function parseObservedIdentity(body) {
  const trimmed = body.trim();
  let value;
  try { value = JSON.parse(trimmed); } catch { value = { ip: trimmed }; }
  const ip = value.ip || value.ip_addr || value.address;
  if (typeof ip !== "string" || isIP(ip) !== 4) throw new ProxyTestError("P109", { why: "The proxy test response did not contain a public IPv4 address." });
  const country = value.country_iso || value.country_code || value.country || null;
  return { publicIpv4: ip, country: typeof country === "string" ? country.toUpperCase() : null };
}

export async function probeProxy(proxy, provider, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const targetUrl = new URL(provider.url);
  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    throw new ProxyTestError("P111", { why: "The configured proxy-test provider must use HTTP or HTTPS." });
  }
  const secureTarget = targetUrl.protocol === "https:";
  const target = { hostname: targetUrl.hostname, port: Number(targetUrl.port) || (secureTarget ? 443 : 80) };
  let socket;
  try {
    socket = await connect({ host: proxy.host, port: proxy.port, secure: proxy.protocol === "https", timeoutMs });
    if (proxy.protocol === "socks5") await socks5Connect(socket, proxy, target);
    else if (secureTarget) await httpConnectTunnel(socket, proxy, target);
    if (secureTarget) socket = await secureTargetSocket(socket, target, timeoutMs);
    const authorization = proxy.protocol === "socks5" || secureTarget ? "" : proxyAuthorization(proxy);
    const requestTarget = proxy.protocol === "socks5" || secureTarget ? `${targetUrl.pathname}${targetUrl.search}` : targetUrl.href;
    socket.write(`GET ${requestTarget} HTTP/1.1\r\nHost: ${targetUrl.host}\r\n${authorization}Accept: application/json,text/plain\r\nUser-Agent: PF-Software-Proxy-Test\r\nConnection: close\r\n\r\n`);
    const response = await readHttpResponse(socket);
    if (response.status < 200 || response.status >= 300) throw new ProxyTestError("P109", { technical: { httpStatus: response.status } });
    return parseObservedIdentity(response.body);
  } catch (error) {
    throw classifyTransportError(error, error instanceof ProxyTestError ? error.code : "P109");
  } finally {
    socket?.destroy();
  }
}

export function verificationProviders(env = process.env) {
  const configured = String(env.NETWORK_VERIFICATION_URLS || "").split(",").map(value => value.trim()).filter(Boolean);
  return configured.length ? configured.map((url, index) => ({ id: `configured-${index + 1}`, url })) : [...DEFAULT_PROVIDERS];
}

export async function testProxy(proxyInput, {
  lookup = dns.lookup,
  probe = probeProxy,
  providers = verificationProviders(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  const proxy = validateProxyForTest(proxyInput);
  const startedAt = now();
  try {
    await lookup(proxy.host);
  } catch (error) {
    throw new ProxyTestError("P102", { cause: error, technical: { reason: error?.code || error?.name } });
  }
  let lastProviderError = null;
  for (const provider of providers) {
    try {
      const observed = await probe(proxy, provider, { timeoutMs });
      if (observed.country && proxy.country && observed.country !== proxy.country.toUpperCase()) {
        throw new ProxyTestError("P110", { technical: { expectedCountry: proxy.country.toUpperCase(), observedCountry: observed.country } });
      }
      return {
        status: "healthy",
        checkedAt: new Date().toISOString(),
        provider: provider.id,
        publicIpv4: observed.publicIpv4,
        country: observed.country,
        latencyMs: Math.max(0, now() - startedAt),
        stages: { fields: "passed", dns: "passed", tcp: "passed", protocol: "passed", authentication: "passed", internet: "passed" },
      };
    } catch (error) {
      const classified = classifyTransportError(error, "P111");
      if (classified.code !== "P109" && classified.code !== "P111") throw classified;
      lastProviderError = classified;
    }
  }
  throw new ProxyTestError("P111", { cause: lastProviderError, technical: { providersTried: providers.map(item => item.id) } });
}
