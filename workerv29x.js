import { connect as cfConnect } from "cloudflare:sockets";

// Debug mode flag
const DEBUG_MODE = false; // Set to true only when debugging

function debugLog(message, ...args) {
  if (DEBUG_MODE) {
    console.log(message, ...args);
  }
}

function toBase64Utf8(value) {
  return encodeBase64(new TextEncoder().encode(value));
}

const DNS_CACHE = new Map();
const DNS_IN_FLIGHT = new Map(); // For request coalescing
const DNS_CACHE_TTL = 300000; // 5 minutes
const DNS_CACHE_MAX_SIZE = 1000; // Maximum 1000 entries to prevent memory leak
const NEGATIVE_DNS_CACHE_TTL = 60000; // 1 minute for failed DNS lookups
const ENDPOINT_HEALTH = new Map();
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN = 60000;
const ENDPOINT_HEALTH_MAX_SIZE = 1000;
const ENDPOINT_HEALTH_TTL = 300000; // 5 minutes
const MAX_WEBSOCKET_MESSAGE_SIZE = 1024 * 1024; // 1MB
const MAX_DNS_RESPONSE_SIZE = 65536; // 64KB
let ENDPOINT_PRUNE_COUNTER = 0;

// ============================================
// RATE / CONNECTION LIMITING
// ============================================
const RATE_LIMIT = new Map();
const MAX_REQUESTS_PER_MINUTE = 600;
const RATE_LIMIT_CLEANUP_INTERVAL = 100;
let rateLimitCleanupCounter = 0;

function normalizeClientIP(clientIP) {
  if (!clientIP) return "unknown";
  const first = String(clientIP).split(",")[0].trim();
  return first || "unknown";
}

function checkRateLimit(clientIP) {
  const ipKey = normalizeClientIP(clientIP);
  if (!ipKey || ipKey === "unknown") return true;
  const now = Date.now();
  const currentMinute = Math.floor(now / 60000);
  const key = `${ipKey}_${currentMinute}`;
  const count = RATE_LIMIT.get(key) || 0;
  if (count >= MAX_REQUESTS_PER_MINUTE) {
    if (DEBUG_MODE) {
      console.log(`[RATE LIMIT] IP ${ipKey} exceeded ${MAX_REQUESTS_PER_MINUTE} req/min`);
    }
    return false;
  }
  RATE_LIMIT.set(key, count + 1);
  rateLimitCleanupCounter++;
  if (rateLimitCleanupCounter >= RATE_LIMIT_CLEANUP_INTERVAL) {
    rateLimitCleanupCounter = 0;
    cleanupRateLimitCache(currentMinute);
  }
  return true;
}

function cleanupRateLimitCache(currentMinute) {
  let cleaned = 0;
  for (const [key] of RATE_LIMIT.entries()) {
    const minute = Number.parseInt(key.split("_").pop(), 10);
    if (!Number.isNaN(minute) && currentMinute - minute > 2) {
      RATE_LIMIT.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0 && DEBUG_MODE) {
    console.log(`[RATE LIMIT] Cleaned ${cleaned} old entries`);
  }
}

// PERFORMANCE FIX: Module-level KV cache

const SETTINGS_CACHE = {
  data: null,
  timestamp: 0,
  ttl: 300000,        // 5 minutes
  loading: null,
  version: 0
};

const WARP_CACHE = {
  data: null,
  timestamp: 0,
  ttl: 3600000,       // 1 hour
  loading: null,
  version: 0
};

let CACHE_VERSION = 0;

const CACHE_STATS = {
  hits: 0,
  misses: 0,
  refreshes: 0,
  errors: 0
};

function invalidateCache() {
  CACHE_VERSION++;
  SETTINGS_CACHE.data = null;
  SETTINGS_CACHE.timestamp = 0;
  SETTINGS_CACHE.version = CACHE_VERSION;
  WARP_CACHE.data = null;
  WARP_CACHE.timestamp = 0;
  WARP_CACHE.version = CACHE_VERSION;
  console.log(`[CACHE] Invalidated - new version: ${CACHE_VERSION}`);
}

async function getCachedData(cacheObj, fetchFn, cacheName, context) {
  const now = Date.now();
  const age = now - cacheObj.timestamp;
  const isStale = age > cacheObj.ttl;
  const needsRefresh = age > cacheObj.ttl * 0.5;
  
  if (cacheObj.data && !isStale && cacheObj.version === CACHE_VERSION) {
    CACHE_STATS.hits++;
    if (needsRefresh && !cacheObj.loading) {
      CACHE_STATS.refreshes++;
      const refreshPromise = (async () => {
        try {
          const fresh = await fetchFn();
          cacheObj.data = fresh;
          cacheObj.timestamp = Date.now();
          cacheObj.version = CACHE_VERSION;
        } catch (error) {
          CACHE_STATS.errors++;
          console.error(`[CACHE] Refresh failed for ${cacheName}:`, error.message);
        } finally {
          cacheObj.loading = null;
        }
      })();
      cacheObj.loading = refreshPromise;
      if (context?.waitUntil) {
        context.waitUntil(refreshPromise);
      }
    }
    return cacheObj.data;
  }
  
  CACHE_STATS.misses++;
  
  if (cacheObj.loading) {
    try {
      await cacheObj.loading;
      if (cacheObj.data) return cacheObj.data;
    } catch (error) {
      console.error(`[CACHE] Coalesced load failed for ${cacheName}`);
      throw error;
    }
  }
  
  cacheObj.loading = (async () => {
    try {
      const fresh = await fetchFn();
      cacheObj.data = fresh;
      cacheObj.timestamp = Date.now();
      cacheObj.version = CACHE_VERSION;
      return fresh;
    } catch (error) {
      CACHE_STATS.errors++;
      console.error(`[CACHE] Fetch failed for ${cacheName}:`, error.message);
      if (cacheObj.data) return cacheObj.data;
      throw error;
    } finally {
      cacheObj.loading = null;
    }
  })();
  
  return cacheObj.loading;
}

// Helper to prevent memory leaks from hanging timers
function withTimeout(promise, timeoutMs, errorMessage) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise])
    .finally(() => clearTimeout(timeoutId));
}
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function (x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/protocols/warp.ts
async function fetchWarpAccounts(env) {
  const WarpAccounts = [];
  const apiBaseUrl = "https://api.cloudflareclient.com/v0a4005/reg";
  const sharedKey = await generateKeyPair();
  const warpKeys = [sharedKey, sharedKey];
  const fetchAccount = async (key) => {
    try {
      const response = await fetch(apiBaseUrl, {
        method: "POST",
        headers: {
          "User-Agent": "insomnia/8.6.1",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          install_id: "",
          fcm_token: "",
          tos: (/* @__PURE__ */ new Date()).toISOString(),
          type: "Android",
          model: "PC",
          locale: "en_US",
          warp_enabled: true,
          key: key.publicKey
        })
      });
      return await response.json();
    } catch (error) {
      const message2 = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to get warp configs: ${message2}`);
    }
  };
  for (const key of warpKeys) {
    const { config } = await fetchAccount(key);
    WarpAccounts.push({
      privateKey: key.privateKey,
      warpIPv6: `${config.interface.addresses.v6}/128`,
      reserved: config.client_id,
      publicKey: config.peers[0].public_key
    });
  }
  // Check if save succeeded (critical - cannot function without WARP accounts)
  const success = await saveDataset(env, "warpAccounts", WarpAccounts);
  if (!success) {
    console.error('CRITICAL: Failed to persist WARP accounts to KV');
    throw new Error('Failed to save WARP accounts - KV write failed after retries');
  }
  
  return WarpAccounts;
}
async function generateKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "X25519", namedCurve: "X25519" },
    true,
    ["deriveBits"]
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const privateKeyRaw = new Uint8Array(pkcs8).slice(-32);
  const publicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey)
  );
  const base64Encode = (arr) => {
    let binary = '';
    const len = arr.length;
    const chunkSize = 32768; // Safe chunk size for spread operator
    for (let i = 0; i < len; i += chunkSize) {
      binary += String.fromCharCode(...arr.subarray(i, Math.min(i + chunkSize, len)));
    }
    return btoa(binary);
  };
  return {
    publicKey: base64Encode(publicKeyRaw),
    privateKey: base64Encode(privateKeyRaw)
  };
}

// src/cores/utils.ts
function isDomain(address) {
  if (!address) return false;
  const domainRegex = /^(?!-)(?:[A-Za-z0-9-]{1,63}.)+[A-Za-z]{2,}$/;
  return domainRegex.test(address);
}
function endpointKey(address, port) {
  return `${address}:${port}`;
}
function shouldTryEndpoint(address, port) {
  const key = endpointKey(address, port);
  const health = ENDPOINT_HEALTH.get(key);
  if (!health) return true;
  if (!health.circuitOpen) return true;
  if (Date.now() - health.lastFail > CIRCUIT_BREAKER_COOLDOWN) {
    ENDPOINT_HEALTH.set(key, { failures: 0, lastFail: 0, circuitOpen: false });
    return true;
  }
  return false;
}
function recordEndpointFailure(address, port) {
  const key = endpointKey(address, port);
  const current = ENDPOINT_HEALTH.get(key) ?? { failures: 0, lastFail: 0, circuitOpen: false };
  current.failures += 1;
  current.lastFail = Date.now();
  if (current.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    current.circuitOpen = true;
  }

  ENDPOINT_PRUNE_COUNTER++;
  if (ENDPOINT_PRUNE_COUNTER >= 100) {
    ENDPOINT_PRUNE_COUNTER = 0;
    pruneStaleEndpoints();
  }

  if (!ENDPOINT_HEALTH.has(key) && ENDPOINT_HEALTH.size >= ENDPOINT_HEALTH_MAX_SIZE) {
    const oldestKey = ENDPOINT_HEALTH.keys().next().value;
    ENDPOINT_HEALTH.delete(oldestKey);
  }

  ENDPOINT_HEALTH.set(key, current);
}
function recordEndpointSuccess(address, port) {
  ENDPOINT_HEALTH.delete(endpointKey(address, port));
}
function pruneStaleEndpoints(now = Date.now()) {
  let pruned = 0;
  for (const [key, value] of ENDPOINT_HEALTH.entries()) {
    if (now - value.lastFail > ENDPOINT_HEALTH_TTL) {
      ENDPOINT_HEALTH.delete(key);
      pruned++;
    }
  }
  if (pruned > 0 && DEBUG_MODE) {
    console.log(`[CIRCUIT] Pruned ${pruned} stale endpoints`);
  }
}
function createIdleWatchdog(log, onTimeout, idleMs = 300000, checkMs = 60000) {
  let lastActivity = Date.now();
  let timer = setInterval(() => {
    const idleTime = Date.now() - lastActivity;
    if (idleTime > idleMs) {
      log(`Closing idle connection after ${Math.floor(idleTime / 1e3)}s`);
      try {
        onTimeout();
      } catch (error) {
        const message2 = error instanceof Error ? error.message : String(error);
        log(`Watchdog timeout handler failed: ${message2}`);
      }
      clearInterval(timer);
      timer = null;
    }
  }, checkMs);
  return {
    touch() {
      lastActivity = Date.now();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  };
}
async function resolveDNS(domain, onlyIPv4 = false, dohURL = "https://cloudflare-dns.com/dns-query") {
  const cacheKey = `${domain}_${onlyIPv4}`;
  const cached = DNS_CACHE.get(cacheKey);
  if (cached) {
    const ttl = cached.isFailure ? NEGATIVE_DNS_CACHE_TTL : DNS_CACHE_TTL;
    if (Date.now() - cached.timestamp < ttl) {
      DNS_CACHE.delete(cacheKey);
      DNS_CACHE.set(cacheKey, cached);
      if (cached.isFailure) {
        throw new Error(cached.error || `DNS lookup failed for ${domain}`);
      }
      return cached.data;
    }
  }
  if (DNS_IN_FLIGHT.has(cacheKey)) {
    return DNS_IN_FLIGHT.get(cacheKey);
  }
  const dohBaseURL = `${dohURL}?name=${encodeURIComponent(domain)}`;
  const dohURLs = {
    ipv4: `${dohBaseURL}&type=A`,
    ipv6: `${dohBaseURL}&type=AAAA`
  };
  const fetchPromise = (async () => {
    try {
      const DNS_TIMEOUT = 3000;
      const fetchWithTimeout = async (url, recordType, timeout) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        try {
          return await fetchDNSRecords(url, recordType, controller.signal);
        } catch (error) {
          if (error?.name === "AbortError") {
            throw new Error("DNS timeout");
          }
          throw error;
        } finally {
          clearTimeout(timeoutId);
        }
      };
      const results = await Promise.allSettled([
        fetchWithTimeout(dohURLs.ipv4, 1, DNS_TIMEOUT),
        onlyIPv4 ? Promise.resolve([]) : fetchWithTimeout(dohURLs.ipv6, 28, DNS_TIMEOUT)
      ]);
      const ipv4 = results[0].status === "fulfilled" ? results[0].value : [];
      const ipv6 = results[1].status === "fulfilled" ? results[1].value : [];
      if (ipv4.length === 0 && ipv6.length === 0) {
        const err = results[0].status === "rejected" ? results[0].reason : new Error("No DNS records found");
        throw err;
      }
      const result = { ipv4, ipv6 };
      if (DNS_CACHE.size >= DNS_CACHE_MAX_SIZE) {
        const firstKey = DNS_CACHE.keys().next().value;
        DNS_CACHE.delete(firstKey);
      }
      DNS_CACHE.set(cacheKey, { data: result, timestamp: Date.now(), isFailure: false });
      return result;
    } catch (error) {
      const message2 = error instanceof Error ? error.message : String(error);
      if (cached && !cached.isFailure) return cached.data;
      if (DNS_CACHE.size >= DNS_CACHE_MAX_SIZE) {
        const firstKey = DNS_CACHE.keys().next().value;
        DNS_CACHE.delete(firstKey);
      }
      DNS_CACHE.set(cacheKey, { error: message2, timestamp: Date.now(), isFailure: true });
      throw new Error(`Error resolving DNS for ${domain}: ${message2}`);
    } finally {
      DNS_IN_FLIGHT.delete(cacheKey);
    }
  })();
  DNS_IN_FLIGHT.set(cacheKey, fetchPromise);
  return fetchPromise;
}
async function fetchDNSRecords(url, recordType, signal) {
  try {
    const response = await fetch(url, { headers: { accept: "application/dns-json" }, signal });
    if (!response.ok) {
      throw new Error(`DoH request failed with status ${response.status}`);
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number.parseInt(contentLength, 10) > MAX_DNS_RESPONSE_SIZE) {
      throw new Error(`DoH response too large: ${contentLength} bytes`);
    }
    const data = await response.json();
    if (!data.Answer) return [];
    return data.Answer.filter((record) => record.type === recordType).map((record) => record.data);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw error;
    }
    const message2 = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch DNS records from ${url}: ${message2}`);
  }
}
function getProtocols(ctx) {
  const {
    settings: { VLConfigs, TRConfigs },
    dict: { _VL_, _TR_ }
  } = ctx;
  return [].concatIf(VLConfigs, _VL_).concatIf(TRConfigs, _TR_);
}
async function getConfigAddresses(ctx, isFragment) {
  const {
    httpConfig: { hostName },
    settings: { enableIPv6, customCdnAddrs, cleanIPs }
  } = ctx;
  const { ipv4, ipv6 } = await resolveDNS(hostName, !enableIPv6, ctx.globalConfig.dohURL);
  const addrs = [
    hostName,
    "www.speedtest.net",
    ...ipv4,
    ...ipv6.map((ip) => `[${ip}]`),
    ...cleanIPs
  ];
  return addrs.concatIf(!isFragment, customCdnAddrs);
}
function generateRemark(ctx, index, port, address, protocol, isFragment, isChain) {
  const {
    settings: { cleanIPs, customCdnAddrs },
    dict: { _VL_, _VL_CAP_, _TR_CAP_ }
  } = ctx;
  const isCustomAddr = customCdnAddrs.includes(address);
  const configType = isCustomAddr ? " C" : isFragment ? " F" : "";
  const chainSign = isChain ? "\u{1F517} " : "";
  const protoSign = protocol === _VL_ ? _VL_CAP_ : _TR_CAP_;
  let addressType;
  cleanIPs.includes(address) ? addressType = "Clean IP" : addressType = isDomain(address) ? "Domain" : isIPv4(address) ? "IPv4" : isIPv6(address) ? "IPv6" : "";
  return `\u{1F4A6} ${index} - ${chainSign}${protoSign}${configType} - ${addressType} : ${port}`;
}
function randomUpperCase(str) {
  let result = "";
  for (let i = 0; i < str.length; i++) {
    result += Math.random() < 0.5 ? str[i].toUpperCase() : str[i];
  }
  return result;
}
function getRandomString(lengthMin, lengthMax) {
  let result = "";
  const charSet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const length = Math.floor(Math.random() * (lengthMax - lengthMin + 1)) + lengthMin;
  for (let i = 0; i < length; i++) {
    result += charSet.charAt(Math.floor(Math.random() * charSet.length));
  }
  return result;
}
function generateWsPath(ctx, protocol) {
  const {
    settings: { proxyIPMode, proxyIPs, prefixes },
    dict: { _VL_ }
  } = ctx;
  const config = {
    junk: getRandomString(8, 16),
    protocol: protocol === _VL_ ? "vl" : "tr",
    mode: proxyIPMode,
    panelIPs: proxyIPMode === "proxyip" ? proxyIPs : prefixes
  };
  return `/${toBase64Utf8(JSON.stringify(config))}`;
}
// Generate simple VLESS URI (ShareLink format)
function generateVlessUri(ctx, address, port, remark) {
  const {
    globalConfig: { userID },
    settings: { fingerprint }
  } = ctx;

  const isTLS = isHttps(ctx, port);
  const { host, sni, allowInsecure } = selectSniHost(ctx, address);
  const wsPath = `${generateWsPath(ctx, ctx.dict._VL_)}?ed=2560`;

  const params = new URLSearchParams({
    encryption: "none",
    security: isTLS ? "tls" : "none",
    type: "ws",
    host,
    path: wsPath
  });

  if (isTLS) {
    params.set("sni", sni);
    params.set("fp", fingerprint);
    if (allowInsecure) {
      params.set("allowInsecure", "1");
    }
  }

  const encodedRemark = encodeURIComponent(remark);

  return `vless://${userID}@${address}:${port}?${params.toString()}#${encodedRemark}`;
}

// Generate simple Trojan URI (ShareLink format)
function generateTrojanUri(ctx, address, port, remark) {
  const {
    globalConfig: { TrPass },
    settings: { fingerprint }
  } = ctx;

  const isTLS = isHttps(ctx, port);
  const { host, sni, allowInsecure } = selectSniHost(ctx, address);
  const wsPath = `${generateWsPath(ctx, ctx.dict._TR_)}?ed=2560`;

  const params = new URLSearchParams({
    security: isTLS ? "tls" : "none",
    type: "ws",
    host,
    path: wsPath
  });

  if (isTLS) {
    params.set("sni", sni);
    params.set("fp", fingerprint);
    if (allowInsecure) {
      params.set("allowInsecure", "1");
    }
  }

  const encodedPassword = encodeURIComponent(TrPass);
  const encodedRemark = encodeURIComponent(remark);

  return `trojan://${encodedPassword}@${address}:${port}?${params.toString()}#${encodedRemark}`;
}
function base64ToDecimal(base64) {
  const binaryString = atob(base64);
  const hexString = Array.from(binaryString).map((char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  const decimalArray = hexString.match(/.{2}/g).map((hex) => parseInt(hex, 16));
  return decimalArray;
}
function isIPv4(address) {
  const ipv4Pattern = /^(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?:\/([0-9]|[1-2][0-9]|3[0-2]))?$/;
  return ipv4Pattern.test(address);
}
function isIPv6(address) {
  const ipv6Pattern = /^\[(?:(?:[a-fA-F0-9]{1,4}:){7}[a-fA-F0-9]{1,4}|(?:[a-fA-F0-9]{1,4}:){1,7}:|::(?:[a-fA-F0-9]{1,4}:){0,7}|(?:[a-fA-F0-9]{1,4}:){1,6}:[a-fA-F0-9]{1,4}|(?:[a-fA-F0-9]{1,4}:){1,5}(?::[a-fA-F0-9]{1,4}){1,2}|(?:[a-fA-F0-9]{1,4}:){1,4}(?::[a-fA-F0-9]{1,4}){1,3}|(?:[a-fA-F0-9]{1,4}:){1,3}(?::[a-fA-F0-9]{1,4}){1,4}|(?:[a-fA-F0-9]{1,4}:){1,2}(?::[a-fA-F0-9]{1,4}){1,5}|[a-fA-F0-9]{1,4}:(?::[a-fA-F0-9]{1,4}){1,6})\](?:\/(1[0-1][0-9]|12[0-8]|[0-9]?[0-9]))?$/;
  return ipv6Pattern.test(address);
}
function getDomain(url) {
  try {
    const newUrl = new URL(url);
    const host = newUrl.hostname;
    const isHostDomain = isDomain(host);
    return {
      host,
      isHostDomain
    };
  } catch {
    return {
      host: "",
      isHostDomain: false
    };
  }
}
function selectSniHost(ctx, address) {
  const {
    httpConfig: { hostName },
    settings: { customCdnAddrs, customCdnHost, customCdnSni }
  } = ctx;
  const isCustomAddr = customCdnAddrs.includes(address);
  const sni = isCustomAddr ? customCdnSni : randomUpperCase(hostName);
  const host = isCustomAddr ? customCdnHost : hostName;
  return { host, sni, allowInsecure: isCustomAddr };
}
function parseHostPort(input, brackets) {
  const regex = /^(?:\[(?<ipv6>.+?)\]|(?<host>[^:]+))(:(?<port>\d+))?$/;
  const match = input.match(regex);
  if (!match || !match.groups) return { host: "", port: 0 };
  const { ipv6, host: plainHost, port: portStr } = match.groups;
  let host = ipv6 ?? plainHost ?? "";
  if (brackets && ipv6) host = `[${ipv6}]`;
  const port = portStr ? Number(portStr) : 0;
  return { host, port };
}
function isHttps(ctx, port) {
  const { defaultHttpsPorts } = ctx.httpConfig;
  return defaultHttpsPorts.includes(port);
}
var isBypass = (type) => type === "direct";
var isBlock = (type) => type === "block";
function accRoutingRules(ctx, geoAssets) {
  const {
    customBypassRules,
    customBypassSanctionRules,
    customBlockRules
  } = ctx.settings;
  return {
    bypass: {
      geosites: geoAssets.filter((rule) => isBypass(rule.type)).map((rule) => rule.geosite),
      geoips: geoAssets.filter((rule) => isBypass(rule.type) && rule.geoip).map((rule) => rule.geoip),
      domains: [
        ...customBypassRules.filter(isDomain),
        ...customBypassSanctionRules.filter(isDomain)
      ],
      ips: customBypassRules.filter((rule) => !isDomain(rule))
    },
    block: {
      geosites: geoAssets.filter((rule) => isBlock(rule.type)).map((rule) => rule.geosite),
      geoips: geoAssets.filter((rule) => isBlock(rule.type) && rule.geoip).map((rule) => rule.geoip),
      domains: customBlockRules.filter(isDomain),
      ips: customBlockRules.filter((rule) => !isDomain(rule))
    }
  };
}
function accDnsRules(ctx, geoAssets) {
  const {
    localDNS,
    antiSanctionDNS,
    customBypassRules,
    customBypassSanctionRules,
    customBlockRules
  } = ctx.settings;
  return {
    bypass: {
      localDNS: {
        geositeGeoips: geoAssets.filter(({ type, geoip, dns }) => isBypass(type) && geoip && dns === localDNS).map(({ geosite, geoip }) => ({ geosite, geoip })),
        geosites: geoAssets.filter(({ type, geoip, dns }) => isBypass(type) && !geoip && dns === localDNS).map((rule) => rule.geosite),
        domains: customBypassRules.filter(isDomain)
      },
      antiSanctionDNS: {
        geosites: geoAssets.filter((rule) => isBypass(rule.type) && rule.dns === antiSanctionDNS).map((rule) => rule.geosite),
        domains: customBypassSanctionRules.filter(isDomain)
      }
    },
    block: {
      geosites: geoAssets.filter((rule) => isBlock(rule.type)).map((rule) => rule.geosite),
      domains: customBlockRules.filter(isDomain)
    }
  };
}
function toRange(min, max) {
  if (!min || !max) return void 0;
  if (min === max) return String(min);
  return `${min}-${max}`;
}
Array.prototype.concatIf = function (condition, concat2) {
  if (!condition) return this;
  if (Array.isArray(concat2)) return [...this, ...concat2];
  return [...this, concat2];
};
Object.prototype.omitEmpty = function () {
  if (Object.keys(this).length === 0) return void 0;
  return this;
};

// src/common/common.ts
function base64DecodeUtf8(base64) {
  return new TextDecoder().decode(
    Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  );
}
function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}
function respond(success, status, message2, body, customHeaders) {
  const headers = {
    "Content-Type": "application/json",
    ...customHeaders
  };
  const responseBody = {
    success,
    status,
    message: message2 ?? null,
    body: body ?? null
  };
  return new Response(JSON.stringify(responseBody), { status, headers });
}

// src/kv.ts
async function getDataset(request, env, context) {
  const { panelVersion: currentPanelVersion } = DEFAULT_SETTINGS;
  
  try {
    // PERFORMANCE FIX: Use cache instead of KV every time
    const [proxySettings, warpAccounts] = await Promise.all([
      // Cache proxySettings
      getCachedData(
        SETTINGS_CACHE,
        async () => {
          const settingsData = await env.kv.get("proxySettings");
          if (settingsData) {
            try {
              const parsed = JSON.parse(settingsData);
              // Merge with defaults for new fields
              return { ...DEFAULT_SETTINGS, ...parsed };
            } catch (e) {
              console.error("JSON parse failed for proxySettings, using defaults");
              return DEFAULT_SETTINGS;
            }
          } else {
            console.log("No proxySettings in KV, initializing with defaults");
            const defaults = DEFAULT_SETTINGS;
            
            // Save defaults to KV (non-blocking, best effort)
            saveDataset(env, "proxySettings", defaults).catch(err => 
              console.error('Failed to initialize proxySettings:', err)
            );
            
            return defaults;
          }
        },
        'proxySettings',
        context
      ),
      
      // Cache warpAccounts
      getCachedData(
        WARP_CACHE,
        async () => {
          const warpData = await env.kv.get("warpAccounts");
          if (warpData) {
            try {
              return JSON.parse(warpData);
            } catch (e) {
              console.error("JSON parse failed for warpAccounts, re-fetching");
              return await fetchWarpAccounts(env);
            }
          } else {
            console.log("No warpAccounts in KV, fetching fresh");
            return await fetchWarpAccounts(env);
          }
        },
        'warpAccounts',
        context
      )
    ]);

    // Version check & migration
    if (currentPanelVersion !== proxySettings.panelVersion) {
      console.log(`Panel version mismatch: ${proxySettings.panelVersion} -> ${currentPanelVersion}`);
      const updated = await updateDataset(request, env);
      
      // Invalidate cache after migration
      invalidateCache();
      
      return {
        settings: updated,
        warpAccounts
      };
    }

    return {
      settings: proxySettings,
      warpAccounts
    };
    
  } catch (error) {
    console.error("Critical cache/KV failure, using emergency defaults:", error);
    
    // Emergency fallback
    return { 
      settings: DEFAULT_SETTINGS,
      warpAccounts: []
    };
  }
}

// Safe KV write with retry helper
async function saveDataset(env, key, data, retries = 2) {
  const value = typeof data === 'string' ? data : JSON.stringify(data);
  for (let i = 0; i <= retries; i++) {
    try {
      await env.kv.put(key, value);
      return true;
    } catch (error) {
      if (i === retries) {
        console.error(`Failed to save to KV (${key}) after retries:`, error);
        return false;
      }
      // Exponential backoff
      await new Promise(r => setTimeout(r, 100 * (i + 1)));
    }
  }
}
async function updateDataset(request, env) {
  const settings = DEFAULT_SETTINGS;
  const { panelVersion } = DEFAULT_SETTINGS;
  const { hostname: hostName } = new URL(request.url);
  const newSettings = request.method === "PUT" ? await request.json() : null;
  let currentSettings;
  try {
    currentSettings = await env.kv.get("proxySettings", { type: "json" });
  } catch (error) {
    const message2 = error instanceof Error ? error.message : String(error);
    console.log(message2);
    throw new Error(`An error occurred while getting current KV settings: ${message2}`);
  }
  const getParam = async (field, callback) => {
    const value = newSettings?.[field] ?? currentSettings?.[field] ?? settings[field];
    return callback ? await callback(value) : value;
  };
  const fields = [
    ["remoteDNS"],
    ["remoteDnsHost", "remoteDNS", getDnsParams],
    ["localDNS"],
    ["antiSanctionDNS"],
    ["enableIPv6"],
    ["fakeDNS"],
    ["logLevel"],
    ["allowLANConnection"],
    ["proxyIPMode"],
    ["proxyIPs"],
    ["prefixes"],
    ["outProxy"],
    ["outProxyParams", "outProxy", extractProxyParams],
    ["cleanIPs"],
    ["customCdnAddrs"],
    ["customCdnHost"],
    ["customCdnSni"],
    ["bestVLTRInterval"],
    ["VLConfigs"],
    ["TRConfigs"],
    ["ports"],
    ["fingerprint"],
    ["enableTFO"],
    ["fragmentMode"],
    ["fragmentLengthMin"],
    ["fragmentLengthMax"],
    ["fragmentIntervalMin"],
    ["fragmentIntervalMax"],
    ["fragmentMaxSplitMin"],
    ["fragmentMaxSplitMax"],
    ["fragmentPackets"],
    ["enableECH"],
    ["echConfig", "enableECH", (val) => extractEchConfig(val, hostName)],
    ["bypassIran"],
    ["bypassChina"],
    ["bypassRussia"],
    ["bypassOpenAi"],
    ["bypassGoogleAi"],
    ["bypassMicrosoft"],
    ["bypassOracle"],
    ["bypassDocker"],
    ["bypassAdobe"],
    ["bypassEpicGames"],
    ["bypassIntel"],
    ["bypassAmd"],
    ["bypassNvidia"],
    ["bypassAsus"],
    ["bypassHp"],
    ["bypassLenovo"],
    ["blockAds"],
    ["blockPorn"],
    ["blockUDP443"],
    ["blockMalware"],
    ["blockPhishing"],
    ["blockCryptominers"],
    ["customBypassRules"],
    ["customBlockRules"],
    ["customBypassSanctionRules"],
    ["warpRemoteDNS"],
    ["warpEndpoints"],
    ["bestWarpInterval"],
    ["xrayUdpNoises"],
    ["knockerNoiseMode"],
    ["noiseCountMin"],
    ["noiseCountMax"],
    ["noiseSizeMin"],
    ["noiseSizeMax"],
    ["noiseDelayMin"],
    ["noiseDelayMax"],
    ["amneziaNoiseCount"],
    ["amneziaNoiseSizeMin"],
    ["amneziaNoiseSizeMax"]
  ];
  const entries = await Promise.all(
    fields.map(async ([key, callbackKey, callbackFunc]) => {
      return [key, await getParam(callbackKey ?? key, callbackFunc)];
    })
  );
  const updatedSettings = {
    ...Object.fromEntries(entries),
    panelVersion
  };
  
  const success = await saveDataset(env, "proxySettings", updatedSettings);
  if (!success) {
    throw new Error("Failed to update KV settings after multiple retries.");
  }
  invalidateCache();
  return updatedSettings;
}
async function getDnsParams(dns) {
  const { host, isHostDomain } = getDomain(dns);
  const dohHost = { host, isDomain: isHostDomain, ipv4: [], ipv6: [] };
  if (isHostDomain) {
    const dohURL = globalThis.globalConfig?.dohURL || "https://cloudflare-dns.com/dns-query";
    const { ipv4, ipv6 } = await resolveDNS(host, false, dohURL);
    dohHost.ipv4 = ipv4;
    dohHost.ipv6 = ipv6;
  }
  return dohHost;
}
function extractProxyParams(chainProxy) {
  if (!chainProxy) return {};
  const { _SS_, _TR_, _VL_, _VM_ } = DICT;
  let url = new URL(chainProxy);
  const protocol = url.protocol.slice(0, -1);
  const stdProtocol = protocol === "ss" ? _SS_ : protocol.replace("socks5", "socks");
  if (stdProtocol === _VM_) {
    const config = JSON.parse(base64DecodeUtf8(url.host));
    return {
      protocol: stdProtocol,
      uuid: config.id,
      server: config.add,
      port: +config.port,
      aid: +config.aid,
      type: config.net,
      headerType: config.type,
      serviceName: config.path,
      authority: config.authority,
      path: config.path || void 0,
      host: config.host || void 0,
      security: config.tls,
      sni: config.sni,
      fp: config.fp,
      alpn: config.alpn || void 0
    };
  }
  const configParams = {
    protocol: stdProtocol,
    server: url.hostname,
    port: +url.port
  };
  const parseParams = (queryParams, customParams) => {
    if (queryParams) {
      for (const [key, value] of url.searchParams) {
        configParams[key] = value || void 0;
      }
    }
    return {
      ...configParams,
      ...customParams
    };
  };
  switch (stdProtocol) {
    case _VL_:
      return parseParams(true, {
        uuid: url.username
      });
    case _TR_:
      return parseParams(true, {
        password: url.username
      });
    case _SS_:
      const auth = base64DecodeUtf8(url.username);
      const [first, ...rest] = auth.split(":");
      return parseParams(true, {
        method: first,
        password: rest.join(":")
      });
    case "socks":
    case "http":
      let user, pass;
      try {
        const userInfo = base64DecodeUtf8(url.username);
        if (userInfo.includes(":")) [user, pass] = userInfo.split(":");
      } catch (error) {
        user = url.username;
        pass = url.password;
      }
      return parseParams(false, {
        user: user || void 0,
        pass: pass || void 0
      });
    default:
      return {};
  }
}
async function extractEchConfig(enableECH, hostName) {
  if (!enableECH) return "";
  // const { httpConfig: { hostName } } = globalThis; // Removed
  const url = new URL("https://dns.google/resolve");
  url.searchParams.set("name", hostName);
  url.searchParams.set("type", "HTTPS");
  const res = await fetch(url.toString(), {
    headers: { accept: "application/dns-json" }
  });
  const dns = await res.json();
  if (!dns.Answer || !Array.isArray(dns.Answer)) return "";
  for (const ans of dns.Answer) {
    const ech = ans.data.match(/ech=([^ ]+)/)?.[1];
    if (ech) return ech;
  }
  throw new Error("ECH record not found");
}

// src/common/init.ts
const DICT = {
  _VL_: atob("dmxlc3M="),
  _VL_CAP_: atob("VkxFU1M="),
  _VM_: atob("dm1lc3M="),
  _TR_: atob("dHJvamFu"),
  _TR_CAP_: atob("VHJvamFu"),
  _SS_: atob("c2hhZG93c29ja3M="),
  _V2_: atob("djJyYXk="),
  _project_: atob("QlBC"),
  _website_: atob("aHR0cHM6Ly9iaWEtcGFpbi1iYWNoZS5naXRodWIuaW8vQlBCLVdvcmtlci1QYW5lbC8="),
  _public_proxy_ip_: atob("YnBiLnlvdXNlZi5pc2VnYXJvLmNvbQ==")
};
const DEFAULT_SETTINGS = {
  localDNS: "8.8.8.8",
  antiSanctionDNS: "178.22.122.100",
  fakeDNS: false,
  enableIPv6: true,
  allowLANConnection: false,
  logLevel: "warning",
  remoteDNS: "https://8.8.8.8/dns-query",
  remoteDnsHost: {
    host: "8.8.8.8",
    isDomain: false,
    ipv4: [],
    ipv6: []
  },
  proxyIPMode: "proxyip",
  proxyIPs: [],
  prefixes: [],
  outProxy: "",
  outProxyParams: {},
  cleanIPs: [],
  customCdnAddrs: [],
  customCdnHost: "",
  customCdnSni: "",
  bestVLTRInterval: 30,
  VLConfigs: true,
  TRConfigs: true,
  ports: [443],
  fingerprint: "chrome",
  enableTFO: false,
  fragmentMode: "custom",
  fragmentLengthMin: 100,
  fragmentLengthMax: 200,
  fragmentIntervalMin: 1,
  fragmentIntervalMax: 1,
  fragmentMaxSplitMin: void 0,
  fragmentMaxSplitMax: void 0,
  fragmentPackets: "tlshello",
  enableECH: false,
  echConfig: "",
  bypassIran: false,
  bypassChina: false,
  bypassRussia: false,
  bypassOpenAi: false,
  bypassGoogleAi: false,
  bypassMicrosoft: false,
  bypassOracle: false,
  bypassDocker: false,
  bypassAdobe: false,
  bypassEpicGames: false,
  bypassIntel: false,
  bypassAmd: false,
  bypassNvidia: false,
  bypassAsus: false,
  bypassHp: false,
  bypassLenovo: false,
  blockAds: false,
  blockPorn: false,
  blockUDP443: false,
  blockMalware: false,
  blockPhishing: false,
  blockCryptominers: false,
  customBypassRules: [],
  customBlockRules: [],
  customBypassSanctionRules: [],
  warpRemoteDNS: "1.1.1.1",
  warpEndpoints: ["engage.cloudflareclient.com:2408"],
  bestWarpInterval: 30,
  xrayUdpNoises: [
    {
      type: "rand",
      packet: "50-100",
      delay: "1-1",
      applyTo: "ip",
      count: 5
    }
  ],
  knockerNoiseMode: "quic",
  noiseCountMin: 10,
  noiseCountMax: 15,
  noiseSizeMin: 5,
  noiseSizeMax: 10,
  noiseDelayMin: 1,
  noiseDelayMax: 1,
  amneziaNoiseCount: 5,
  amneziaNoiseSizeMin: 50,
  amneziaNoiseSizeMax: 100,
  panelVersion: "4.1.0"
};

const GEO_RULES = [
  {
    name: 'blockMalware',
    type: 'block',
    clash: { geosite: "malware", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-clash-rules/release/malware.txt", geoip: "malware-cidr", geoipURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-clash-rules/release/malware-ip.txt", format: "text" },
    singbox: { geosite: "geosite-malware", geoip: "geoip-malware", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-malware.srs", geoipURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geoip-malware.srs" },
    xray: { geosite: "geosite:malware", geoip: "geoip:malware" }
  },
  {
    name: 'blockPhishing',
    type: 'block',
    clash: { geosite: "phishing", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-clash-rules/release/phishing.txt", geoip: "phishing-cidr", geoipURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-clash-rules/release/phishing-ip.txt", format: "text" },
    singbox: { geosite: "geosite-phishing", geoip: "geoip-phishing", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-phishing.srs", geoipURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geoip-phishing.srs" },
    xray: { geosite: "geosite:phishing", geoip: "geoip:phishing" }
  },
  {
    name: 'blockCryptominers',
    type: 'block',
    clash: { geosite: "cryptominers", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-clash-rules/release/cryptominers.txt", format: "text" },
    singbox: { geosite: "geosite-cryptominers", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-cryptominers.srs" },
    xray: { geosite: "geosite:cryptominers" }
  },
  {
    name: 'blockAds',
    type: 'block',
    clash: { geosite: "category-ads-all", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-clash-rules/release/category-ads-all.txt", format: "text" },
    singbox: { geosite: "geosite-category-ads-all", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-category-ads-all.srs" },
    xray: [
      { geosite: "geosite:category-ads-all" },
      { geosite: "geosite:category-ads-ir" }
    ]
  },
  {
    name: 'blockPorn',
    type: 'block',
    clash: { geosite: "nsfw", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-clash-rules/release/nsfw.txt", format: "text" },
    singbox: { geosite: "geosite-nsfw", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-nsfw.srs" },
    xray: { geosite: "geosite:category-porn" }
  },
  {
    name: 'bypassIran',
    type: 'direct',
    useLocalDNS: true,
    clash: { geosite: "ir", geoip: "ir-cidr", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-clash-rules/release/ir.txt", geoipURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-clash-rules/release/ircidr.txt", format: "text" },
    singbox: { geosite: "geosite-ir", geoip: "geoip-ir", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-ir.srs", geoipURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geoip-ir.srs" },
    xray: { geosite: "geosite:category-ir", geoip: "geoip:ir" }
  },
  {
    name: 'bypassChina',
    type: 'direct',
    useLocalDNS: true,
    clash: { geosite: "cn", geoip: "cn-cidr", geositeURL: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/cn.yaml", geoipURL: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geoip/cn.yaml", format: "yaml" },
    singbox: { geosite: "geosite-cn", geoip: "geoip-cn", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-cn.srs", geoipURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geoip-cn.srs" },
    xray: { geosite: "geosite:cn", geoip: "geoip:cn" }
  },
  {
    name: 'bypassRussia',
    type: 'direct',
    useLocalDNS: true,
    clash: { geosite: "ru", geoip: "ru-cidr", geositeURL: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/category-ru.yaml", geoipURL: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geoip/ru.yaml", format: "yaml" },
    singbox: { geosite: "geosite-category-ru", geoip: "geoip-ru", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-category-ru.srs", geoipURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geoip-ru.srs" },
    xray: { geosite: "geosite:category-ru", geoip: "geoip:ru" }
  },
  {
    name: 'bypassOpenAi',
    type: 'direct',
    useAntiSanctionDNS: true,
    clash: { geosite: "openai", geositeURL: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/openai.yaml", format: "yaml" },
    singbox: { geosite: "geosite-openai", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-openai.srs" },
    xray: { geosite: "geosite:openai" }
  },
  {
    name: 'bypassGoogleAi',
    type: 'direct',
    useAntiSanctionDNS: true,
    clash: { geosite: "googleai", geositeURL: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/google-deepmind.yaml", format: "yaml" },
    singbox: { geosite: "geosite-google-deepmind", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-google-deepmind.srs" },
    xray: { geosite: "geosite:google-deepmind" }
  },
  {
    name: 'bypassMicrosoft',
    type: 'direct',
    useAntiSanctionDNS: true,
    clash: { geosite: "microsoft", geositeURL: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/microsoft.yaml", format: "yaml" },
    singbox: { geosite: "geosite-microsoft", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-microsoft.srs" },
    xray: { geosite: "geosite:microsoft" }
  },
  {
    name: 'bypassOracle',
    type: 'direct',
    useAntiSanctionDNS: true,
    clash: { geosite: "oracle", geositeURL: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/oracle.yaml", format: "yaml" },
    singbox: { geosite: "geosite-oracle", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-oracle.srs" },
    xray: { geosite: "geosite:oracle" }
  },
  {
    name: 'bypassDocker',
    type: 'direct',
    useAntiSanctionDNS: true,
    clash: { geosite: "docker", geositeURL: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/docker.yaml", format: "yaml" },
    singbox: { geosite: "geosite-docker", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-docker.srs" },
    xray: { geosite: "geosite:docker" }
  },
  {
    name: 'bypassAdobe',
    type: 'direct',
    useAntiSanctionDNS: true,
    clash: { geosite: "adobe", geositeURL: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/adobe.yaml", format: "yaml" },
    singbox: { geosite: "geosite-adobe", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-adobe.srs" },
    xray: { geosite: "geosite:adobe" }
  },
  {
    name: 'bypassEpicGames',
    type: 'direct',
    useAntiSanctionDNS: true,
    clash: { geosite: "epicgames", geositeURL: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/epicgames.yaml", format: "yaml" },
    singbox: { geosite: "geosite-epicgames", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-epicgames.srs" },
    xray: { geosite: "geosite:epicgames" }
  },
  {
    name: 'bypassIntel',
    type: 'direct',
    useAntiSanctionDNS: true,
    clash: { geosite: "intel", geositeURL: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/intel.yaml", format: "yaml" },
    singbox: { geosite: "geosite-intel", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-intel.srs" },
    xray: { geosite: "geosite:intel" }
  },
  {
    name: 'bypassAmd',
    type: 'direct',
    useAntiSanctionDNS: true,
    clash: { geosite: "amd", geositeURL: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/amd.yaml", format: "yaml" },
    singbox: { geosite: "geosite-amd", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-amd.srs" },
    xray: { geosite: "geosite:amd" }
  },
  {
    name: 'bypassNvidia',
    type: 'direct',
    useAntiSanctionDNS: true,
    clash: { geosite: "nvidia", geositeURL: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/nvidia.yaml", format: "yaml" },
    singbox: { geosite: "geosite-nvidia", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-nvidia.srs" },
    xray: { geosite: "geosite:nvidia" }
  },
  {
    name: 'bypassAsus',
    type: 'direct',
    useAntiSanctionDNS: true,
    clash: { geosite: "asus", geositeURL: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/asus.yaml", format: "yaml" },
    singbox: { geosite: "geosite-asus", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-asus.srs" },
    xray: { geosite: "geosite:asus" }
  },
  {
    name: 'bypassHp',
    type: 'direct',
    useAntiSanctionDNS: true,
    clash: { geosite: "hp", geositeURL: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/hp.yaml", format: "yaml" },
    singbox: { geosite: "geosite-hp", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-hp.srs" },
    xray: { geosite: "geosite:hp" }
  },
  {
    name: 'bypassLenovo',
    type: 'direct',
    useAntiSanctionDNS: true,
    clash: { geosite: "lenovo", geositeURL: "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/lenovo.yaml", format: "yaml" },
    singbox: { geosite: "geosite-lenovo", geositeURL: "https://raw.githubusercontent.com/Chocolate4U/Iran-sing-box-rules/rule-set/geosite-lenovo.srs" },
    xray: { geosite: "geosite:lenovo" }
  }
];

function getGeoAssetsShared(ctx, format) {
  const { localDNS, antiSanctionDNS } = ctx.settings;
  const result = [];
  
  GEO_RULES.forEach(rule => {
    if (ctx.settings[rule.name]) {
      const formatData = rule[format];
      const items = Array.isArray(formatData) ? formatData : [formatData];
      
      items.forEach(item => {
        const entry = {
          rule: true,
          type: rule.type,
          ...item
        };
        
        if (rule.useLocalDNS) entry.dns = localDNS;
        if (rule.useAntiSanctionDNS) entry.dns = antiSanctionDNS;
        
        result.push(entry);
      });
    }
  });
  
  return result;
}

async function loadSettings(request, env, context) {
  const dataset = await getDataset(request, env, context);
  return dataset.settings;
}
function createGlobalConfig(request, env) {
  const { pathname } = new URL(request.url);
  const { UUID, TR_PASS, FALLBACK, DOH_URL } = env;
  return {
    userID: UUID,
    TrPass: TR_PASS,
    pathName: decodeURIComponent(pathname),
    fallbackDomain: FALLBACK || "speed.cloudflare.com",
    dohURL: DOH_URL || "https://cloudflare-dns.com/dns-query"
  };
}
function createWsConfig(env) {
  const { _public_proxy_ip_ } = DICT;
  return {
    envProxyIPs: env.PROXY_IP,
    envPrefixes: env.PREFIX,
    defaultProxyIPs: [_public_proxy_ip_],
    defaultPrefixes: [
      "[2a02:898:146:64::]",
      "[2602:fc59:b0:64::]",
      "[2602:fc59:11:64::]"
    ]
  };
}
function createHttpConfig(request, env) {
  const { _VL_CAP_, _TR_CAP_, _website_ } = DICT;
  const { UUID, TR_PASS, SUB_PATH, kv } = env;
  const { pathname, origin, searchParams, hostname } = new URL(request.url);
  if (!["/secrets", "/favicon.ico"].includes(decodeURIComponent(pathname))) {
    if (!UUID || !TR_PASS) throw new Error(`Please set ${_VL_CAP_} UUID and ${_TR_CAP_} password first. Visit <a href="${origin}/secrets" target="_blank">here</a> to generate them.`, { cause: "init" });
    if (!isValidUUID(UUID)) throw new Error(`Invalid UUID: ${UUID}`, { cause: "init" });
    if (typeof kv !== "object") throw new Error(`KV Dataset is not properly set! Please refer to <a href="${_website_}" target="_blank">tutorials</a>.`, { cause: "init" });
  }
  return {
    panelVersion: "4.1.0",
    defaultHttpPorts: [80, 8080, 2052, 2082, 2086, 2095, 8880],
    defaultHttpsPorts: [443, 8443, 2053, 2083, 2087, 2096],
    hostName: hostname,
    client: decodeURIComponent(searchParams.get("app") ?? ""),
    urlOrigin: origin,
    subPath: SUB_PATH || UUID
  };
}

// node_modules/jose/dist/webapi/lib/buffer_utils.js
var encoder = new TextEncoder();
var decoder = new TextDecoder();
var MAX_INT32 = 2 ** 32;
function concat(...buffers) {
  const size = buffers.reduce((acc, { length }) => acc + length, 0);
  const buf = new Uint8Array(size);
  let i = 0;
  for (const buffer of buffers) {
    buf.set(buffer, i);
    i += buffer.length;
  }
  return buf;
}
function encode(string) {
  const bytes = new Uint8Array(string.length);
  for (let i = 0; i < string.length; i++) {
    const code = string.charCodeAt(i);
    if (code > 127) {
      throw new TypeError("non-ASCII string encountered in encode()");
    }
    bytes[i] = code;
  }
  return bytes;
}

// node_modules/jose/dist/webapi/lib/base64.js
function encodeBase64(input) {
  if (Uint8Array.prototype.toBase64) {
    return input.toBase64();
  }
  const CHUNK_SIZE = 32768;
  const arr = [];
  for (let i = 0; i < input.length; i += CHUNK_SIZE) {
    arr.push(String.fromCharCode.apply(null, input.subarray(i, i + CHUNK_SIZE)));
  }
  return btoa(arr.join(""));
}
function decodeBase64(encoded) {
  if (Uint8Array.fromBase64) {
    return Uint8Array.fromBase64(encoded);
  }
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// node_modules/jose/dist/webapi/util/base64url.js
function decode(input) {
  if (Uint8Array.fromBase64) {
    return Uint8Array.fromBase64(typeof input === "string" ? input : decoder.decode(input), {
      alphabet: "base64url"
    });
  }
  let encoded = input;
  if (encoded instanceof Uint8Array) {
    encoded = decoder.decode(encoded);
  }
  encoded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return decodeBase64(encoded);
  } catch {
    throw new TypeError("The input to be decoded is not correctly encoded.");
  }
}
function encode2(input) {
  let unencoded = input;
  if (typeof unencoded === "string") {
    unencoded = encoder.encode(unencoded);
  }
  if (Uint8Array.prototype.toBase64) {
    return unencoded.toBase64({ alphabet: "base64url", omitPadding: true });
  }
  return encodeBase64(unencoded).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// node_modules/jose/dist/webapi/util/errors.js
var JOSEError = class extends Error {
  static code = "ERR_JOSE_GENERIC";
  code = "ERR_JOSE_GENERIC";
  constructor(message2, options) {
    super(message2, options);
    this.name = this.constructor.name;
    Error.captureStackTrace?.(this, this.constructor);
  }
};
var JWTClaimValidationFailed = class extends JOSEError {
  static code = "ERR_JWT_CLAIM_VALIDATION_FAILED";
  code = "ERR_JWT_CLAIM_VALIDATION_FAILED";
  claim;
  reason;
  payload;
  constructor(message2, payload, claim = "unspecified", reason = "unspecified") {
    super(message2, { cause: { claim, reason, payload } });
    this.claim = claim;
    this.reason = reason;
    this.payload = payload;
  }
};
var JWTExpired = class extends JOSEError {
  static code = "ERR_JWT_EXPIRED";
  code = "ERR_JWT_EXPIRED";
  claim;
  reason;
  payload;
  constructor(message2, payload, claim = "unspecified", reason = "unspecified") {
    super(message2, { cause: { claim, reason, payload } });
    this.claim = claim;
    this.reason = reason;
    this.payload = payload;
  }
};
var JOSEAlgNotAllowed = class extends JOSEError {
  static code = "ERR_JOSE_ALG_NOT_ALLOWED";
  code = "ERR_JOSE_ALG_NOT_ALLOWED";
};
var JOSENotSupported = class extends JOSEError {
  static code = "ERR_JOSE_NOT_SUPPORTED";
  code = "ERR_JOSE_NOT_SUPPORTED";
};
var JWSInvalid = class extends JOSEError {
  static code = "ERR_JWS_INVALID";
  code = "ERR_JWS_INVALID";
};
var JWTInvalid = class extends JOSEError {
  static code = "ERR_JWT_INVALID";
  code = "ERR_JWT_INVALID";
};
var JWSSignatureVerificationFailed = class extends JOSEError {
  static code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
  constructor(message2 = "signature verification failed", options) {
    super(message2, options);
  }
};

// node_modules/jose/dist/webapi/lib/crypto_key.js
var unusable = (name, prop = "algorithm.name") => new TypeError(`CryptoKey does not support this operation, its ${prop} must be ${name}`);
var isAlgorithm = (algorithm, name) => algorithm.name === name;
function getHashLength(hash) {
  return parseInt(hash.name.slice(4), 10);
}
function getNamedCurve(alg) {
  switch (alg) {
    case "ES256":
      return "P-256";
    case "ES384":
      return "P-384";
    case "ES512":
      return "P-521";
    default:
      throw new Error("unreachable");
  }
}
function checkUsage(key, usage) {
  if (usage && !key.usages.includes(usage)) {
    throw new TypeError(`CryptoKey does not support this operation, its usages must include ${usage}.`);
  }
}
function checkSigCryptoKey(key, alg, usage) {
  switch (alg) {
    case "HS256":
    case "HS384":
    case "HS512": {
      if (!isAlgorithm(key.algorithm, "HMAC"))
        throw unusable("HMAC");
      const expected = parseInt(alg.slice(2), 10);
      const actual = getHashLength(key.algorithm.hash);
      if (actual !== expected)
        throw unusable(`SHA-${expected}`, "algorithm.hash");
      break;
    }
    case "RS256":
    case "RS384":
    case "RS512": {
      if (!isAlgorithm(key.algorithm, "RSASSA-PKCS1-v1_5"))
        throw unusable("RSASSA-PKCS1-v1_5");
      const expected = parseInt(alg.slice(2), 10);
      const actual = getHashLength(key.algorithm.hash);
      if (actual !== expected)
        throw unusable(`SHA-${expected}`, "algorithm.hash");
      break;
    }
    case "PS256":
    case "PS384":
    case "PS512": {
      if (!isAlgorithm(key.algorithm, "RSA-PSS"))
        throw unusable("RSA-PSS");
      const expected = parseInt(alg.slice(2), 10);
      const actual = getHashLength(key.algorithm.hash);
      if (actual !== expected)
        throw unusable(`SHA-${expected}`, "algorithm.hash");
      break;
    }
    case "Ed25519":
    case "EdDSA": {
      if (!isAlgorithm(key.algorithm, "Ed25519"))
        throw unusable("Ed25519");
      break;
    }
    case "ML-DSA-44":
    case "ML-DSA-65":
    case "ML-DSA-87": {
      if (!isAlgorithm(key.algorithm, alg))
        throw unusable(alg);
      break;
    }
    case "ES256":
    case "ES384":
    case "ES512": {
      if (!isAlgorithm(key.algorithm, "ECDSA"))
        throw unusable("ECDSA");
      const expected = getNamedCurve(alg);
      const actual = key.algorithm.namedCurve;
      if (actual !== expected)
        throw unusable(expected, "algorithm.namedCurve");
      break;
    }
    default:
      throw new TypeError("CryptoKey does not support this operation");
  }
  checkUsage(key, usage);
}

// node_modules/jose/dist/webapi/lib/invalid_key_input.js
function message(msg, actual, ...types) {
  types = types.filter(Boolean);
  if (types.length > 2) {
    const last = types.pop();
    msg += `one of type ${types.join(", ")}, or ${last}.`;
  } else if (types.length === 2) {
    msg += `one of type ${types[0]} or ${types[1]}.`;
  } else {
    msg += `of type ${types[0]}.`;
  }
  if (actual == null) {
    msg += ` Received ${actual}`;
  } else if (typeof actual === "function" && actual.name) {
    msg += ` Received function ${actual.name}`;
  } else if (typeof actual === "object" && actual != null) {
    if (actual.constructor?.name) {
      msg += ` Received an instance of ${actual.constructor.name}`;
    }
  }
  return msg;
}
var invalidKeyInput = (actual, ...types) => message("Key must be ", actual, ...types);
var withAlg = (alg, actual, ...types) => message(`Key for the ${alg} algorithm must be `, actual, ...types);

// node_modules/jose/dist/webapi/lib/is_key_like.js
var isCryptoKey = (key) => {
  if (key?.[Symbol.toStringTag] === "CryptoKey")
    return true;
  try {
    return key instanceof CryptoKey;
  } catch {
    return false;
  }
};
var isKeyObject = (key) => key?.[Symbol.toStringTag] === "KeyObject";
var isKeyLike = (key) => isCryptoKey(key) || isKeyObject(key);

// node_modules/jose/dist/webapi/lib/is_disjoint.js
function isDisjoint(...headers) {
  const sources = headers.filter(Boolean);
  if (sources.length === 0 || sources.length === 1) {
    return true;
  }
  let acc;
  for (const header of sources) {
    const parameters = Object.keys(header);
    if (!acc || acc.size === 0) {
      acc = new Set(parameters);
      continue;
    }
    for (const parameter of parameters) {
      if (acc.has(parameter)) {
        return false;
      }
      acc.add(parameter);
    }
  }
  return true;
}

// node_modules/jose/dist/webapi/lib/is_object.js
var isObjectLike = (value) => typeof value === "object" && value !== null;
function isObject(input) {
  if (!isObjectLike(input) || Object.prototype.toString.call(input) !== "[object Object]") {
    return false;
  }
  if (Object.getPrototypeOf(input) === null) {
    return true;
  }
  let proto = input;
  while (Object.getPrototypeOf(proto) !== null) {
    proto = Object.getPrototypeOf(proto);
  }
  return Object.getPrototypeOf(input) === proto;
}

// node_modules/jose/dist/webapi/lib/check_key_length.js
function checkKeyLength(alg, key) {
  if (alg.startsWith("RS") || alg.startsWith("PS")) {
    const { modulusLength } = key.algorithm;
    if (typeof modulusLength !== "number" || modulusLength < 2048) {
      throw new TypeError(`${alg} requires key modulusLength to be 2048 bits or larger`);
    }
  }
}

// node_modules/jose/dist/webapi/lib/jwk_to_key.js
function subtleMapping(jwk) {
  let algorithm;
  let keyUsages;
  switch (jwk.kty) {
    case "AKP": {
      switch (jwk.alg) {
        case "ML-DSA-44":
        case "ML-DSA-65":
        case "ML-DSA-87":
          algorithm = { name: jwk.alg };
          keyUsages = jwk.priv ? ["sign"] : ["verify"];
          break;
        default:
          throw new JOSENotSupported('Invalid or unsupported JWK "alg" (Algorithm) Parameter value');
      }
      break;
    }
    case "RSA": {
      switch (jwk.alg) {
        case "PS256":
        case "PS384":
        case "PS512":
          algorithm = { name: "RSA-PSS", hash: `SHA-${jwk.alg.slice(-3)}` };
          keyUsages = jwk.d ? ["sign"] : ["verify"];
          break;
        case "RS256":
        case "RS384":
        case "RS512":
          algorithm = { name: "RSASSA-PKCS1-v1_5", hash: `SHA-${jwk.alg.slice(-3)}` };
          keyUsages = jwk.d ? ["sign"] : ["verify"];
          break;
        case "RSA-OAEP":
        case "RSA-OAEP-256":
        case "RSA-OAEP-384":
        case "RSA-OAEP-512":
          algorithm = {
            name: "RSA-OAEP",
            hash: `SHA-${parseInt(jwk.alg.slice(-3), 10) || 1}`
          };
          keyUsages = jwk.d ? ["decrypt", "unwrapKey"] : ["encrypt", "wrapKey"];
          break;
        default:
          throw new JOSENotSupported('Invalid or unsupported JWK "alg" (Algorithm) Parameter value');
      }
      break;
    }
    case "EC": {
      switch (jwk.alg) {
        case "ES256":
          algorithm = { name: "ECDSA", namedCurve: "P-256" };
          keyUsages = jwk.d ? ["sign"] : ["verify"];
          break;
        case "ES384":
          algorithm = { name: "ECDSA", namedCurve: "P-384" };
          keyUsages = jwk.d ? ["sign"] : ["verify"];
          break;
        case "ES512":
          algorithm = { name: "ECDSA", namedCurve: "P-521" };
          keyUsages = jwk.d ? ["sign"] : ["verify"];
          break;
        case "ECDH-ES":
        case "ECDH-ES+A128KW":
        case "ECDH-ES+A192KW":
        case "ECDH-ES+A256KW":
          algorithm = { name: "ECDH", namedCurve: jwk.crv };
          keyUsages = jwk.d ? ["deriveBits"] : [];
          break;
        default:
          throw new JOSENotSupported('Invalid or unsupported JWK "alg" (Algorithm) Parameter value');
      }
      break;
    }
    case "OKP": {
      switch (jwk.alg) {
        case "Ed25519":
        case "EdDSA":
          algorithm = { name: "Ed25519" };
          keyUsages = jwk.d ? ["sign"] : ["verify"];
          break;
        case "ECDH-ES":
        case "ECDH-ES+A128KW":
        case "ECDH-ES+A192KW":
        case "ECDH-ES+A256KW":
          algorithm = { name: jwk.crv };
          keyUsages = jwk.d ? ["deriveBits"] : [];
          break;
        default:
          throw new JOSENotSupported('Invalid or unsupported JWK "alg" (Algorithm) Parameter value');
      }
      break;
    }
    default:
      throw new JOSENotSupported('Invalid or unsupported JWK "kty" (Key Type) Parameter value');
  }
  return { algorithm, keyUsages };
}
async function jwkToKey(jwk) {
  if (!jwk.alg) {
    throw new TypeError('"alg" argument is required when "jwk.alg" is not present');
  }
  const { algorithm, keyUsages } = subtleMapping(jwk);
  const keyData = { ...jwk };
  if (keyData.kty !== "AKP") {
    delete keyData.alg;
  }
  delete keyData.use;
  return crypto.subtle.importKey("jwk", keyData, algorithm, jwk.ext ?? (jwk.d || jwk.priv ? false : true), jwk.key_ops ?? keyUsages);
}

// node_modules/jose/dist/webapi/lib/validate_crit.js
function validateCrit(Err, recognizedDefault, recognizedOption, protectedHeader, joseHeader) {
  if (joseHeader.crit !== void 0 && protectedHeader?.crit === void 0) {
    throw new Err('"crit" (Critical) Header Parameter MUST be integrity protected');
  }
  if (!protectedHeader || protectedHeader.crit === void 0) {
    return /* @__PURE__ */ new Set();
  }
  if (!Array.isArray(protectedHeader.crit) || protectedHeader.crit.length === 0 || protectedHeader.crit.some((input) => typeof input !== "string" || input.length === 0)) {
    throw new Err('"crit" (Critical) Header Parameter MUST be an array of non-empty strings when present');
  }
  let recognized;
  if (recognizedOption !== void 0) {
    recognized = new Map([...Object.entries(recognizedOption), ...recognizedDefault.entries()]);
  } else {
    recognized = recognizedDefault;
  }
  for (const parameter of protectedHeader.crit) {
    if (!recognized.has(parameter)) {
      throw new JOSENotSupported(`Extension Header Parameter "${parameter}" is not recognized`);
    }
    if (joseHeader[parameter] === void 0) {
      throw new Err(`Extension Header Parameter "${parameter}" is missing`);
    }
    if (recognized.get(parameter) && protectedHeader[parameter] === void 0) {
      throw new Err(`Extension Header Parameter "${parameter}" MUST be integrity protected`);
    }
  }
  return new Set(protectedHeader.crit);
}

// node_modules/jose/dist/webapi/lib/validate_algorithms.js
function validateAlgorithms(option, algorithms) {
  if (algorithms !== void 0 && (!Array.isArray(algorithms) || algorithms.some((s) => typeof s !== "string"))) {
    throw new TypeError(`"${option}" option must be an array of strings`);
  }
  if (!algorithms) {
    return void 0;
  }
  return new Set(algorithms);
}

// node_modules/jose/dist/webapi/lib/is_jwk.js
var isJWK = (key) => isObject(key) && typeof key.kty === "string";
var isPrivateJWK = (key) => key.kty !== "oct" && (key.kty === "AKP" && typeof key.priv === "string" || typeof key.d === "string");
var isPublicJWK = (key) => key.kty !== "oct" && key.d === void 0 && key.priv === void 0;
var isSecretJWK = (key) => key.kty === "oct" && typeof key.k === "string";

// node_modules/jose/dist/webapi/lib/normalize_key.js
var cache;
var handleJWK = async (key, jwk, alg, freeze = false) => {
  cache ||= /* @__PURE__ */ new WeakMap();
  let cached = cache.get(key);
  if (cached?.[alg]) {
    return cached[alg];
  }
  const cryptoKey = await jwkToKey({ ...jwk, alg });
  if (freeze)
    Object.freeze(key);
  if (!cached) {
    cache.set(key, { [alg]: cryptoKey });
  } else {
    cached[alg] = cryptoKey;
  }
  return cryptoKey;
};
var handleKeyObject = (keyObject, alg) => {
  cache ||= /* @__PURE__ */ new WeakMap();
  let cached = cache.get(keyObject);
  if (cached?.[alg]) {
    return cached[alg];
  }
  const isPublic = keyObject.type === "public";
  const extractable = isPublic ? true : false;
  let cryptoKey;
  if (keyObject.asymmetricKeyType === "x25519") {
    switch (alg) {
      case "ECDH-ES":
      case "ECDH-ES+A128KW":
      case "ECDH-ES+A192KW":
      case "ECDH-ES+A256KW":
        break;
      default:
        throw new TypeError("given KeyObject instance cannot be used for this algorithm");
    }
    cryptoKey = keyObject.toCryptoKey(keyObject.asymmetricKeyType, extractable, isPublic ? [] : ["deriveBits"]);
  }
  if (keyObject.asymmetricKeyType === "ed25519") {
    if (alg !== "EdDSA" && alg !== "Ed25519") {
      throw new TypeError("given KeyObject instance cannot be used for this algorithm");
    }
    cryptoKey = keyObject.toCryptoKey(keyObject.asymmetricKeyType, extractable, [
      isPublic ? "verify" : "sign"
    ]);
  }
  switch (keyObject.asymmetricKeyType) {
    case "ml-dsa-44":
    case "ml-dsa-65":
    case "ml-dsa-87": {
      if (alg !== keyObject.asymmetricKeyType.toUpperCase()) {
        throw new TypeError("given KeyObject instance cannot be used for this algorithm");
      }
      cryptoKey = keyObject.toCryptoKey(keyObject.asymmetricKeyType, extractable, [
        isPublic ? "verify" : "sign"
      ]);
    }
  }
  if (keyObject.asymmetricKeyType === "rsa") {
    let hash;
    switch (alg) {
      case "RSA-OAEP":
        hash = "SHA-1";
        break;
      case "RS256":
      case "PS256":
      case "RSA-OAEP-256":
        hash = "SHA-256";
        break;
      case "RS384":
      case "PS384":
      case "RSA-OAEP-384":
        hash = "SHA-384";
        break;
      case "RS512":
      case "PS512":
      case "RSA-OAEP-512":
        hash = "SHA-512";
        break;
      default:
        throw new TypeError("given KeyObject instance cannot be used for this algorithm");
    }
    if (alg.startsWith("RSA-OAEP")) {
      return keyObject.toCryptoKey({
        name: "RSA-OAEP",
        hash
      }, extractable, isPublic ? ["encrypt"] : ["decrypt"]);
    }
    cryptoKey = keyObject.toCryptoKey({
      name: alg.startsWith("PS") ? "RSA-PSS" : "RSASSA-PKCS1-v1_5",
      hash
    }, extractable, [isPublic ? "verify" : "sign"]);
  }
  if (keyObject.asymmetricKeyType === "ec") {
    const nist = /* @__PURE__ */ new Map([
      ["prime256v1", "P-256"],
      ["secp384r1", "P-384"],
      ["secp521r1", "P-521"]
    ]);
    const namedCurve = nist.get(keyObject.asymmetricKeyDetails?.namedCurve);
    if (!namedCurve) {
      throw new TypeError("given KeyObject instance cannot be used for this algorithm");
    }
    if (alg === "ES256" && namedCurve === "P-256") {
      cryptoKey = keyObject.toCryptoKey({
        name: "ECDSA",
        namedCurve
      }, extractable, [isPublic ? "verify" : "sign"]);
    }
    if (alg === "ES384" && namedCurve === "P-384") {
      cryptoKey = keyObject.toCryptoKey({
        name: "ECDSA",
        namedCurve
      }, extractable, [isPublic ? "verify" : "sign"]);
    }
    if (alg === "ES512" && namedCurve === "P-521") {
      cryptoKey = keyObject.toCryptoKey({
        name: "ECDSA",
        namedCurve
      }, extractable, [isPublic ? "verify" : "sign"]);
    }
    if (alg.startsWith("ECDH-ES")) {
      cryptoKey = keyObject.toCryptoKey({
        name: "ECDH",
        namedCurve
      }, extractable, isPublic ? [] : ["deriveBits"]);
    }
  }
  if (!cryptoKey) {
    throw new TypeError("given KeyObject instance cannot be used for this algorithm");
  }
  if (!cached) {
    cache.set(keyObject, { [alg]: cryptoKey });
  } else {
    cached[alg] = cryptoKey;
  }
  return cryptoKey;
};
async function normalizeKey(key, alg) {
  if (key instanceof Uint8Array) {
    return key;
  }
  if (isCryptoKey(key)) {
    return key;
  }
  if (isKeyObject(key)) {
    if (key.type === "secret") {
      return key.export();
    }
    if ("toCryptoKey" in key && typeof key.toCryptoKey === "function") {
      try {
        return handleKeyObject(key, alg);
      } catch (err) {
        if (err instanceof TypeError) {
          throw err;
        }
      }
    }
    let jwk = key.export({ format: "jwk" });
    return handleJWK(key, jwk, alg);
  }
  if (isJWK(key)) {
    if (key.k) {
      return decode(key.k);
    }
    return handleJWK(key, key, alg, true);
  }
  throw new Error("unreachable");
}

// node_modules/jose/dist/webapi/lib/check_key_type.js
var tag = (key) => key?.[Symbol.toStringTag];
var jwkMatchesOp = (alg, key, usage) => {
  if (key.use !== void 0) {
    let expected;
    switch (usage) {
      case "sign":
      case "verify":
        expected = "sig";
        break;
      case "encrypt":
      case "decrypt":
        expected = "enc";
        break;
    }
    if (key.use !== expected) {
      throw new TypeError(`Invalid key for this operation, its "use" must be "${expected}" when present`);
    }
  }
  if (key.alg !== void 0 && key.alg !== alg) {
    throw new TypeError(`Invalid key for this operation, its "alg" must be "${alg}" when present`);
  }
  if (Array.isArray(key.key_ops)) {
    let expectedKeyOp;
    switch (true) {
      case (usage === "sign" || usage === "verify"):
      case alg === "dir":
      case alg.includes("CBC-HS"):
        expectedKeyOp = usage;
        break;
      case alg.startsWith("PBES2"):
        expectedKeyOp = "deriveBits";
        break;
      case /^A\d{3}(?:GCM)?(?:KW)?$/.test(alg):
        if (!alg.includes("GCM") && alg.endsWith("KW")) {
          expectedKeyOp = usage === "encrypt" ? "wrapKey" : "unwrapKey";
        } else {
          expectedKeyOp = usage;
        }
        break;
      case (usage === "encrypt" && alg.startsWith("RSA")):
        expectedKeyOp = "wrapKey";
        break;
      case usage === "decrypt":
        expectedKeyOp = alg.startsWith("RSA") ? "unwrapKey" : "deriveBits";
        break;
    }
    if (expectedKeyOp && key.key_ops?.includes?.(expectedKeyOp) === false) {
      throw new TypeError(`Invalid key for this operation, its "key_ops" must include "${expectedKeyOp}" when present`);
    }
  }
  return true;
};
var symmetricTypeCheck = (alg, key, usage) => {
  if (key instanceof Uint8Array)
    return;
  if (isJWK(key)) {
    if (isSecretJWK(key) && jwkMatchesOp(alg, key, usage))
      return;
    throw new TypeError(`JSON Web Key for symmetric algorithms must have JWK "kty" (Key Type) equal to "oct" and the JWK "k" (Key Value) present`);
  }
  if (!isKeyLike(key)) {
    throw new TypeError(withAlg(alg, key, "CryptoKey", "KeyObject", "JSON Web Key", "Uint8Array"));
  }
  if (key.type !== "secret") {
    throw new TypeError(`${tag(key)} instances for symmetric algorithms must be of type "secret"`);
  }
};
var asymmetricTypeCheck = (alg, key, usage) => {
  if (isJWK(key)) {
    switch (usage) {
      case "decrypt":
      case "sign":
        if (isPrivateJWK(key) && jwkMatchesOp(alg, key, usage))
          return;
        throw new TypeError(`JSON Web Key for this operation must be a private JWK`);
      case "encrypt":
      case "verify":
        if (isPublicJWK(key) && jwkMatchesOp(alg, key, usage))
          return;
        throw new TypeError(`JSON Web Key for this operation must be a public JWK`);
    }
  }
  if (!isKeyLike(key)) {
    throw new TypeError(withAlg(alg, key, "CryptoKey", "KeyObject", "JSON Web Key"));
  }
  if (key.type === "secret") {
    throw new TypeError(`${tag(key)} instances for asymmetric algorithms must not be of type "secret"`);
  }
  if (key.type === "public") {
    switch (usage) {
      case "sign":
        throw new TypeError(`${tag(key)} instances for asymmetric algorithm signing must be of type "private"`);
      case "decrypt":
        throw new TypeError(`${tag(key)} instances for asymmetric algorithm decryption must be of type "private"`);
    }
  }
  if (key.type === "private") {
    switch (usage) {
      case "verify":
        throw new TypeError(`${tag(key)} instances for asymmetric algorithm verifying must be of type "public"`);
      case "encrypt":
        throw new TypeError(`${tag(key)} instances for asymmetric algorithm encryption must be of type "public"`);
    }
  }
};
function checkKeyType(alg, key, usage) {
  switch (alg.substring(0, 2)) {
    case "A1":
    case "A2":
    case "di":
    case "HS":
    case "PB":
      symmetricTypeCheck(alg, key, usage);
      break;
    default:
      asymmetricTypeCheck(alg, key, usage);
  }
}

// node_modules/jose/dist/webapi/lib/subtle_dsa.js
function subtleAlgorithm(alg, algorithm) {
  const hash = `SHA-${alg.slice(-3)}`;
  switch (alg) {
    case "HS256":
    case "HS384":
    case "HS512":
      return { hash, name: "HMAC" };
    case "PS256":
    case "PS384":
    case "PS512":
      return { hash, name: "RSA-PSS", saltLength: parseInt(alg.slice(-3), 10) >> 3 };
    case "RS256":
    case "RS384":
    case "RS512":
      return { hash, name: "RSASSA-PKCS1-v1_5" };
    case "ES256":
    case "ES384":
    case "ES512":
      return { hash, name: "ECDSA", namedCurve: algorithm.namedCurve };
    case "Ed25519":
    case "EdDSA":
      return { name: "Ed25519" };
    case "ML-DSA-44":
    case "ML-DSA-65":
    case "ML-DSA-87":
      return { name: alg };
    default:
      throw new JOSENotSupported(`alg ${alg} is not supported either by JOSE or your javascript runtime`);
  }
}

// node_modules/jose/dist/webapi/lib/get_sign_verify_key.js
async function getSigKey(alg, key, usage) {
  if (key instanceof Uint8Array) {
    if (!alg.startsWith("HS")) {
      throw new TypeError(invalidKeyInput(key, "CryptoKey", "KeyObject", "JSON Web Key"));
    }
    return crypto.subtle.importKey("raw", key, { hash: `SHA-${alg.slice(-3)}`, name: "HMAC" }, false, [usage]);
  }
  checkSigCryptoKey(key, alg, usage);
  return key;
}

// node_modules/jose/dist/webapi/lib/verify.js
async function verify(alg, key, signature, data) {
  const cryptoKey = await getSigKey(alg, key, "verify");
  checkKeyLength(alg, cryptoKey);
  const algorithm = subtleAlgorithm(alg, cryptoKey.algorithm);
  try {
    return await crypto.subtle.verify(algorithm, cryptoKey, signature, data);
  } catch {
    return false;
  }
}

// node_modules/jose/dist/webapi/jws/flattened/verify.js
async function flattenedVerify(jws, key, options) {
  if (!isObject(jws)) {
    throw new JWSInvalid("Flattened JWS must be an object");
  }
  if (jws.protected === void 0 && jws.header === void 0) {
    throw new JWSInvalid('Flattened JWS must have either of the "protected" or "header" members');
  }
  if (jws.protected !== void 0 && typeof jws.protected !== "string") {
    throw new JWSInvalid("JWS Protected Header incorrect type");
  }
  if (jws.payload === void 0) {
    throw new JWSInvalid("JWS Payload missing");
  }
  if (typeof jws.signature !== "string") {
    throw new JWSInvalid("JWS Signature missing or incorrect type");
  }
  if (jws.header !== void 0 && !isObject(jws.header)) {
    throw new JWSInvalid("JWS Unprotected Header incorrect type");
  }
  let parsedProt = {};
  if (jws.protected) {
    try {
      const protectedHeader = decode(jws.protected);
      parsedProt = JSON.parse(decoder.decode(protectedHeader));
    } catch {
      throw new JWSInvalid("JWS Protected Header is invalid");
    }
  }
  if (!isDisjoint(parsedProt, jws.header)) {
    throw new JWSInvalid("JWS Protected and JWS Unprotected Header Parameter names must be disjoint");
  }
  const joseHeader = {
    ...parsedProt,
    ...jws.header
  };
  const extensions = validateCrit(JWSInvalid, /* @__PURE__ */ new Map([["b64", true]]), options?.crit, parsedProt, joseHeader);
  let b64 = true;
  if (extensions.has("b64")) {
    b64 = parsedProt.b64;
    if (typeof b64 !== "boolean") {
      throw new JWSInvalid('The "b64" (base64url-encode payload) Header Parameter must be a boolean');
    }
  }
  const { alg } = joseHeader;
  if (typeof alg !== "string" || !alg) {
    throw new JWSInvalid('JWS "alg" (Algorithm) Header Parameter missing or invalid');
  }
  const algorithms = options && validateAlgorithms("algorithms", options.algorithms);
  if (algorithms && !algorithms.has(alg)) {
    throw new JOSEAlgNotAllowed('"alg" (Algorithm) Header Parameter value not allowed');
  }
  if (b64) {
    if (typeof jws.payload !== "string") {
      throw new JWSInvalid("JWS Payload must be a string");
    }
  } else if (typeof jws.payload !== "string" && !(jws.payload instanceof Uint8Array)) {
    throw new JWSInvalid("JWS Payload must be a string or an Uint8Array instance");
  }
  let resolvedKey = false;
  if (typeof key === "function") {
    key = await key(parsedProt, jws);
    resolvedKey = true;
  }
  checkKeyType(alg, key, "verify");
  const data = concat(jws.protected !== void 0 ? encode(jws.protected) : new Uint8Array(), encode("."), typeof jws.payload === "string" ? b64 ? encode(jws.payload) : encoder.encode(jws.payload) : jws.payload);
  let signature;
  try {
    signature = decode(jws.signature);
  } catch {
    throw new JWSInvalid("Failed to base64url decode the signature");
  }
  const k = await normalizeKey(key, alg);
  const verified = await verify(alg, k, signature, data);
  if (!verified) {
    throw new JWSSignatureVerificationFailed();
  }
  let payload;
  if (b64) {
    try {
      payload = decode(jws.payload);
    } catch {
      throw new JWSInvalid("Failed to base64url decode the payload");
    }
  } else if (typeof jws.payload === "string") {
    payload = encoder.encode(jws.payload);
  } else {
    payload = jws.payload;
  }
  const result = { payload };
  if (jws.protected !== void 0) {
    result.protectedHeader = parsedProt;
  }
  if (jws.header !== void 0) {
    result.unprotectedHeader = jws.header;
  }
  if (resolvedKey) {
    return { ...result, key: k };
  }
  return result;
}

// node_modules/jose/dist/webapi/jws/compact/verify.js
async function compactVerify(jws, key, options) {
  if (jws instanceof Uint8Array) {
    jws = decoder.decode(jws);
  }
  if (typeof jws !== "string") {
    throw new JWSInvalid("Compact JWS must be a string or Uint8Array");
  }
  const { 0: protectedHeader, 1: payload, 2: signature, length } = jws.split(".");
  if (length !== 3) {
    throw new JWSInvalid("Invalid Compact JWS");
  }
  const verified = await flattenedVerify({ payload, protected: protectedHeader, signature }, key, options);
  const result = { payload: verified.payload, protectedHeader: verified.protectedHeader };
  if (typeof key === "function") {
    return { ...result, key: verified.key };
  }
  return result;
}

// node_modules/jose/dist/webapi/lib/jwt_claims_set.js
var epoch = (date) => Math.floor(date.getTime() / 1e3);
var minute = 60;
var hour = minute * 60;
var day = hour * 24;
var week = day * 7;
var year = day * 365.25;
var REGEX = /^(\+|\-)? ?(\d+|\d+\.\d+) ?(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)(?: (ago|from now))?$/i;
function secs(str) {
  const matched = REGEX.exec(str);
  if (!matched || matched[4] && matched[1]) {
    throw new TypeError("Invalid time period format");
  }
  const value = parseFloat(matched[2]);
  const unit = matched[3].toLowerCase();
  let numericDate;
  switch (unit) {
    case "sec":
    case "secs":
    case "second":
    case "seconds":
    case "s":
      numericDate = Math.round(value);
      break;
    case "minute":
    case "minutes":
    case "min":
    case "mins":
    case "m":
      numericDate = Math.round(value * minute);
      break;
    case "hour":
    case "hours":
    case "hr":
    case "hrs":
    case "h":
      numericDate = Math.round(value * hour);
      break;
    case "day":
    case "days":
    case "d":
      numericDate = Math.round(value * day);
      break;
    case "week":
    case "weeks":
    case "w":
      numericDate = Math.round(value * week);
      break;
    default:
      numericDate = Math.round(value * year);
      break;
  }
  if (matched[1] === "-" || matched[4] === "ago") {
    return -numericDate;
  }
  return numericDate;
}
function validateInput(label, input) {
  if (!Number.isFinite(input)) {
    throw new TypeError(`Invalid ${label} input`);
  }
  return input;
}
var normalizeTyp = (value) => {
  if (value.includes("/")) {
    return value.toLowerCase();
  }
  return `application/${value.toLowerCase()}`;
};
var checkAudiencePresence = (audPayload, audOption) => {
  if (typeof audPayload === "string") {
    return audOption.includes(audPayload);
  }
  if (Array.isArray(audPayload)) {
    return audOption.some(Set.prototype.has.bind(new Set(audPayload)));
  }
  return false;
};
function validateClaimsSet(protectedHeader, encodedPayload, options = {}) {
  let payload;
  try {
    payload = JSON.parse(decoder.decode(encodedPayload));
  } catch {
  }
  if (!isObject(payload)) {
    throw new JWTInvalid("JWT Claims Set must be a top-level JSON object");
  }
  const { typ } = options;
  if (typ && (typeof protectedHeader.typ !== "string" || normalizeTyp(protectedHeader.typ) !== normalizeTyp(typ))) {
    throw new JWTClaimValidationFailed('unexpected "typ" JWT header value', payload, "typ", "check_failed");
  }
  const { requiredClaims = [], issuer, subject, audience, maxTokenAge } = options;
  const presenceCheck = [...requiredClaims];
  if (maxTokenAge !== void 0)
    presenceCheck.push("iat");
  if (audience !== void 0)
    presenceCheck.push("aud");
  if (subject !== void 0)
    presenceCheck.push("sub");
  if (issuer !== void 0)
    presenceCheck.push("iss");
  for (const claim of new Set(presenceCheck.reverse())) {
    if (!(claim in payload)) {
      throw new JWTClaimValidationFailed(`missing required "${claim}" claim`, payload, claim, "missing");
    }
  }
  if (issuer && !(Array.isArray(issuer) ? issuer : [issuer]).includes(payload.iss)) {
    throw new JWTClaimValidationFailed('unexpected "iss" claim value', payload, "iss", "check_failed");
  }
  if (subject && payload.sub !== subject) {
    throw new JWTClaimValidationFailed('unexpected "sub" claim value', payload, "sub", "check_failed");
  }
  if (audience && !checkAudiencePresence(payload.aud, typeof audience === "string" ? [audience] : audience)) {
    throw new JWTClaimValidationFailed('unexpected "aud" claim value', payload, "aud", "check_failed");
  }
  let tolerance;
  switch (typeof options.clockTolerance) {
    case "string":
      tolerance = secs(options.clockTolerance);
      break;
    case "number":
      tolerance = options.clockTolerance;
      break;
    case "undefined":
      tolerance = 0;
      break;
    default:
      throw new TypeError("Invalid clockTolerance option type");
  }
  const { currentDate } = options;
  const now = epoch(currentDate || /* @__PURE__ */ new Date());
  if ((payload.iat !== void 0 || maxTokenAge) && typeof payload.iat !== "number") {
    throw new JWTClaimValidationFailed('"iat" claim must be a number', payload, "iat", "invalid");
  }
  if (payload.nbf !== void 0) {
    if (typeof payload.nbf !== "number") {
      throw new JWTClaimValidationFailed('"nbf" claim must be a number', payload, "nbf", "invalid");
    }
    if (payload.nbf > now + tolerance) {
      throw new JWTClaimValidationFailed('"nbf" claim timestamp check failed', payload, "nbf", "check_failed");
    }
  }
  if (payload.exp !== void 0) {
    if (typeof payload.exp !== "number") {
      throw new JWTClaimValidationFailed('"exp" claim must be a number', payload, "exp", "invalid");
    }
    if (payload.exp <= now - tolerance) {
      throw new JWTExpired('"exp" claim timestamp check failed', payload, "exp", "check_failed");
    }
  }
  if (maxTokenAge) {
    const age = now - payload.iat;
    const max = typeof maxTokenAge === "number" ? maxTokenAge : secs(maxTokenAge);
    if (age - tolerance > max) {
      throw new JWTExpired('"iat" claim timestamp check failed (too far in the past)', payload, "iat", "check_failed");
    }
    if (age < 0 - tolerance) {
      throw new JWTClaimValidationFailed('"iat" claim timestamp check failed (it should be in the past)', payload, "iat", "check_failed");
    }
  }
  return payload;
}
var JWTClaimsBuilder = class {
  #payload;
  constructor(payload) {
    if (!isObject(payload)) {
      throw new TypeError("JWT Claims Set MUST be an object");
    }
    this.#payload = structuredClone(payload);
  }
  data() {
    return encoder.encode(JSON.stringify(this.#payload));
  }
  get iss() {
    return this.#payload.iss;
  }
  set iss(value) {
    this.#payload.iss = value;
  }
  get sub() {
    return this.#payload.sub;
  }
  set sub(value) {
    this.#payload.sub = value;
  }
  get aud() {
    return this.#payload.aud;
  }
  set aud(value) {
    this.#payload.aud = value;
  }
  set jti(value) {
    this.#payload.jti = value;
  }
  set nbf(value) {
    if (typeof value === "number") {
      this.#payload.nbf = validateInput("setNotBefore", value);
    } else if (value instanceof Date) {
      this.#payload.nbf = validateInput("setNotBefore", epoch(value));
    } else {
      this.#payload.nbf = epoch(/* @__PURE__ */ new Date()) + secs(value);
    }
  }
  set exp(value) {
    if (typeof value === "number") {
      this.#payload.exp = validateInput("setExpirationTime", value);
    } else if (value instanceof Date) {
      this.#payload.exp = validateInput("setExpirationTime", epoch(value));
    } else {
      this.#payload.exp = epoch(/* @__PURE__ */ new Date()) + secs(value);
    }
  }
  set iat(value) {
    if (value === void 0) {
      this.#payload.iat = epoch(/* @__PURE__ */ new Date());
    } else if (value instanceof Date) {
      this.#payload.iat = validateInput("setIssuedAt", epoch(value));
    } else if (typeof value === "string") {
      this.#payload.iat = validateInput("setIssuedAt", epoch(/* @__PURE__ */ new Date()) + secs(value));
    } else {
      this.#payload.iat = validateInput("setIssuedAt", value);
    }
  }
};

// node_modules/jose/dist/webapi/jwt/verify.js
async function jwtVerify(jwt, key, options) {
  const verified = await compactVerify(jwt, key, options);
  if (verified.protectedHeader.crit?.includes("b64") && verified.protectedHeader.b64 === false) {
    throw new JWTInvalid("JWTs MUST NOT use unencoded payload");
  }
  const payload = validateClaimsSet(verified.protectedHeader, verified.payload, options);
  const result = { payload, protectedHeader: verified.protectedHeader };
  if (typeof key === "function") {
    return { ...result, key: verified.key };
  }
  return result;
}

// node_modules/jose/dist/webapi/lib/sign.js
async function sign(alg, key, data) {
  const cryptoKey = await getSigKey(alg, key, "sign");
  checkKeyLength(alg, cryptoKey);
  const signature = await crypto.subtle.sign(subtleAlgorithm(alg, cryptoKey.algorithm), cryptoKey, data);
  return new Uint8Array(signature);
}

// node_modules/jose/dist/webapi/jws/flattened/sign.js
var FlattenedSign = class {
  #payload;
  #protectedHeader;
  #unprotectedHeader;
  constructor(payload) {
    if (!(payload instanceof Uint8Array)) {
      throw new TypeError("payload must be an instance of Uint8Array");
    }
    this.#payload = payload;
  }
  setProtectedHeader(protectedHeader) {
    if (this.#protectedHeader) {
      throw new TypeError("setProtectedHeader can only be called once");
    }
    this.#protectedHeader = protectedHeader;
    return this;
  }
  setUnprotectedHeader(unprotectedHeader) {
    if (this.#unprotectedHeader) {
      throw new TypeError("setUnprotectedHeader can only be called once");
    }
    this.#unprotectedHeader = unprotectedHeader;
    return this;
  }
  async sign(key, options) {
    if (!this.#protectedHeader && !this.#unprotectedHeader) {
      throw new JWSInvalid("either setProtectedHeader or setUnprotectedHeader must be called before #sign()");
    }
    if (!isDisjoint(this.#protectedHeader, this.#unprotectedHeader)) {
      throw new JWSInvalid("JWS Protected and JWS Unprotected Header Parameter names must be disjoint");
    }
    const joseHeader = {
      ...this.#protectedHeader,
      ...this.#unprotectedHeader
    };
    const extensions = validateCrit(JWSInvalid, /* @__PURE__ */ new Map([["b64", true]]), options?.crit, this.#protectedHeader, joseHeader);
    let b64 = true;
    if (extensions.has("b64")) {
      b64 = this.#protectedHeader.b64;
      if (typeof b64 !== "boolean") {
        throw new JWSInvalid('The "b64" (base64url-encode payload) Header Parameter must be a boolean');
      }
    }
    const { alg } = joseHeader;
    if (typeof alg !== "string" || !alg) {
      throw new JWSInvalid('JWS "alg" (Algorithm) Header Parameter missing or invalid');
    }
    checkKeyType(alg, key, "sign");
    let payloadS;
    let payloadB;
    if (b64) {
      payloadS = encode2(this.#payload);
      payloadB = encode(payloadS);
    } else {
      payloadB = this.#payload;
      payloadS = "";
    }
    let protectedHeaderString;
    let protectedHeaderBytes;
    if (this.#protectedHeader) {
      protectedHeaderString = encode2(JSON.stringify(this.#protectedHeader));
      protectedHeaderBytes = encode(protectedHeaderString);
    } else {
      protectedHeaderString = "";
      protectedHeaderBytes = new Uint8Array();
    }
    const data = concat(protectedHeaderBytes, encode("."), payloadB);
    const k = await normalizeKey(key, alg);
    const signature = await sign(alg, k, data);
    const jws = {
      signature: encode2(signature),
      payload: payloadS
    };
    if (this.#unprotectedHeader) {
      jws.header = this.#unprotectedHeader;
    }
    if (this.#protectedHeader) {
      jws.protected = protectedHeaderString;
    }
    return jws;
  }
};

// node_modules/jose/dist/webapi/jws/compact/sign.js
var CompactSign = class {
  #flattened;
  constructor(payload) {
    this.#flattened = new FlattenedSign(payload);
  }
  setProtectedHeader(protectedHeader) {
    this.#flattened.setProtectedHeader(protectedHeader);
    return this;
  }
  async sign(key, options) {
    const jws = await this.#flattened.sign(key, options);
    if (jws.payload === void 0) {
      throw new TypeError("use the flattened module for creating JWS with b64: false");
    }
    return `${jws.protected}.${jws.payload}.${jws.signature}`;
  }
};

// node_modules/jose/dist/webapi/jwt/sign.js
var SignJWT = class {
  #protectedHeader;
  #jwt;
  constructor(payload = {}) {
    this.#jwt = new JWTClaimsBuilder(payload);
  }
  setIssuer(issuer) {
    this.#jwt.iss = issuer;
    return this;
  }
  setSubject(subject) {
    this.#jwt.sub = subject;
    return this;
  }
  setAudience(audience) {
    this.#jwt.aud = audience;
    return this;
  }
  setJti(jwtId) {
    this.#jwt.jti = jwtId;
    return this;
  }
  setNotBefore(input) {
    this.#jwt.nbf = input;
    return this;
  }
  setExpirationTime(input) {
    this.#jwt.exp = input;
    return this;
  }
  setIssuedAt(input) {
    this.#jwt.iat = input;
    return this;
  }
  setProtectedHeader(protectedHeader) {
    this.#protectedHeader = protectedHeader;
    return this;
  }
  async sign(key, options) {
    const sig = new CompactSign(this.#jwt.data());
    sig.setProtectedHeader(this.#protectedHeader);
    if (Array.isArray(this.#protectedHeader?.crit) && this.#protectedHeader.crit.includes("b64") && this.#protectedHeader.b64 === false) {
      throw new JWTInvalid("JWTs MUST NOT use unencoded payload");
    }
    return sig.sign(key, options);
  }
};

// src/auth.ts
async function generateJWTToken(ctx) {
  const { request, env } = ctx;
  if (request.method !== "POST") {
    return respond(false, 405, "Method not allowed.");
  }
  const password = await request.text();
  const savedPass = await env.kv.get("pwd");
  if (password !== savedPass) {
    return respond(false, 401 /* UNAUTHORIZED */, "Wrong password.");
  }
  let secretKey = await env.kv.get("secretKey");
  if (!secretKey) {
    secretKey = generateSecretKey();
    
    // Check if secret key was saved (critical - auth cannot proceed without it)
    const success = await saveDataset(env, "secretKey", secretKey);
    if (!success) {
      throw new Error('Failed to save secret key - authentication cannot proceed');
    }
  }
  const secret = new TextEncoder().encode(secretKey);
  const { userID } = ctx.globalConfig;
  const jwtToken = await new SignJWT({ userID }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("24h").sign(secret);
  return respond(true, 200 /* OK */, "Successfully generated Auth token", null, {
    "Set-Cookie": `jwtToken=${jwtToken}; HttpOnly; Secure; Max-Age=${7 * 24 * 60 * 60}; Path=/; SameSite=Strict`,
    "Content-Type": "text/plain"
  });
}
function generateSecretKey() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function Authenticate(request, env) {
  try {
    const secretKey = await env.kv.get("secretKey");
    if (secretKey === null) {
      console.log("Secret key not found in KV.");
      return false;
    }
    const secret = new TextEncoder().encode(secretKey);
    const cookie = request.headers.get("Cookie")?.match(/(^|;\s*)jwtToken=([^;]*)/);
    const token = cookie ? cookie[2] : null;
    if (!token) {
      console.log("Unauthorized: Token not available!");
      return false;
    }
    const { payload } = await jwtVerify(token, secret);
    console.log(`Successfully authenticated, User ID: ${payload.userID}`);
    return true;
  } catch (error) {
    const message2 = error instanceof Error ? error.message : String(error);
    console.log(message2);
    return false;
  }
}
async function resetPassword(request, env) {
  let auth = await Authenticate(request, env);
  const oldPwd = await env.kv.get("pwd");
  if (oldPwd && !auth) {
    return respond(false, 401 /* UNAUTHORIZED */, "Unauthorized.");
  }
  const newPwd = await request.text();
  if (newPwd === oldPwd) {
    return respond(false, 400 /* BAD_REQUEST */, "Please enter a new Password.");
  }
  await saveDataset(env, "pwd", newPwd);
  return respond(true, 200 /* OK */, "Successfully logged in!", null, {
    "Set-Cookie": "jwtToken=; HttpOnly; Secure; Path=/; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Content-Type": "text/plain"
  });
}

// src/cores/clash/geo-assets.ts
function getGeoAssets(ctx) {
  return getGeoAssetsShared(ctx, 'clash');
}

// src/cores/clash/dns.ts
async function buildDNS(ctx, isChain, isWarp, isPro) {
  const {
    localDNS,
    remoteDNS,
    warpRemoteDNS,
    antiSanctionDNS,
    outProxyParams,
    remoteDnsHost,
    enableIPv6,
    fakeDNS,
    allowLANConnection
  } = ctx.settings;
  const finalLocalDNS = localDNS === "localhost" ? "system" : `${localDNS}#DIRECT`;
  const proSign = isPro ? "Pro " : "";
  const remoteDnsDetour = isWarp ? `\u{1F4A6} Warp ${proSign}- Best Ping \u{1F680}` : isChain ? "\u{1F4A6} Best Ping \u{1F680}" : "\u2705 Selector";
  const finalRemoteDNS = `${isWarp ? warpRemoteDNS : remoteDNS}#${remoteDnsDetour}`;
  const hosts = {};
  const nameserverPolicy = {};
  if (isChain && !isWarp) {
    const { server } = outProxyParams;
    if (isDomain(server)) nameserverPolicy[server] = finalRemoteDNS;
  }
  if (remoteDnsHost.isDomain && !isWarp) {
    const { ipv4, ipv6, host } = remoteDnsHost;
    hosts[host] = ipv4.concatIf(enableIPv6, ipv6);
  }
  const geoAssets = getGeoAssets(ctx);
  const dnsRules = accDnsRules(ctx, geoAssets);
  const blockDomains = [
    ...dnsRules.block.geosites.map((geosite) => `rule-set:${geosite}`),
    ...dnsRules.block.domains.map((domain) => `+.${domain}`)
  ];
  blockDomains.forEach((value) => hosts[value] = "rcode://refused");
  const sanctionDomains = [
    ...dnsRules.bypass.antiSanctionDNS.geosites.map((geosite) => `rule-set:${geosite}`),
    ...dnsRules.bypass.antiSanctionDNS.domains.map((domain) => `+.${domain}`)
  ];
  const bypassDomains = [
    ...dnsRules.bypass.localDNS.geositeGeoips.map(({ geosite }) => `rule-set:${geosite}`),
    ...dnsRules.bypass.localDNS.geosites.map((geosite) => `rule-set:${geosite}`),
    ...dnsRules.bypass.localDNS.domains.map((domain) => `+.${domain}`)
  ];
  if (sanctionDomains.length) {
    sanctionDomains.forEach((value) => nameserverPolicy[value] = `${antiSanctionDNS}#DIRECT`);
    const { host, isHostDomain } = getDomain(antiSanctionDNS);
    if (isHostDomain) bypassDomains.push(host);
  }
  bypassDomains.forEach((value) => nameserverPolicy[value] = finalLocalDNS);
  const listen = `${allowLANConnection ? "0.0.0.0" : "127.0.0.1"}:1053`;
  let enhancedMode = "redir-host";
  let fakeDnsSettings = {};
  if (fakeDNS) {
    enhancedMode = "fake-ip";
    fakeDnsSettings = {
      "fake-ip-range": "198.18.0.1/16",
      "fake-ip-filter-mode": "blacklist",
      "fake-ip-filter": ["+.lan", "+.local"]
    };
  }
  const dns = {
    "enable": true,
    "respect-rules": true,
    "use-system-hosts": false,
    "listen": listen,
    "ipv6": enableIPv6,
    "hosts": hosts.omitEmpty(),
    "nameserver": [finalRemoteDNS],
    "proxy-server-nameserver": [finalLocalDNS],
    "direct-nameserver": [finalLocalDNS],
    "direct-nameserver-follow-policy": true,
    "nameserver-policy": nameserverPolicy.omitEmpty(),
    "enhanced-mode": enhancedMode,
    ...fakeDnsSettings
  };
  return dns;
}

// src/cores/clash/routing.ts
function buildRoutingRules(ctx, isWarp) {
  const { blockUDP443 } = ctx.settings;
  const geoAssets = getGeoAssets(ctx);
  const routingRules = accRoutingRules(ctx, geoAssets);
  const rules = [`GEOIP,lan,DIRECT,no-resolve`];
  if (!isWarp) {
    rules.push("NETWORK,udp,REJECT");
  } else if (blockUDP443) {
    rules.push("AND,((NETWORK,udp),(DST-PORT,443)),REJECT");
  }
  return [
    ...rules,
    ...routingRules.block.geosites.map((geosite) => `RULE-SET,${geosite},REJECT`),
    ...routingRules.block.domains.map((domain) => `DOMAIN-SUFFIX,${domain},REJECT`),
    ...routingRules.block.geoips.map((geoip) => `RULE-SET,${geoip},REJECT`),
    ...routingRules.block.ips.map((ip) => buildIpCidrRule(ip, "REJECT")),
    ...routingRules.bypass.geosites.map((geosite) => `RULE-SET,${geosite},DIRECT`),
    ...routingRules.bypass.domains.map((domain) => `DOMAIN-SUFFIX,${domain},DIRECT`),
    ...routingRules.bypass.geoips.map((geoip) => `RULE-SET,${geoip},DIRECT`),
    ...routingRules.bypass.ips.map((ip) => buildIpCidrRule(ip, "DIRECT")),
    "MATCH,\u2705 Selector"
  ];
}
function buildRuleProviders(ctx) {
  const geoAssets = getGeoAssets(ctx);
  return geoAssets.reduce((providers, asset) => {
    addRuleProvider(providers, asset);
    return providers;
  }, {}).omitEmpty();
}
function addRuleProvider(ruleProviders, ruleProvider) {
  const { geosite, geoip, geositeURL, geoipURL, format } = ruleProvider;
  const fileExtension = format === "text" ? "txt" : format;
  const defineProvider = (geo, behavior, url) => {
    ruleProviders[geo] = {
      type: "http",
      format,
      behavior,
      path: `./ruleset/${geo}.${fileExtension}`,
      interval: 86400,
      url
    };
  };
  if (geosite && geositeURL) defineProvider(geosite, "domain", geositeURL);
  if (geoip && geoipURL) defineProvider(geoip, "ipcidr", geoipURL);
}
function buildIpCidrRule(ip, proxy) {
  ip = isIPv6(ip) ? ip.replace(/\[|\]/g, "") : ip;
  const cidr = ip.includes("/") ? "" : isIPv4(ip) ? "/32" : "/128";
  return `IP-CIDR,${ip}${cidr},${proxy}`;
}

// src/cores/clash/outbounds.ts
function buildOutbound(name, type, server, port, isIPv62, tfo, tls, transport, fields) {
  return {
    "name": name,
    "type": type,
    "server": server.replace(/\[|\]/g, ""),
    "port": port,
    "ip-version": isIPv62 ? "ipv4-prefer" : "ipv4",
    "tfo": tfo,
    "udp": false,
    ...fields,
    ...tls,
    ...transport
  };
}
function buildWebsocketOutbound(ctx, protocol, remark, address, port) {
  const {
    dict: { _VL_, _TR_ },
    globalConfig: { userID, TrPass },
    settings: { fingerprint, enableTFO, enableIPv6, enableECH, echConfig }
  } = ctx;
  const isTLS = isHttps(ctx, port);
  if (protocol === _TR_ && !isTLS) return null;
  const { host, sni, allowInsecure } = selectSniHost(ctx, address);
  const tls = isTLS ? buildTLS(protocol, "tls", allowInsecure, sni, enableECH ? echConfig : void 0, "http/1.1", fingerprint) : {};
  const transport = buildTransport("ws", void 0, generateWsPath(ctx, protocol), host, void 0, 2560);
  if (protocol === _VL_) return buildOutbound(remark, protocol, address, port, enableIPv6, enableTFO, tls, transport, {
    "uuid": userID,
    "packet-encoding": ""
  });
  return buildOutbound(remark, protocol, address, port, enableIPv6, enableTFO, tls, transport, {
    "password": TrPass
  });
}
function buildWarpOutbound(ctx, warpAccount, remark, endpoint, chain, isPro) {
  const {
    amneziaNoiseCount,
    amneziaNoiseSizeMin,
    amneziaNoiseSizeMax,
    enableIPv6
  } = ctx.settings;
  const { host, port } = parseHostPort(endpoint, false);
  const ipVersion = enableIPv6 ? "ipv4-prefer" : "ipv4";
  const {
    warpIPv6,
    reserved,
    publicKey,
    privateKey
  } = warpAccount;
  return {
    "name": remark,
    "type": "wireguard",
    "ip": "172.16.0.2/32",
    "ipv6": warpIPv6,
    "ip-version": ipVersion,
    "private-key": privateKey,
    "server": chain ? "162.159.192.1" : host,
    "port": chain ? 2408 : port,
    "public-key": publicKey,
    "allowed-ips": ["0.0.0.0/0", "::/0"],
    "reserved": reserved,
    "udp": true,
    "mtu": 1280,
    "dialer-proxy": chain || void 0,
    "amnezia-wg-option": isPro ? {
      "jc": amneziaNoiseCount,
      "jmin": amneziaNoiseSizeMin,
      "jmax": amneziaNoiseSizeMax
    } : void 0
  };
}
function buildChainOutbound(ctx) {
  const {
    dict: { _SS_, _VL_, _TR_, _VM_ },
    settings: {
      outProxy,
      outProxyParams: {
        protocol,
        server,
        port,
        user,
        pass,
        password,
        method,
        uuid,
        flow,
        security,
        type,
        sni,
        fp,
        host,
        path,
        alpn,
        pbk,
        sid,
        headerType,
        serviceName,
        aid
      }
    }
  } = ctx;
  const { searchParams } = new URL(outProxy);
  const ed = searchParams.get("ed");
  const earlyData = ed ? +ed : void 0;
  const tls = buildTLS(protocol, security, false, sni || server, void 0, alpn, fp, pbk, sid);
  const transport = buildTransport(type, headerType, path, host, serviceName, earlyData);
  switch (protocol) {
    case "http":
      return buildOutbound("", "http", server, port, false, false, {}, {}, {
        "username": user,
        "password": pass
      });
    case "socks":
      return buildOutbound("", "socks5", server, port, false, false, {}, {}, {
        "username": user,
        "password": pass
      });
    case _SS_:
      return buildOutbound("", "ss", server, port, false, false, {}, {}, {
        "cipher": method,
        "password": password
      });
    case _VL_:
      return buildOutbound("", _VL_, server, port, false, false, tls, transport, {
        "uuid": uuid,
        "flow": flow
      });
    case _VM_:
      return buildOutbound("", _VM_, server, port, false, false, tls, transport, {
        "uuid": uuid,
        "cipher": "auto",
        "alterId": aid
      });
    case _TR_:
      if (security === "none") return void 0;
      return buildOutbound("", _TR_, server, port, false, false, tls, transport, {
        "password": password
      });
    default:
      return void 0;
  }
  ;
}
function buildUrlTest(ctx, name, proxies, isWarp) {
  const { bestWarpInterval, bestVLTRInterval } = ctx.settings;
  return {
    "name": name,
    "type": "url-test",
    "proxies": proxies,
    "url": "https://www.gstatic.com/generate_204",
    "interval": isWarp ? bestWarpInterval : bestVLTRInterval,
    "tolerance": 50
  };
}
function buildTLS(protocol, security, allowInsecure, sni, echConfig, alpn, fingerprint, publicKey, shortID) {
  if (!["tls", "reality"].includes(security)) return {};
  const { _TR_ } = DICT;
  const common = {
    "tls": true,
    [protocol === _TR_ ? "sni" : "servername"]: sni,
    "client-fingerprint": fingerprint === "randomized" ? "random" : fingerprint,
    "skip-cert-verify": allowInsecure
  };
  if (security === "tls") {
    return {
      ...common,
      "alpn": alpn?.split(","),
      "ech-opts": echConfig ? {
        "enable": true,
        "config": echConfig
      } : void 0
    };
  } else if (security === "reality" && publicKey && shortID) {
    return {
      ...common,
      "reality-opts": {
        "public-key": publicKey,
        "short-id": shortID
      }
    };
  } else return {};
}
function buildTransport(type, headerType, path = "/", host, serviceName, earlyData) {
  path = path?.split("?")[0];
  switch (type) {
    case "tcp":
      return headerType === "http" ? {
        "network": "http",
        "http-opts": {
          "method": "GET",
          "path": path.split(","),
          "headers": {
            "Host": host?.split(","),
            "Connection": ["keep-alive"],
            "Content-Type": ["application/octet-stream"]
          }
        }
      } : {
        "network": "tcp"
      };
    case "ws":
      return {
        "network": "ws",
        "ws-opts": {
          "path": path,
          "max-early-data": earlyData,
          "early-data-header-name": earlyData ? "Sec-WebSocket-Protocol" : void 0,
          "headers": {
            "Host": host
          }
        }
      };
    case "httpupgrade":
      const { _V2_ } = DICT;
      return {
        "network": "ws",
        "ws-opts": {
          [`${_V2_}-http-upgrade`]: true,
          [`${_V2_}-http-upgrade-fast-open`]: true,
          "path": path,
          "headers": {
            "Host": host
          }
        }
      };
    case "grpc":
      return {
        "network": "grpc",
        "grpc-opts": {
          "grpc-service-name": serviceName
        }
      };
    default:
      return {};
  }
}

// src/cores/clash/inbounds.ts
var tun = {
  "enable": true,
  "stack": "mixed",
  "auto-route": true,
  "strict-route": true,
  "auto-detect-interface": true,
  "dns-hijack": [
    "any:53",
    "tcp://any:53"
  ],
  "mtu": 9e3
};
var sniffer = {
  "enable": true,
  "force-dns-mapping": true,
  "parse-pure-ip": true,
  "override-destination": true,
  "sniff": {
    "HTTP": {
      "ports": [80, 8080, 8880, 2052, 2082, 2086, 2095]
    },
    "TLS": {
      "ports": [443, 8443, 2053, 2083, 2087, 2096]
    }
  }
};

// src/cores/clash/configs.ts
async function buildConfig(ctx, outbounds, selectorTags, proxyTags, chainTags, isChain, isWarp, isPro) {
  const { logLevel, allowLANConnection } = ctx.settings;
  const tcpSettings = isWarp ? {} : {
    "disable-keep-alive": false,
    "keep-alive-idle": 10,
    "keep-alive-interval": 15,
    "tcp-concurrent": true
  };
  const config = {
    "mixed-port": 7890,
    "ipv6": true,
    "allow-lan": allowLANConnection,
    "unified-delay": false,
    "log-level": logLevel.replace("none", "silent"),
    "mode": "rule",
    ...tcpSettings,
    "geo-auto-update": true,
    "geo-update-interval": 168,
    "external-controller": "127.0.0.1:9090",
    "external-controller-cors": {
      "allow-origins": ["*"],
      "allow-private-network": true
    },
    "external-ui": "ui",
    "external-ui-url": "https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip",
    "profile": {
      "store-selected": true,
      "store-fake-ip": true
    },
    "dns": await buildDNS(ctx, isChain, isWarp, isPro),
    "tun": tun,
    "sniffer": sniffer,
    "proxies": outbounds,
    "proxy-groups": [
      {
        "name": "\u2705 Selector",
        "type": "select",
        "proxies": selectorTags
      }
    ],
    "rule-providers": buildRuleProviders(ctx),
    "rules": buildRoutingRules(ctx, isWarp),
    "ntp": {
      "enable": true,
      "server": "time.cloudflare.com",
      "port": 123,
      "interval": 30
    }
  };
  const name = isWarp ? `\u{1F4A6} Warp ${isPro ? "Pro " : ""}- Best Ping \u{1F680}` : "\u{1F4A6} Best Ping \u{1F680}";
  const mainUrlTest = buildUrlTest(ctx, name, proxyTags, isWarp);
  config["proxy-groups"].push(mainUrlTest);
  if (isWarp) config["proxy-groups"].push(buildUrlTest(ctx, `\u{1F4A6} WoW ${isPro ? "Pro " : ""}- Best Ping \u{1F680}`, chainTags, isWarp));
  if (isChain) config["proxy-groups"].push(buildUrlTest(ctx, "\u{1F4A6} \u{1F517} Best Ping \u{1F680}", chainTags, isWarp));
  return config;
}
async function getClNormalConfig(ctx) {
  const { outProxy, ports } = ctx.settings;
  const chainProxy = outProxy ? buildChainOutbound(ctx) : void 0;
  const isChain = !!chainProxy;
  const proxyTags = [];
  const chainTags = [];
  const outbounds = [];
  const Addresses = await getConfigAddresses(ctx, false);
  const protocols = getProtocols(ctx);
  const selectorTags = ["\u{1F4A6} Best Ping \u{1F680}"].concatIf(isChain, "\u{1F4A6} \u{1F517} Best Ping \u{1F680}");
  protocols.forEach((protocol) => {
    let protocolIndex = 1;
    ports.forEach((port) => {
      Addresses.forEach((addr) => {
        const tag2 = generateRemark(ctx, protocolIndex, port, addr, protocol, false, false);
        const outbound = buildWebsocketOutbound(ctx, protocol, tag2, addr, port);
        if (outbound) {
          proxyTags.push(tag2);
          selectorTags.push(tag2);
          outbounds.push(outbound);
          if (isChain) {
            const chainTag = generateRemark(ctx, protocolIndex, port, addr, protocol, false, true);
            let chain = structuredClone(chainProxy);
            chain["name"] = chainTag;
            chain["dialer-proxy"] = tag2;
            outbounds.push(chain);
            chainTags.push(chainTag);
            selectorTags.push(chainTag);
          }
          protocolIndex++;
        }
      });
    });
  });
  const config = await buildConfig(
    ctx,
    outbounds,
    selectorTags,
    proxyTags,
    chainTags,
    isChain,
    false,
    false
  );
  return new Response(JSON.stringify(config, null, 4), {
    status: 200,
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "Cache-Control": "no-store",
      "CDN-Cache-Control": "no-store"
    }
  });
}
async function getClWarpConfig(ctx, isPro) {
  const { request, env, context } = ctx;
  const { warpEndpoints } = ctx.settings;
  const { warpAccounts } = await getDataset(request, env, context);
  const proxyTags = [];
  const chainTags = [];
  const outbounds = [];
  const proSign = isPro ? "Pro " : "";
  const selectorTags = [
    `\u{1F4A6} Warp ${proSign}- Best Ping \u{1F680}`,
    `\u{1F4A6} WoW ${proSign}- Best Ping \u{1F680}`
  ];
  warpEndpoints.forEach((endpoint, index) => {
    const warpTag = `\u{1F4A6} ${index + 1} - Warp ${proSign}\u{1F1EE}\u{1F1F7}`;
    proxyTags.push(warpTag);
    const wowTag = `\u{1F4A6} ${index + 1} - WoW ${proSign}\u{1F30D}`;
    chainTags.push(wowTag);
    selectorTags.push(warpTag, wowTag);
    const warpOutbound = buildWarpOutbound(ctx, warpAccounts[0], warpTag, endpoint, "", isPro);
    const wowOutbound = buildWarpOutbound(ctx, warpAccounts[1], wowTag, endpoint, warpTag, false);
    outbounds.push(warpOutbound, wowOutbound);
  });
  const config = await buildConfig(
    ctx,
    outbounds,
    selectorTags,
    proxyTags,
    chainTags,
    false,
    true,
    isPro
  );
  return new Response(JSON.stringify(config, null, 4), {
    status: 200,
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "Cache-Control": "no-store",
      "CDN-Cache-Control": "no-store"
    }
  });
}

// src/cores/sing-box/geo-assets.ts
function getGeoAssets2(ctx) {
  return getGeoAssetsShared(ctx, 'singbox');
}

// src/cores/sing-box/dns.ts
async function buildDNS2(ctx, isWarp, isChain) {
  const {
    localDNS,
    remoteDNS,
    warpRemoteDNS,
    antiSanctionDNS,
    outProxyParams,
    remoteDnsHost,
    enableIPv6,
    fakeDNS
  } = ctx.settings;
  const url = new URL(remoteDNS);
  const protocol = url.protocol.replace(":", "");
  const servers = [
    {
      type: isWarp ? "udp" : protocol,
      server: isWarp ? warpRemoteDNS : remoteDnsHost.host,
      detour: isWarp ? "\u{1F4A6} Warp - Best Ping \u{1F680}" : isChain ? "\u{1F4A6} Best Ping \u{1F680}" : "\u2705 Selector",
      tag: "dns-remote"
    }
  ];
  if (localDNS === "localhost") {
    addDnsServer(servers, "local", "dns-direct", void 0, void 0, void 0);
  } else {
    addDnsServer(servers, "udp", "dns-direct", localDNS, void 0, void 0);
  }
  const rules = [
    {
      clash_mode: "Direct",
      server: "dns-direct"
    },
    {
      clash_mode: "Global",
      server: "dns-remote"
    }
  ];
  if (isChain && !isWarp) {
    const { server } = outProxyParams;
    if (isDomain(server)) rules.push({
      domain: server,
      server: "dns-remote"
    });
  }
  if (remoteDnsHost.isDomain && !isWarp) {
    const { ipv4, ipv6, host } = remoteDnsHost;
    const predefined = ipv4.concatIf(enableIPv6, ipv6);
    addDnsServer(servers, "hosts", "hosts", void 0, void 0, void 0, host, predefined);
    rules.unshift({
      ip_accept_any: true,
      server: "hosts"
    });
  }
  const assets = getGeoAssets2(ctx);
  const dnsRules = accDnsRules(ctx, assets);
  const blockDomains = [
    ...dnsRules.block.geosites,
    ...dnsRules.block.domains
  ];
  if (blockDomains.length) {
    addDnsRule(
      rules,
      "reject",
      void 0,
      dnsRules.block.geosites,
      void 0,
      dnsRules.block.domains
    );
  }
  dnsRules.bypass.localDNS.geositeGeoips.forEach(({ geosite, geoip }) => {
    addDnsRule(
      rules,
      "dns-direct",
      void 0,
      [geosite],
      geoip,
      void 0
    );
  });
  const bypassDomains = [
    ...dnsRules.bypass.localDNS.geosites,
    ...dnsRules.bypass.localDNS.domains
  ];
  if (bypassDomains.length) {
    addDnsRule(
      rules,
      "dns-direct",
      void 0,
      dnsRules.bypass.localDNS.geosites,
      void 0,
      dnsRules.bypass.localDNS.domains
    );
  }
  const sanctionDomains = [
    ...dnsRules.bypass.antiSanctionDNS.geosites,
    ...dnsRules.bypass.antiSanctionDNS.domains
  ];
  if (sanctionDomains.length) {
    const dnsHost = getDomain(antiSanctionDNS);
    addDnsRule(
      rules,
      "dns-anti-sanction",
      void 0,
      dnsRules.bypass.antiSanctionDNS.geosites,
      void 0,
      dnsRules.bypass.antiSanctionDNS.domains
    );
    if (dnsHost.isHostDomain) {
      addDnsServer(servers, "https", "dns-anti-sanction", dnsHost.host, void 0, "dns-direct");
    } else {
      addDnsServer(servers, "udp", "dns-anti-sanction", antiSanctionDNS, void 0, void 0);
    }
  }
  if (fakeDNS) {
    addDnsServer(
      servers,
      "fakeip",
      "dns-fake",
      void 0,
      void 0,
      void 0,
      void 0,
      void 0,
      "198.18.0.0/15",
      enableIPv6 ? "fc00::/18" : void 0
    );
    addDnsRule(rules, "dns-fake", "tun-in", void 0, void 0, void 0, ["A", "AAAA"]);
  }
  return {
    servers,
    rules,
    strategy: enableIPv6 ? "prefer_ipv4" : "ipv4_only",
    independent_cache: true
  };
}
function addDnsServer(servers, type, tag2, server, detour, domain_resolver, host, predefined, inet4_range, inet6_range) {
  servers.push({
    type,
    server,
    detour,
    domain_resolver: domain_resolver ? {
      server: domain_resolver,
      strategy: "ipv4_only"
    } : void 0,
    predefined: host ? { [host]: predefined } : void 0,
    inet4_range,
    inet6_range,
    tag: tag2
  });
}
function addDnsRule(rules, dns, inbound, geosite, geoip, domain, query_type) {
  const isPair = geosite && geoip;
  rules.push({
    inbound,
    type: isPair ? "logical" : void 0,
    mode: isPair ? "and" : void 0,
    rules: isPair ? [
      { rule_set: geosite },
      { rule_set: geoip }
    ] : void 0,
    rule_set: geosite?.length && !geoip ? geosite : void 0,
    domain_suffix: domain?.omitEmpty(),
    query_type,
    action: dns === "reject" ? "reject" : "route",
    server: dns === "reject" ? void 0 : dns
  });
}

// src/cores/sing-box/routing.ts
function buildRoutingRules2(ctx, isWarp, isChain) {
  const { blockUDP443, enableIPv6 } = ctx.settings;
  const rules = [
    {
      ip_cidr: "172.19.0.2",
      action: "hijack-dns"
    },
    {
      clash_mode: "Direct",
      outbound: "direct"
    },
    {
      clash_mode: "Global",
      outbound: "\u2705 Selector"
    },
    {
      action: "sniff"
    },
    {
      protocol: "dns",
      action: "hijack-dns"
    },
    {
      ip_is_private: true,
      outbound: "direct"
    }
  ];
  if (!isWarp) {
    addRoutingRule(rules, "reject", void 0, void 0, void 0, void 0, "udp");
  } else if (blockUDP443) {
    addRoutingRule(rules, "reject", void 0, void 0, void 0, void 0, "udp", "quic", 443);
  }
  const geoAssets = getGeoAssets2(ctx);
  const routingRules = accRoutingRules(ctx, geoAssets);
  const blockDomains = [
    ...routingRules.block.geosites,
    ...routingRules.block.domains
  ];
  if (blockDomains.length) {
    addRoutingRule(rules, "reject", routingRules.block.domains, void 0, routingRules.block.geosites);
  }
  const blockIPs = [
    ...routingRules.block.geoips,
    ...routingRules.block.ips
  ];
  if (blockIPs.length) {
    addRoutingRule(rules, "reject", void 0, routingRules.block.ips, void 0, routingRules.block.geoips);
  }
  const bypassDomains = [
    ...routingRules.bypass.geosites,
    ...routingRules.bypass.domains
  ];
  if (bypassDomains.length) {
    addRoutingRule(rules, "direct", routingRules.bypass.domains, void 0, routingRules.bypass.geosites);
  }
  const bypassIPs = [
    ...routingRules.bypass.geoips,
    ...routingRules.bypass.ips
  ];
  if (bypassIPs.length) {
    addRoutingRule(rules, "direct", void 0, routingRules.bypass.ips, void 0, routingRules.bypass.geoips);
  }
  const strategy = enableIPv6 ? "prefer_ipv4" : "ipv4_only";
  const ruleSets = geoAssets.reduce((sets, asset) => {
    addRuleSets(sets, asset);
    return sets;
  }, []);
  return {
    rules,
    rule_set: ruleSets.omitEmpty(),
    auto_detect_interface: true,
    default_domain_resolver: {
      server: "dns-direct",
      strategy,
      rewrite_ttl: 60
    },
    final: "\u2705 Selector"
  };
}
function addRoutingRule(rules, type, domain, ip, geosite, geoip, network, protocol, port) {
  rules.push({
    rule_set: geosite || geoip,
    domain_suffix: domain?.length ? domain : void 0,
    ip_cidr: ip?.length ? ip : void 0,
    network,
    protocol,
    port,
    action: type === "reject" ? "reject" : "route",
    outbound: type === "direct" ? "direct" : void 0
  });
}
function addRuleSets(ruleSets, geoAsset) {
  const { geosite, geositeURL, geoip, geoipURL } = geoAsset;
  const addRuleSet = (geo, url) => ruleSets.push({
    type: "remote",
    tag: geo,
    format: "binary",
    url,
    download_detour: "direct"
  });
  if (geosite && geositeURL) addRuleSet(geosite, geositeURL);
  if (geoip && geoipURL) addRuleSet(geoip, geoipURL);
}

// src/cores/sing-box/outbounds.ts
function buildOutbound2(tag2, type, server, server_port, tcp_fast_open, fields, tls, transport) {
  return {
    tag: tag2,
    type,
    server,
    server_port,
    tcp_fast_open,
    ...fields,
    tls,
    transport
  };
}
function buildSingboxOutbound(ctx, protocol, remark, address, port, isFragment) {
  const {
    dict: { _VL_, _TR_ },
    globalConfig: { userID, TrPass },
    settings: { fingerprint, enableTFO, enableECH, echConfig }
  } = ctx;
  const { host, sni, allowInsecure } = selectSniHost(ctx, address);
  const transport = buildTransport2("ws", "none", generateWsPath(ctx, protocol), host, void 0, 2560);
  const tls = isHttps(ctx, port) ? buildSingboxTLS(
    protocol,
    "tls",
    allowInsecure,
    sni,
    enableECH && !isFragment ? echConfig : void 0,
    "http/1.1",
    fingerprint
  ) : void 0;
  if (protocol === _VL_) return buildOutbound2(remark, protocol, address, port, enableTFO, {
    uuid: userID,
    packet_encoding: "",
    network: "tcp"
  }, tls, transport);
  return buildOutbound2(remark, protocol, address, port, enableTFO, {
    password: TrPass,
    network: "tcp"
  }, tls, transport);
}
function buildSingboxWarpOutbound(ctx, warpAccount, remark, endpoint, chain, isPro) {
  const {
    amneziaNoiseCount,
    amneziaNoiseSizeMin,
    amneziaNoiseSizeMax,
    enableIPv6
  } = ctx.settings;
  const { host, port } = parseHostPort(endpoint, false);
  const {
    warpIPv6,
    reserved,
    publicKey,
    privateKey
  } = warpAccount;
  return {
    tag: remark,
    detour: chain || void 0,
    type: "wireguard",
    address: [
      "172.16.0.2/32",
      warpIPv6
    ],
    mtu: 1280,
    peers: [
      {
        address: chain ? "162.159.192.1" : host,
        port: chain ? 2408 : port,
        public_key: publicKey,
        reserved: base64ToDecimal(reserved),
        allowed_ips: [
          "0.0.0.0/0",
          "::/0"
        ],
        persistent_keepalive_interval: 5
      }
    ],
    private_key: privateKey
  };
}
function buildChainOutbound2(ctx) {
  const {
    dict: { _VL_, _TR_, _SS_, _VM_ },
    settings: {
      outProxy,
      outProxyParams: {
        protocol,
        server,
        port,
        user,
        pass,
        password,
        method,
        uuid,
        flow,
        security,
        type,
        sni,
        fp,
        host,
        path,
        alpn,
        pbk,
        sid,
        headerType,
        serviceName,
        aid
      }
    }
  } = ctx;
  const { searchParams } = new URL(outProxy);
  const ed = searchParams.get("ed");
  const earlyData = ed ? +ed : void 0;
  const tls = buildSingboxTLS(protocol, security, false, sni || server, void 0, alpn, fp, pbk, sid);
  const transport = buildTransport2(type, headerType, path, host, serviceName, earlyData);
  switch (protocol) {
    case "http":
      return buildOutbound2("", protocol, server, port, false, {
        username: user,
        password: pass
      });
    case "socks":
      return buildOutbound2("", protocol, server, port, false, {
        username: user,
        password: pass,
        version: "5",
        network: "tcp"
      });
    case _SS_:
      return buildOutbound2("", protocol, server, port, false, {
        method,
        password,
        network: "tcp"
      });
    case _VL_:
      return buildOutbound2("", protocol, server, port, false, {
        uuid,
        flow,
        network: "tcp"
      }, tls, transport);
    case _VM_:
      return buildOutbound2("", protocol, server, port, false, {
        uuid,
        security: "auto",
        alter_id: aid,
        network: "tcp"
      }, tls, transport);
    case _TR_:
      return buildOutbound2("", protocol, server, port, false, {
        password,
        network: "tcp"
      }, tls, transport);
    default:
      return void 0;
  }
  ;
}
function buildSingboxUrlTest(ctx, tag2, outboundTags, isWarp) {
  const { bestWarpInterval, bestVLTRInterval } = ctx.settings;
  return {
    type: "urltest",
    tag: tag2,
    outbounds: outboundTags,
    url: "https://www.gstatic.com/generate_204",
    interrupt_exist_connections: false,
    interval: isWarp ? `${bestWarpInterval}s` : `${bestVLTRInterval}s`
  };
}
function buildSingboxTLS(protocol, security, allowInsecure, sni, echConfig, alpn, fingerprint, publicKey, shortID) {
  if (!["tls", "reality"].includes(security)) return void 0;
  const tlsAlpns = alpn?.split(",").filter((value) => value !== "h2");
  const tls = {
    enabled: true,
    server_name: sni,
    record_fragment: protocol === DICT._TR_, // Assuming isFragment is derived from protocol for Sing-box
    insecure: allowInsecure,
    alpn: tlsAlpns,
    utls: {
      enabled: !!fingerprint,
      fingerprint
    },
    ech: echConfig ? {
      enabled: true,
      config: echBase64ToPEM(echConfig)
    } : void 0
  };
  if (security === "tls") return tls;
  if (security === "reality" && publicKey && shortID) return {
    ...tls,
    reality: {
      enabled: true,
      public_key: publicKey,
      short_id: shortID
    }
  };
}
function echBase64ToPEM(config) {
  const clean = config.replace(/\s+/g, "");
  const lines = [];
  for (let i = 0; i < clean.length; i += 64) {
    lines.push(clean.slice(i, i + 64));
  }
  return [
    "-----BEGIN ECH CONFIGS-----",
    ...lines,
    "-----END ECH CONFIGS-----"
  ].join("\n");
}
function buildTransport2(type, headerType, path = "/", host, serviceName, earlyData) {
  path = path?.split("?")[0];
  switch (type) {
    case "tcp":
      if (headerType === "http") return {
        type: "http",
        host: host?.split(","),
        path,
        method: "GET",
        headers: {
          "Connection": ["keep-alive"],
          "Content-Type": ["application/octet-stream"]
        }
      };
      return void 0;
    case "ws":
      return {
        type: "ws",
        path: path?.split("?ed=")[0],
        max_early_data: earlyData,
        early_data_header_name: earlyData ? "Sec-WebSocket-Protocol" : void 0,
        headers: {
          Host: host
        }
      };
    case "httpupgrade":
      return {
        type: "httpupgrade",
        host,
        path: path?.split("?ed=")[0]
      };
    case "grpc":
      return {
        type: "grpc",
        service_name: serviceName
      };
    default:
      return void 0;
  }
}

// src/cores/sing-box/inbounds.ts
var tun2 = {
  type: "tun",
  tag: "tun-in",
  address: ["172.19.0.1/28"],
  mtu: 9e3,
  auto_route: true,
  strict_route: true,
  stack: "mixed"
};
function buildMixedInbound(ctx) {
  const { allowLANConnection } = ctx.settings;
  return {
    type: "mixed",
    tag: "mixed-in",
    listen: allowLANConnection ? "0.0.0.0" : "127.0.0.1",
    listen_port: 2080
  };
}

// src/cores/sing-box/configs.ts
async function buildSingboxConfig(ctx, outbounds, selectorTags, proxyTags, chainTags, isChain, isWarp) {
  const { logLevel, allowLANConnection } = ctx.settings;
  const config = {
    log: {
      disabled: logLevel === "none",
      level: logLevel === "none" ? void 0 : logLevel === "warning" ? "warn" : logLevel,
      timestamp: true
    },
    dns: await buildDNS2(ctx, isWarp, isChain),
    inbounds: [
      tun2,
      buildMixedInbound(ctx)
    ],
    outbounds: [
      ...outbounds,
      {
        type: "selector",
        tag: "\u2705 Selector",
        outbounds: selectorTags,
        interrupt_exist_connections: false
      },
      {
        type: "direct",
        tag: "direct"
      }
    ],
    endpoints: [], // This was `endpoints.omitEmpty()` in original, but `endpoints` is not passed to this function. Assuming it should be empty array.
    route: buildRoutingRules2(ctx, isWarp, isChain),
    ntp: {
      enabled: true,
      server: "time.cloudflare.com",
      server_port: 123,
      domain_resolver: "dns-direct",
      interval: "30m",
      write_to_system: false
    },
    experimental: {
      cache_file: {
        enabled: true,
        store_fakeip: true
      },
      clash_api: {
        external_controller: "127.0.0.1:9090",
        external_ui: "ui",
        default_mode: "Rule",
        external_ui_download_url: "https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip",
        external_ui_download_detour: "direct"
      }
    }
  };
  const tag2 = isWarp ? `\u{1F4A6} Warp - Best Ping \u{1F680}` : "\u{1F4A6} Best Ping \u{1F680}";
  const mainUrlTest = buildSingboxUrlTest(ctx, tag2, proxyTags, isWarp);
  config.outbounds.push(mainUrlTest);
  if (isWarp) config.outbounds.push(buildSingboxUrlTest(ctx, `\u{1F4A6} WoW - Best Ping \u{1F680}`, chainTags, isWarp));
  if (isChain) config.outbounds.push(buildSingboxUrlTest(ctx, "\u{1F4A6} \u{1F517} Best Ping \u{1F680}", chainTags, isWarp));
  return config;
}
async function getSbCustomConfig(ctx, isFragment) {
  const { outProxy, ports } = ctx.settings;
  const chainProxy = outProxy ? buildChainOutbound2(ctx) : void 0;
  const isChain = !!chainProxy;
  const proxyTags = [];
  const chainTags = [];
  const outbounds = [];
  const Addresses = await getConfigAddresses(ctx, isFragment);
  const protocols = getProtocols(ctx);
  const totalPorts = ports.filter((port) => !isFragment || isHttps(ctx, port));
  const selectorTags = ["\u{1F4A6} Best Ping \u{1F680}"].concatIf(isChain, "\u{1F4A6} \u{1F517} Best Ping \u{1F680}");
  protocols.forEach((protocol) => {
    let protocolIndex = 1;
    totalPorts.forEach((port) => {
      Addresses.forEach((addr) => {
        const tag2 = generateRemark(ctx, protocolIndex, port, addr, protocol, isFragment, false);
        const outbound = buildSingboxOutbound(ctx, protocol, tag2, addr, port, isFragment);
        outbounds.push(outbound);
        proxyTags.push(tag2);
        selectorTags.push(tag2);
        if (isChain) {
          const chainTag = generateRemark(ctx, protocolIndex, port, addr, protocol, isFragment, true);
          let chain = structuredClone(chainProxy);
          chain["tag"] = chainTag;
          chain["detour"] = tag2;
          outbounds.push(chain);
          chainTags.push(chainTag);
          selectorTags.push(chainTag);
        }
        protocolIndex++;
      });
    });
  });
  const config = await buildSingboxConfig(
    ctx,
    outbounds,
    selectorTags,
    proxyTags,
    chainTags,
    isChain,
    false
  );
  return new Response(JSON.stringify(config, null, 4), {
    status: 200,
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "Cache-Control": "no-store",
      "CDN-Cache-Control": "no-store"
    }
  });
}

async function getSbWarpConfig(ctx) {
  const { request, env, context } = ctx;
  const { warpEndpoints } = ctx.settings;
  const { warpAccounts } = await getDataset(request, env, context);
  const outbounds = [];
  const selectorTags = [
    "\u{1F4A6} Warp - Best Ping \u{1F680}",
    "\u{1F4A6} WoW - Best Ping \u{1F680}"
  ];
  const proxyTags = [];
  const chainTags = [];

  warpEndpoints.forEach((endpoint, index) => {
    const warpTag = `\u{1F4A6} ${index + 1} - Warp \u{1F1EE}\u{1F1F7}`;
    const wowTag = `\u{1F4A6} ${index + 1} - WoW \u{1F30D}`;
    
    proxyTags.push(warpTag);
    chainTags.push(wowTag);
    
    const warpOutbound = buildSingboxWarpOutbound(ctx, warpAccounts[0], warpTag, endpoint, null, false);
    const wowOutbound = buildSingboxWarpOutbound(ctx, warpAccounts[1], wowTag, endpoint, warpTag, false);
    outbounds.push(warpOutbound, wowOutbound);
  });

  const config = await buildSingboxConfig(
    ctx,
    outbounds,
    selectorTags,
    proxyTags,
    chainTags,
    false,
    true
  );

  return new Response(JSON.stringify(config, null, 4), {
    status: 200,
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "Cache-Control": "no-store",
      "CDN-Cache-Control": "no-store"
    }
  });
}

// src/cores/xray/geo-assets.ts
function getGeoAssets3(ctx) {
  return getGeoAssetsShared(ctx, 'xray');
}

// src/cores/xray/dns.ts
async function buildDNS3(ctx, outboundAddrs, isWorkerLess, isWarp, domainToStaticIPs, customDns, customDnsHosts) {
  const {
    localDNS,
    remoteDNS,
    warpRemoteDNS,
    antiSanctionDNS,
    remoteDnsHost,
    enableIPv6,
    fakeDNS
  } = ctx.settings;
  const hosts = {};
  const servers = [];
  const fakeDnsDomains = [];
  if (remoteDnsHost.isDomain && !isWorkerLess && !isWarp) {
    const { ipv4, ipv6, host } = remoteDnsHost;
    hosts[host] = ipv4.concatIf(enableIPv6, ipv6);
  }
  if (domainToStaticIPs) {
    const { ipv4, ipv6 } = await resolveDNS(domainToStaticIPs, enableIPv6, ctx.globalConfig.dohURL);
    hosts[domainToStaticIPs] = [...ipv4, ...ipv6];
  }
  let skipFallback = true;
  let finalRemoteDNS = isWarp ? warpRemoteDNS : remoteDNS;
  if (isWorkerLess) {
    finalRemoteDNS = `https://${customDns}/dns-query`;
    if (customDns && customDnsHosts) hosts[customDns] = customDnsHosts;
    skipFallback = false;
  }
  const remoteDnsServer = buildDnsServer(finalRemoteDNS, void 0, void 0, void 0, void 0, "remote-dns");
  servers.push(remoteDnsServer);
  const geoAssets = getGeoAssets3(ctx);
  const dnsRules = accDnsRules(ctx, geoAssets);
  const blockDomains = [
    ...dnsRules.block.geosites,
    ...dnsRules.block.domains.map((domain) => `domain:${domain}`)
  ];
  blockDomains.forEach((domain) => hosts[domain] = "#3");
  dnsRules.bypass.localDNS.geositeGeoips.forEach(({ geosite, geoip }) => {
    const localDnsServer = buildDnsServer(localDNS, [geosite], [geoip], skipFallback);
    servers.push(localDnsServer);
    fakeDnsDomains.push(geosite);
  });
  const sanctionDomains = [
    ...dnsRules.bypass.antiSanctionDNS.geosites,
    ...dnsRules.bypass.antiSanctionDNS.domains.map((domain) => `domain:${domain}`)
  ];
  const bypassDomains = [
    ...dnsRules.bypass.localDNS.geosites,
    ...dnsRules.bypass.localDNS.domains.map((domain) => `domain:${domain}`),
    ...outboundAddrs.filter(isDomain).map((domain) => `full:${domain}`)
  ];
  if (sanctionDomains.length) {
    const sanctionDnsServer = buildDnsServer(antiSanctionDNS, sanctionDomains, void 0, skipFallback, true);
    servers.push(sanctionDnsServer);
    const { host, isHostDomain } = getDomain(antiSanctionDNS);
    if (isHostDomain) bypassDomains.push(`full:${host}`);
  }
  customDnsHosts?.filter(isDomain).forEach((host) => bypassDomains.push(`full:${host}`));
  if (bypassDomains.length) {
    const localDnsServer = buildDnsServer(localDNS, bypassDomains, void 0, skipFallback);
    servers.push(localDnsServer);
    fakeDnsDomains.push(...bypassDomains);
  }
  if (fakeDNS) {
    const fakeDNSServer = fakeDnsDomains.length ? buildDnsServer("fakedns", fakeDnsDomains, void 0, false, void 0) : "fakedns";
    servers.unshift(fakeDNSServer);
  }
  return {
    hosts: hosts.omitEmpty(),
    servers,
    queryStrategy: isWarp && !enableIPv6 ? "UseIPv4" : "UseIP",
    tag: "dns"
  };
}
function buildDnsServer(address, domains, expectIPs, skipFallback, finalQuery, tag2) {
  return {
    address,
    domains,
    expectIPs,
    skipFallback,
    finalQuery,
    tag: tag2
  };
}

// src/cores/xray/routing.ts
function buildRoutingRules3(ctx, isChain, isBalancer, isWorkerless, isWarp) {
  const { blockUDP443 } = ctx.settings;
  const rules = [
    {
      inboundTag: [
        "mixed-in"
      ],
      port: 53,
      outboundTag: "dns-out",
      type: "field"
    },
    {
      inboundTag: [
        "dns-in"
      ],
      outboundTag: "dns-out",
      type: "field"
    }
  ];
  const finallOutboundTag = isChain ? "chain" : isWorkerless ? "direct" : "proxy";
  const outTag = isBalancer ? isChain ? "all-chains" : "all-proxies" : finallOutboundTag;
  const remoteDnsProxy = isBalancer ? "all-proxies" : "proxy";
  addRoutingRule2(rules, ["remote-dns"], void 0, void 0, void 0, void 0, void 0, remoteDnsProxy, isBalancer);
  addRoutingRule2(rules, ["dns"], void 0, void 0, void 0, void 0, void 0, "direct", false);
  addRoutingRule2(rules, void 0, ["geosite:private"], void 0, void 0, void 0, void 0, "direct", false);
  addRoutingRule2(rules, void 0, void 0, ["geoip:private"], void 0, void 0, void 0, "direct", false);
  if (!(isWarp || isWorkerless)) {
    addRoutingRule2(rules, void 0, void 0, void 0, void 0, "udp", void 0, "block", false);
  } else if (blockUDP443) {
    addRoutingRule2(rules, void 0, void 0, void 0, 443, "udp", void 0, "block", false);
  }
  const geoRules = getGeoAssets3(ctx);
  const routingRules = accRoutingRules(ctx, geoRules);
  const blockDomains = [
    ...routingRules.block.geosites,
    ...routingRules.block.domains.map((domain) => `domain:${domain}`)
  ];
  if (blockDomains.length) {
    addRoutingRule2(rules, void 0, blockDomains, void 0, void 0, void 0, void 0, "block");
  }
  const blockIPs = [
    ...routingRules.block.geoips,
    ...routingRules.block.ips
  ];
  if (blockIPs.length) {
    addRoutingRule2(rules, void 0, void 0, blockIPs, void 0, void 0, void 0, "block");
  }
  const bypassDomains = [
    ...routingRules.bypass.geosites,
    ...routingRules.bypass.domains.map((domain) => `domain:${domain}`)
  ];
  if (bypassDomains.length) {
    addRoutingRule2(rules, void 0, bypassDomains, void 0, void 0, void 0, void 0, "direct");
  }
  const bypassIPs = [
    ...routingRules.bypass.geoips,
    ...routingRules.bypass.ips
  ];
  if (bypassIPs.length) {
    addRoutingRule2(rules, void 0, void 0, bypassIPs, void 0, void 0, void 0, "direct");
  }
  if (isWorkerless) {
    addRoutingRule2(rules, void 0, void 0, void 0, void 0, "tcp", ["tls"], "proxy", false);
    addRoutingRule2(rules, void 0, void 0, void 0, void 0, "tcp", ["http"], "http-fragment", false);
    addRoutingRule2(rules, void 0, void 0, void 0, void 0, "udp", ["quic"], "udp-noise", false);
    addRoutingRule2(rules, void 0, void 0, void 0, "443,2053,2083,2087,2096,8443", "udp", void 0, "udp-noise", false);
  }
  const network = isWarp || isWorkerless ? "tcp,udp" : "tcp";
  addRoutingRule2(rules, void 0, void 0, void 0, void 0, network, void 0, outTag, isBalancer);
  return rules;
}
var addRoutingRule2 = (rules, inboundTag, domain, ip, port, network, protocol, outboundTag, isBalancer) => rules.push({
  inboundTag,
  domain,
  ip,
  port,
  network,
  protocol,
  balancerTag: isBalancer ? outboundTag : void 0,
  outboundTag: isBalancer ? void 0 : outboundTag,
  type: "field"
});

// src/cores/xray/inbounds.ts
function buildMixedInbound2(allowLANConnection, sniffQuic, sniffFakeDNS) {
  const destOverride = ["http", "tls"].concatIf(sniffQuic, "quic").concatIf(sniffFakeDNS, "fakedns");
  return {
    listen: allowLANConnection ? "0.0.0.0" : "127.0.0.1",
    port: 10808,
    protocol: "socks",
    settings: {
      auth: "noauth",
      udp: true
    },
    sniffing: {
      destOverride,
      enabled: true,
      routeOnly: true
    },
    tag: "mixed-in"
  };
}
function buildDokodemoInbound(allowLANConnection) {
  return {
    listen: allowLANConnection ? "0.0.0.0" : "127.0.0.1",
    port: 10853,
    protocol: "dokodemo-door",
    settings: {
      address: "1.1.1.1",
      network: "tcp,udp",
      port: 53
    },
    tag: "dns-in"
  };
}

// src/cores/xray/outbounds.ts
function buildOutbound3(protocol, tag2, enableMux, settings, streamSettings) {
  return {
    protocol,
    mux: enableMux ? {
      enabled: true,
      concurrency: 8,
      xudpConcurrency: 16,
      xudpProxyUDP443: "reject"
    } : void 0,
    settings,
    streamSettings,
    tag: tag2
  };
}
function buildFreedomOutbound(ctx, isFragment, isUdpNoises, tag2, length, interval, packets) {
  const {
    fragmentPackets,
    fragmentLengthMin,
    fragmentLengthMax,
    fragmentIntervalMin,
    fragmentIntervalMax,
    fragmentMaxSplitMin,
    fragmentMaxSplitMax,
    enableTFO,
    xrayUdpNoises,
    enableIPv6
  } = ctx.settings;
  let freedomSettings = {};
  let streamSettings;
  if (isFragment) {
    freedomSettings = {
      fragment: {
        packets: packets || fragmentPackets,
        length: length || toRange(fragmentLengthMin, fragmentLengthMax),
        interval: interval || toRange(fragmentIntervalMin, fragmentIntervalMax),
        maxSplit: toRange(fragmentMaxSplitMin, fragmentMaxSplitMax)
      }
    };
    streamSettings = {
      sockopt: buildSockopt(true, enableTFO, "UseIP")
    };
  }
  if (isUdpNoises) {
    const freedomNoises = [];
    xrayUdpNoises.forEach((noise) => {
      const { count, ...rest } = noise;
      freedomNoises.push(...Array.from({ length: count }, () => rest));
    });
    freedomSettings = {
      ...freedomSettings,
      noises: freedomNoises,
      domainStrategy: isFragment ? void 0 : enableIPv6 ? "UseIPv4v6" : "UseIPv4"
    };
  }
  return {
    protocol: "freedom",
    settings: freedomSettings,
    streamSettings,
    tag: tag2
  };
}
function buildWebsocketOutbound3(ctx, protocol, address, port, isFragment) {
  const {
    settings: {
      fingerprint,
      enableTFO,
      enableECH,
      echConfig
    },
    globalConfig: { userID, TrPass },
    dict: { _VL_ }
  } = ctx;
  const isTLS = isHttps(ctx, port);
  const { host, sni, allowInsecure } = selectSniHost(ctx, address);
  const tlsSettings = isTLS ? buildTlsSettings(
    sni,
    fingerprint,
    "http/1.1",
    allowInsecure,
    enableECH && !isFragment ? echConfig : void 0
  ) : void 0;
  const streamSettings = {
    network: "ws",
    ...buildTransport3("ws", "none", `${generateWsPath(ctx, protocol)}?ed=2560`, host),
    security: isTLS ? "tls" : "none",
    tlsSettings,
    sockopt: isFragment ? buildSockopt(false, false, void 0, "fragment") : buildSockopt(true, enableTFO, "UseIP")
  };
  if (protocol === _VL_) return buildOutbound3(protocol, "proxy", false, {
    vnext: [{
      address,
      port,
      users: [
        {
          id: userID,
          encryption: "none"
        }
      ]
    }]
  }, streamSettings);
  return buildOutbound3(protocol, "proxy", false, {
    servers: [{
      address,
      port,
      password: TrPass
    }]
  }, streamSettings);
}
function buildWarpOutbound3(ctx, warpAccount, endpoint, isWoW, isPro) {
  const {
    warpIPv6,
    reserved,
    publicKey,
    privateKey
  } = warpAccount;
  const { client } = ctx.httpConfig;
  let wgSettings = {
    address: [
      "172.16.0.2/32",
      warpIPv6
    ],
    mtu: 1280,
    peers: [
      {
        endpoint: isWoW ? "162.159.192.1:2408" : endpoint,
        publicKey,
        keepAlive: 5
      }
    ],
    reserved: base64ToDecimal(reserved),
    secretKey: privateKey
  };
  const chain = isWoW ? "proxy" : isPro && client === "xray" ? "udp-noise" : "";
  const streamSettings = chain ? {
    sockopt: buildSockopt(false, false, void 0, chain)
  } : void 0;
  if (client === "xray-knocker" && !isWoW) {
    const {
      knockerNoiseMode,
      noiseCountMin,
      noiseCountMax,
      noiseSizeMin,
      noiseSizeMax,
      noiseDelayMin,
      noiseDelayMax
    } = ctx.settings;
    wgSettings = {
      ...wgSettings,
      wnoise: knockerNoiseMode,
      wnoisecount: toRange(noiseCountMin, noiseCountMax),
      wpayloadsize: toRange(noiseSizeMin, noiseSizeMax),
      wnoisedelay: toRange(noiseDelayMin, noiseDelayMax)
    };
  }
  return {
    protocol: "wireguard",
    settings: wgSettings,
    streamSettings,
    tag: isWoW ? "chain" : "proxy"
  };
}
function buildChainOutbound3(ctx) {
  const {
    dict: { _VL_, _TR_, _SS_, _VM_ },
    settings: {
      outProxyParams: {
        protocol,
        server: address,
        port,
        user,
        pass,
        password,
        method,
        uuid,
        flow,
        security,
        type,
        sni,
        fp,
        host,
        path,
        alpn,
        pbk,
        sid,
        spx,
        headerType,
        serviceName,
        mode,
        authority
      }
    }
  } = ctx;
  const streamSettings = {
    network: type || "raw",
    ...buildTransport3(type, headerType, path, host, serviceName, mode, authority),
    security,
    tlsSettings: security === "tls" ? buildTlsSettings(sni || address, fp, alpn, false) : void 0,
    realitySettings: security === "reality" ? buildRealitySettings(sni, fp, pbk, sid, spx) : void 0,
    sockopt: buildSockopt(false, false, "UseIPv4", "proxy")
  };
  const enableMux = !(security === "reality" || type === "grpc");
  switch (protocol) {
    case "http":
    case "socks":
      return buildOutbound3(protocol, "chain", enableMux, {
        servers: [{
          address,
          port,
          users: [{
            user,
            pass
          }]
        }]
      }, streamSettings);
    case _SS_:
      return buildOutbound3(protocol, "chain", enableMux, {
        servers: [{
          address,
          port,
          method,
          password
        }]
      }, streamSettings);
    case _VL_:
      return buildOutbound3(protocol, "chain", enableMux, {
        vnext: [{
          address,
          port,
          users: [{
            id: uuid,
            flow,
            encryption: "none"
          }]
        }]
      }, streamSettings);
    case _VM_:
      return buildOutbound3(protocol, "chain", enableMux, {
        vnext: [{
          address,
          port,
          users: [{
            id: uuid,
            security: "auto"
          }]
        }]
      }, streamSettings);
    case _TR_:
      return buildOutbound3(protocol, "chain", enableMux, {
        servers: [{
          address,
          port,
          password
        }]
      }, streamSettings);
    default:
      return void 0;
  }
}
function buildTransport3(type, headerType, path = "/", host, serviceName, mode, authority) {
  switch (type) {
    case "tcp":
    case "raw":
      return {
        rawSettings: {
          header: headerType === "http" ? {
            type: "http",
            request: {
              headers: {
                "Host": host?.split(","),
                "Accept-Encoding": ["gzip, deflate"],
                "Connection": ["keep-alive"],
                "Pragma": "no-cache"
              },
              path: path.split(","),
              method: "GET",
              version: "1.1"
            }
          } : { type: "none" }
        }
      };
    case "ws":
      return {
        wsSettings: {
          host,
          path
        }
      };
    case "httpupgrade":
      return {
        httpupgradeSettings: {
          host,
          path
        }
      };
    case "grpc":
      return {
        grpcSettings: {
          authority,
          multiMode: mode === "multi",
          serviceName
        }
      };
    default:
      return {};
  }
  ;
}
function buildSockopt(enableHappyEyeballs, tcpFastOpen, domainStrategy, dialerProxy) {
  return {
    domainStrategy,
    dialerProxy,
    tcpFastOpen: tcpFastOpen || true, // Force TFO if supported
    tcpKeepAliveInterval: 30,
    tcpKeepAliveIdle: 60,
    happyEyeballs: enableHappyEyeballs ? {
      tryDelayMs: 150, // Optimized for speed (was 250)
      prioritizeIPv6: false,
      interleave: 2,
      maxConcurrentTry: 2 // Reduced to 2 to avoid flooding
    } : void 0
  };
}
function buildTlsSettings(serverName, fingerprint, alpn, allowInsecure, echConfigList) {
  return {
    serverName,
    fingerprint,
    alpn: alpn?.split(","),
    allowInsecure,
    echConfigList
  };
}
function buildRealitySettings(serverName, fingerprint, publicKey, shortId, spiderX) {
  return {
    serverName,
    fingerprint,
    publicKey,
    shortId,
    spiderX,
    show: false,
    allowInsecure: false
  };
}

// src/cores/xray/configs.ts
function buildBalancer(tag2, selector, hasFallback) {
  return {
    tag: tag2,
    selector: [selector],
    strategy: {
      type: "leastPing"
    },
    fallbackTag: hasFallback ? "proxy-2" : void 0
  };
}
async function buildConfig3(ctx, remark, outbounds, isBalancer, isChain, balancerFallback, isWarp, isWorkerLess, outboundAddrs, domainToStaticIPs, customDns, customDnsHosts) {
  const {
    fakeDNS,
    bestWarpInterval,
    bestVLTRInterval,
    logLevel,
    allowLANConnection
  } = ctx.settings;
  let balancers, observatory;
  if (isBalancer) {
    balancers = [buildBalancer("all-proxies", "proxy", balancerFallback)].concatIf(isChain, buildBalancer("all-chains", "chain", false));
    observatory = {
      subjectSelector: isChain ? ["chain", "proxy"] : ["proxy"],
      probeUrl: "https://www.gstatic.com/generate_204",
      probeInterval: `${isWarp ? bestWarpInterval : bestVLTRInterval}s`,
      enableConcurrency: true
    };
  }
  const config = {
    remarks: remark,
    version: {
      min: "25.10.15"
    },
    log: {
      loglevel: logLevel
    },
    dns: await buildDNS3(ctx, outboundAddrs, isWorkerLess, isWarp, domainToStaticIPs, customDns, customDnsHosts),
    inbounds: [
      buildMixedInbound2(allowLANConnection, isWorkerLess, fakeDNS),
      buildDokodemoInbound(allowLANConnection)
    ],
    outbounds: [
      ...outbounds,
      {
        protocol: "dns",
        settings: {
          nonIPQuery: "reject"
        },
        tag: "dns-out"
      },
      {
        protocol: "freedom",
        settings: {
          domainStrategy: "UseIP"
        },
        tag: "direct"
      },
      {
        protocol: "blackhole",
        settings: {
          response: {
            type: "http"
          }
        },
        tag: "block"
      }
    ],
    routing: {
      domainStrategy: "IPIfNonMatch",
      rules: buildRoutingRules3(ctx, isChain, isBalancer, isWorkerLess, isWarp),
      balancers
    },
    observatory,
    policy: {
      levels: {
        0: {
          connIdle: 600,
          handshake: 8,
          uplinkOnly: 120,
          downlinkOnly: 120
        }
      },
      system: {
        statsOutboundUplink: true,
        statsOutboundDownlink: true
      }
    },
    stats: {}
  };
  return config;
}
async function addBestPingConfigs(ctx, configs, totalAddresses, proxyOutbounds, chainOutbounds, isFragment) {
  const isChain = !!chainOutbounds.length;
  const chainSign = isChain ? "\u{1F517} " : "";
  const remark = `\u{1F4A6} ${chainSign}Best Ping F \u{1F680}`;
  const outbounds = [
    ...chainOutbounds,
    ...proxyOutbounds
  ];
  if (isFragment) {
    const fragmentOutbound = buildFreedomOutbound(ctx, true, false, "fragment");
    outbounds.push(fragmentOutbound);
  }
  const config = await buildConfig3(ctx, remark, outbounds, true, isChain, true, false, false, totalAddresses);
  if (isChain) {
    await addBestPingConfigs(ctx, configs, totalAddresses, proxyOutbounds, [], isFragment);
  }
  configs.push(config);
}
async function addBestFragmentConfigs(ctx, configs, outbound, chainProxy) {
  const {
    httpConfig: { hostName },
    settings: { fragmentIntervalMin, fragmentIntervalMax }
  } = ctx;
  const isChain = !!chainProxy;
  const outbounds = [];
  const bestFragValues = [
    "1-5",
    "1-10",
    "10-20",
    "20-30",
    "30-40",
    "40-50",
    "50-60",
    "60-70",
    "70-80",
    "80-90",
    "90-100",
    "10-30",
    "20-40",
    "30-50",
    "40-60",
    "50-70",
    "60-80",
    "70-90",
    "80-100",
    "100-200"
  ];
  bestFragValues.forEach((fragLength, index) => {
    if (isChain) {
      const chain = modifyOutbound(chainProxy, `chain-${index + 1}`, `proxy-${index + 1}`);
      outbounds.push(chain);
    }
    const proxy = modifyOutbound(outbound, `proxy-${index + 1}`, `fragment-${index + 1}`);
    const fragInterval = toRange(fragmentIntervalMin, fragmentIntervalMax);
    const fragment = buildFreedomOutbound(ctx, true, false, `fragment-${index + 1}`, fragLength, fragInterval);
    outbounds.push(proxy, fragment);
  });
  const chainSign = isChain ? "\u{1F517} " : "";
  const config = await buildConfig3(
    ctx,
    `\u{1F4A6} ${chainSign}Best Fragment \u{1F60E}`,
    outbounds,
    true,
    isChain,
    false,
    false,
    false,
    [],
    hostName
  );
  if (chainProxy) {
    await addBestFragmentConfigs(ctx, configs, outbound);
  }
  configs.push(config);
}
async function addWorkerlessConfigs(ctx, configs) {
  const tlsFragment = buildFreedomOutbound(ctx, true, false, "proxy");
  const udpNoise = buildFreedomOutbound(ctx, false, true, "udp-noise");
  const httpFragment = buildFreedomOutbound(ctx, true, false, "http-fragment", void 0, void 0, "1-1");
  const outbounds = [
    tlsFragment,
    httpFragment,
    udpNoise
  ];
  const cfDnsConfig = await buildConfig3(
    ctx,
    `\u{1F4A6} 1 - Workerless \u2B50`,
    outbounds,
    false,
    false,
    false,
    false,
    true,
    [],
    void 0,
    "cloudflare-dns.com",
    ["cloudflare.com"]
  );
  const googleDnsConfig = await buildConfig3(
    ctx,
    `\u{1F4A6} 2 - Workerless \u2B50`,
    outbounds,
    false,
    false,
    false,
    false,
    true,
    [],
    void 0,
    "dns.google",
    ["8.8.8.8", "8.8.4.4"]
  );
  configs.push(cfDnsConfig, googleDnsConfig);
}
async function getXrCustomConfigs(ctx, isFragment) {
  const { outProxy, ports } = ctx.settings;
  const chainProxy = outProxy ? buildChainOutbound3(ctx) : void 0;
  const Addresses = await getConfigAddresses(ctx, isFragment);
  const totalPorts = ports.filter((port) => !isFragment || isHttps(ctx, port));
  const protocols = getProtocols(ctx);
  const configs = [];
  const proxies = [];
  const chains = [];
  const fragment = isFragment ? [buildFreedomOutbound(ctx, true, false, "fragment")] : [];
  let index = 1;
  for (const protocol of protocols) {
    let protocolIndex = 1;
    for (const port of totalPorts) {
      for (const addr of Addresses) {
        const outbound = buildWebsocketOutbound3(ctx, protocol, addr, port, isFragment);
        const outbounds = [outbound, ...fragment];
        const proxy = modifyOutbound(outbound, `proxy-${index}`);
        proxies.push(proxy);
        const remark = generateRemark(ctx, protocolIndex, port, addr, protocol, isFragment, false);
        const config = await buildConfig3(ctx, remark, outbounds, false, false, false, false, false, [addr]);
        configs.push(config);
        if (chainProxy) {
          const remark2 = generateRemark(ctx, protocolIndex, port, addr, protocol, isFragment, true);
          const chainConfig = await buildConfig3(ctx, remark2, [chainProxy, ...outbounds], false, true, false, false, false, [addr]);
          configs.push(chainConfig);
          const chain = modifyOutbound(chainProxy, `chain-${index}`, `proxy-${index}`);
          chains.push(chain);
        }
        protocolIndex++;
        index++;
      }
    }
  }
  await addBestPingConfigs(ctx, configs, Addresses, proxies, chains, isFragment);
  if (isFragment) {
    await addBestFragmentConfigs(ctx, configs, proxies[0], chainProxy);
    await addWorkerlessConfigs(ctx, configs);
  }
  return new Response(JSON.stringify(configs, null, 4), {
    status: 200,
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "Cache-Control": "no-store",
      "CDN-Cache-Control": "no-store"
    }
  });
}
// Generate VLESS simple URIs subscription
async function getVlessSimpleConfigs(ctx, isFragment) {
  const { ports } = ctx.settings;
  const Addresses = await getConfigAddresses(ctx, isFragment);
  const totalPorts = ports.filter((port) => !isFragment || isHttps(ctx, port));
  const protocols = getProtocols(ctx);

  const vlessProtocol = protocols.find((p) => p === ctx.dict._VL_);
  if (!vlessProtocol) {
    return new Response("VLESS not enabled", { status: 400 });
  }

  const uris = [];
  let index = 1;

  for (const port of totalPorts) {
    for (const addr of Addresses) {
      const remark = generateRemark(ctx, index, port, addr, vlessProtocol, isFragment, false);
      const uri = generateVlessUri(ctx, addr, port, remark);
      uris.push(uri);
      index++;
    }
  }

  const subscription = uris.join("\n");
  const base64Subscription = toBase64Utf8(subscription);

  return new Response(base64Subscription, {
    status: 200,
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "Cache-Control": "no-store",
      "CDN-Cache-Control": "no-store"
    }
  });
}

// Generate Trojan simple URIs subscription
async function getTrojanSimpleConfigs(ctx, isFragment) {
  const { ports } = ctx.settings;
  const Addresses = await getConfigAddresses(ctx, isFragment);
  const totalPorts = ports.filter((port) => !isFragment || isHttps(ctx, port));
  const protocols = getProtocols(ctx);

  const trojanProtocol = protocols.find((p) => p === ctx.dict._TR_);
  if (!trojanProtocol) {
    return new Response("Trojan not enabled", { status: 400 });
  }

  const uris = [];
  let index = 1;

  for (const port of totalPorts) {
    for (const addr of Addresses) {
      const remark = generateRemark(ctx, index, port, addr, trojanProtocol, isFragment, false);
      const uri = generateTrojanUri(ctx, addr, port, remark);
      uris.push(uri);
      index++;
    }
  }

  const subscription = uris.join("\n");
  const base64Subscription = toBase64Utf8(subscription);

  return new Response(base64Subscription, {
    status: 200,
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "Cache-Control": "no-store",
      "CDN-Cache-Control": "no-store"
    }
  });
}
async function getXrWarpConfigs(ctx, isPro, isKnocker) {
  const { request, env, context } = ctx;
  const { warpEndpoints } = ctx.settings;
  const { warpAccounts } = await getDataset(request, env, context);
  const proIndicator = isPro ? " Pro " : " ";
  const configs = [];
  const proxies = [];
  const chains = [];
  const outboundDomains = [];
  const udpNoise = isPro && !isKnocker ? [buildFreedomOutbound(ctx, false, true, "udp-noise")] : [];
  for (const [index, endpoint] of warpEndpoints.entries()) {
    const { host } = parseHostPort(endpoint);
    if (isDomain(host)) outboundDomains.push(host);
    const warpOutbound = buildWarpOutbound3(ctx, warpAccounts[0], endpoint, false, isPro);
    const wowOutbound = buildWarpOutbound3(ctx, warpAccounts[1], endpoint, true, isPro);
    const warpConfig = await buildConfig3(
      ctx,
      `\u{1F4A6} ${index + 1} - Warp${proIndicator}\u{1F1EE}\u{1F1F7}`,
      [warpOutbound, ...udpNoise],
      false,
      false,
      false,
      true,
      false,
      [host]
    );
    const wowConfig = await buildConfig3(
      ctx,
      `\u{1F4A6} ${index + 1} - WoW${proIndicator}\u{1F30D}`,
      [wowOutbound, warpOutbound, ...udpNoise],
      false,
      true,
      false,
      true,
      false,
      [host]
    );
    configs.push(warpConfig, wowConfig);
    const proxy = modifyOutbound(warpOutbound, `proxy-${index + 1}`);
    proxies.push(proxy);
    const chain = modifyOutbound(wowOutbound, `chain-${index + 1}`, `proxy-${index + 1}`);
    chains.push(chain);
  }
  const warpBestPing = await buildConfig3(
    ctx,
    `\u{1F4A6} Warp${proIndicator}- Best Ping \u{1F680}`,
    [...proxies, ...udpNoise],
    true,
    false,
    false,
    true,
    false,
    outboundDomains
  );
  const wowBestPing = await buildConfig3(
    ctx,
    `\u{1F4A6} WoW${proIndicator}- Best Ping \u{1F680}`,
    [...chains, ...proxies, ...udpNoise],
    true,
    true,
    false,
    true,
    false,
    outboundDomains
  );
  configs.push(warpBestPing, wowBestPing);
  return new Response(JSON.stringify(configs, null, 4), {
    status: 200,
    headers: {
      "Content-Type": "text/plain;charset=utf-8",
      "Cache-Control": "no-store",
      "CDN-Cache-Control": "no-store"
    }
  });
}
function modifyOutbound(outbound, tag2, dialerProxy) {
  const newOutbound = structuredClone(outbound);
  newOutbound.tag = tag2;
  if (dialerProxy && newOutbound.streamSettings) {
    newOutbound.streamSettings.sockopt.dialerProxy = dialerProxy;
  }
  return newOutbound;
}

// src/protocols/websocket/common.ts
var WS_READY_STATE_OPEN = 1;
var WS_READY_STATE_CLOSING = 2;
async function handleTCPOutBound(ctx, remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, VLResponseHeader, log, onActivity = () => {}) {
  const {
    proxyMode,
    panelIPs,
    envProxyIPs,
    defaultProxyIPs,
    envPrefixes,
    defaultPrefixes
  } = ctx.wsConfig;

  const MAX_RETRIES = 2;
  const RETRY_DELAY_MS = 100;
  let currentAddress = addressRemote;
  let currentPort = portRemote;

  const getRandomValue = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const parseIPs = (value) => value ? value.split(",").map((val) => val.trim()).filter(Boolean) : void 0;
  const chooseNextTarget = async () => {
    if (proxyMode === "proxyip") {
      const proxyIPs = panelIPs?.length ? panelIPs : parseIPs(envProxyIPs) ?? defaultProxyIPs;
      if (!Array.isArray(proxyIPs) || proxyIPs.length === 0) {
        currentAddress = addressRemote;
        currentPort = portRemote;
        return;
      }
      const proxyIP = getRandomValue(proxyIPs);
      const { host, port } = parseHostPort(proxyIP, true);
      currentAddress = host || addressRemote;
      currentPort = port || portRemote;
    } else if (proxyMode === "prefix") {
      const prefixes = panelIPs?.length ? panelIPs : parseIPs(envPrefixes) ?? defaultPrefixes;
      if (!Array.isArray(prefixes) || prefixes.length === 0) {
        currentAddress = addressRemote;
        currentPort = portRemote;
        return;
      }
      const prefix = getRandomValue(prefixes);
      const dynamicProxyIP = await getDynamicProxyIP(addressRemote, prefix, ctx.globalConfig.dohURL);
      if (dynamicProxyIP) {
        currentAddress = dynamicProxyIP;
      }
    }
  };

  for (let i = 0; i <= MAX_RETRIES; i++) {
    let tcpSocket = null;
    const targetAddress = currentAddress;
    const targetPort = currentPort;
    if (!shouldTryEndpoint(targetAddress, targetPort)) {
      log(`Circuit breaker open for ${targetAddress}:${targetPort}, skipping attempt ${i + 1}`);
      if (i < MAX_RETRIES) {
        await chooseNextTarget();
        continue;
      }
      remoteSocketWapper.connecting = false;
      safeCloseWebSocket(webSocket);
      return;
    }
    try {
      const CONNECTION_TIMEOUT = 10000;
      
      tcpSocket = cfConnect({
        hostname: currentAddress,
        port: currentPort
      });
      remoteSocketWapper.value = tcpSocket;
      
      // Phase 1: Connection (Safe to retry if this fails)
      await withTimeout(
        tcpSocket.opened,
        CONNECTION_TIMEOUT,
        `Connection timeout after ${CONNECTION_TIMEOUT}ms`
      );
      
      recordEndpointSuccess(targetAddress, targetPort);
      onActivity();
      log(`connected to ${targetAddress}:${targetPort} (attempt ${i + 1})`);

    } catch (error) {
      recordEndpointFailure(targetAddress, targetPort);
      log(`Connection attempt ${i + 1} failed: ${error.message}`);
      if (tcpSocket) safeCloseTcpSocket(tcpSocket);
      remoteSocketWapper.value = null;

      if (i < MAX_RETRIES) {
        await chooseNextTarget();
        const baseDelay = RETRY_DELAY_MS * Math.pow(2, i);
        const maxDelay = 5000;
        const cappedDelay = Math.min(baseDelay, maxDelay);
        const jitter = cappedDelay * (Math.random() * 0.4 - 0.2);
        await new Promise(r => setTimeout(r, Math.max(0, cappedDelay + jitter)));
        continue;
      } else {
        remoteSocketWapper.connecting = false;
        log(`All connection attempts failed after ${MAX_RETRIES + 1} attempts`);
        safeCloseWebSocket(webSocket);
        return;
      }
    }

    // Phase 2: Data Handshake & Piping (UNSAFE to retry)
    try {
      const CONNECTION_TIMEOUT = 10000;
      await withTimeout(
        safeWriteToOutbound(remoteSocketWapper, rawClientData),
        CONNECTION_TIMEOUT,
        `Handshake write timeout after ${CONNECTION_TIMEOUT}ms`
      );

      // Success! Mark as not connecting and return to handler loop
      remoteSocketWapper.connecting = false;
      onActivity();

      // Start Remote -> Client piping in background
      remoteSocketToWS(tcpSocket, webSocket, VLResponseHeader, log, onActivity).finally(() => {
        safeCloseWebSocket(webSocket);
      });
      
      return; 

    } catch (error) {
      remoteSocketWapper.connecting = false;
      recordEndpointFailure(targetAddress, targetPort);
      log(`Data transmission phase failed: ${error.message}`);
      // Critical: Once we send rawClientData, we NEVER retry from the beginning 
      // because the server may have already received and acted on the request.
      safeCloseTcpSocket(tcpSocket);
      safeCloseWebSocket(webSocket);
      return;
    }
  }
}

async function waitForWebSocketDrain(webSocket, maxBuffer = 1024 * 1024, resumeBuffer = 512 * 1024, timeoutMs = 5000) {
  if (typeof webSocket.bufferedAmount !== "number" || webSocket.bufferedAmount <= maxBuffer) return;
  const start = Date.now();
  let delay = 10;
  while (webSocket.bufferedAmount > resumeBuffer) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("WebSocket backpressure timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 100);
  }
}

async function remoteSocketToWS(remoteSocket, webSocket, VLResponseHeader, log, onActivity = () => {}) {
  let vlHeader = VLResponseHeader;
  let hasIncomingData = false;

  let connectionClosed = false;

  remoteSocket.closed.catch(error => {
    if (DEBUG_MODE) {
      log(`TCP socket closed with error:`, error.message);
    }
    connectionClosed = true;
    if (webSocket.readyState === WS_READY_STATE_OPEN) {
      try {
        webSocket.close(1011, "Remote connection failed");
      } catch (e) {
      }
    }
  });

  const writableStream = new WritableStream({
    async write(chunk, controller) {
      hasIncomingData = true;
      if (connectionClosed) {
        controller.error("Remote connection closed");
        return;
      }
      if (webSocket.readyState !== WS_READY_STATE_OPEN) {
        controller.error("webSocket.readyState is not open");
        return;
      }
      await waitForWebSocketDrain(webSocket);
      if (vlHeader) {
        const chunkArray = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        const merged = new Uint8Array(vlHeader.length + chunkArray.length);
        merged.set(vlHeader, 0);
        merged.set(chunkArray, vlHeader.length);
        webSocket.send(merged.buffer);
        vlHeader = null;
      } else {
        webSocket.send(chunk);
      }
      onActivity();
    },
    close() {
      log(`remoteConnection.readable closed. hasIncomingData: ${hasIncomingData}`);
      if (webSocket.readyState === WS_READY_STATE_OPEN) {
        try {
          webSocket.close(1000, "Connection closed normally");
        } catch (e) {
        }
      }
    },
    abort(reason) {
      log(`remoteConnection.readable aborted:`, reason);
      safeCloseTcpSocket(remoteSocket);
      if (webSocket.readyState === WS_READY_STATE_OPEN) {
        try {
          webSocket.close(1011, "Connection aborted");
        } catch (e) {
        }
      }
    }
  });

  try {
    await remoteSocket.readable.pipeTo(writableStream);
  } catch (error) {
    log("remoteSocketToWS pipeTo error:", error.message);
    if (webSocket.readyState === WS_READY_STATE_OPEN) {
      try {
        webSocket.close(1011, "Pipe error");
      } catch (e) {
      }
    }
  } finally {
    safeCloseTcpSocket(remoteSocket);
  }
  
  return hasIncomingData;
}
async function safeWriteToOutbound(remoteSocketWapper, data) {
  const MAX_WAIT = 5000;
  if (!remoteSocketWapper.writeChain) {
    remoteSocketWapper.writeChain = Promise.resolve();
  }

  const writePromise = remoteSocketWapper.writeChain.then(async () => {
    if (!remoteSocketWapper.value) {
      throw new Error("Socket closed before write");
    }
    let writer;
    try {
      writer = remoteSocketWapper.value.writable.getWriter();
      await writer.write(data);
    } catch (error) {
      const message2 = error instanceof Error ? error.message : String(error);
      console.error("safeWriteToOutbound write error:", message2);
      const lowerMsg = message2.toLowerCase();
      if (lowerMsg.includes("closed") || lowerMsg.includes("aborted") || lowerMsg.includes("belongs to an object that is closing")) {
        remoteSocketWapper.value = null;
        if (DEBUG_MODE) {
          console.log("Stream already closing, propagating to caller for cleanup");
        }
        throw error;
      }
      throw error;
    } finally {
      if (writer) {
        try {
          writer.releaseLock();
        } catch (e) {
          if (DEBUG_MODE) {
            console.log("Ignoring writer.releaseLock error:", e?.message ?? String(e));
          }
        }
      }
    }
  });

  remoteSocketWapper.writeChain = writePromise.catch(() => {});
  try {
    return await withTimeout(writePromise, MAX_WAIT, "Write timeout - socket may be stuck");
  } catch (error) {
    safeCloseTcpSocket(remoteSocketWapper.value);
    remoteSocketWapper.value = null;
    throw error;
  }
}
function concatUint8Arrays(...arrays) {
  let totalLength = 0;
  const normalized = arrays.map((arr) => {
    const uint8Arr = arr instanceof Uint8Array ? arr : new Uint8Array(arr);
    totalLength += uint8Arr.length;
    return uint8Arr;
  });
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of normalized) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result.buffer;
}
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
  let readableStreamCancel = false;
  let messageHandler, closeHandler, errorHandler;
  let cleanupDone = false;

  const cleanupListeners = () => {
    if (cleanupDone) return;
    cleanupDone = true;
    try {
      webSocketServer.removeEventListener("message", messageHandler);
      webSocketServer.removeEventListener("close", closeHandler);
      webSocketServer.removeEventListener("error", errorHandler);
    } catch (e) {
    }
  };

  const stream = new ReadableStream({
    start(controller) {
      messageHandler = (event) => {
        if (readableStreamCancel) return;
        const message2 = event.data;
        const messageSize =
          typeof message2 === "string" ? new TextEncoder().encode(message2).length :
          message2?.byteLength ??
          message2?.size ??
          message2?.length ??
          0;
        if (messageSize > MAX_WEBSOCKET_MESSAGE_SIZE) {
          log(`WebSocket message too large: ${messageSize} bytes (max ${MAX_WEBSOCKET_MESSAGE_SIZE})`);
          cleanupListeners();
          safeCloseWebSocket(webSocketServer);
          controller.error(new Error(`Message exceeds ${MAX_WEBSOCKET_MESSAGE_SIZE} bytes`));
          return;
        }
        controller.enqueue(message2);
      };
      closeHandler = () => {
        cleanupListeners();
        safeCloseWebSocket(webSocketServer);
        if (readableStreamCancel) return;
        controller.close();
      };
      errorHandler = (err) => {
        cleanupListeners();
        log("webSocketServer has error");
        controller.error(err);
      };
      webSocketServer.addEventListener("message", messageHandler);
      webSocketServer.addEventListener("close", closeHandler);
      webSocketServer.addEventListener("error", errorHandler);
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) {
        cleanupListeners();
        controller.error(error);
      } else if (earlyData) {
        const earlyDataSize = earlyData.byteLength ?? 0;
        if (earlyDataSize > MAX_WEBSOCKET_MESSAGE_SIZE) {
          cleanupListeners();
          safeCloseWebSocket(webSocketServer);
          controller.error(new Error(`Early data exceeds ${MAX_WEBSOCKET_MESSAGE_SIZE} bytes`));
          return;
        }
        controller.enqueue(earlyData);
      }
    },
    pull(_controller) {
    },
    cancel(reason) {
      if (readableStreamCancel) return;
      log(`ReadableStream was canceled, due to ${reason}`);
      readableStreamCancel = true;
      cleanupListeners();
      safeCloseWebSocket(webSocketServer);
    }
  });
  return stream;
}
function base64ToArrayBuffer(base64Str) {
  if (!base64Str) {
    return { earlyData: null, error: null };
  }
  try {
    base64Str = base64Str.trim().replace(/-/g, "+").replace(/_/g, "/");
    const pad = base64Str.length % 4;
    if (pad) {
      base64Str += "=".repeat(4 - pad);
    }
    const decode2 = atob(base64Str);
    const arryBuffer = Uint8Array.from(decode2, (c) => c.charCodeAt(0));
    return { earlyData: arryBuffer.buffer, error: null };
  } catch (error) {
    return { earlyData: null, error };
  }
}
function safeCloseTcpSocket(socket) {
  try {
    if (socket && socket.writable && !socket.writable.locked) {
      socket.close();
    }
  } catch (error) {
    // Suppress close errors
  }
}
function safeCloseWebSocket(socket) {
  try {
    if (socket && (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === 0)) {
      socket.close();
    }
  } catch (error) {
    // Suppress close errors
  }
}
async function getDynamicProxyIP(address, prefix, dohURL) {
  let finalAddress = address;
  if (!isIPv4(address)) {
    const { ipv4 } = await resolveDNS(address, true, dohURL);
    if (ipv4.length) {
      finalAddress = ipv4[0];
    } else {
      throw new Error("Unable to find IPv4 in DNS records");
    }
  }
  return convertToNAT64IPv6(finalAddress, prefix);
}
function convertToNAT64IPv6(ipv4Address, prefix) {
  const parts = ipv4Address.split(".");
  if (parts.length !== 4) {
    throw new Error("Invalid IPv4 address");
  }
  const hex = parts.map((part) => {
    const num = parseInt(part, 10);
    if (num < 0 || num > 255) {
      throw new Error("Invalid IPv4 address");
    }
    return num.toString(16).padStart(2, "0");
  });
  const match = prefix.match(/^\[([0-9A-Fa-f:]+)\]$/);
  if (match) {
    return `[${match[1]}${hex[0]}${hex[1]}:${hex[2]}${hex[3]}]`;
  }
}

// src/protocols/websocket/vless.ts
async function VlOverWSHandler(ctx) {
  const { request, globalConfig: { userID } } = ctx;
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();
  let address = "";
  let portWithRandomLog = "";
  const log = (info, event) => {
    if (ctx.log) {
      ctx.log(`[${address}:${portWithRandomLog}] ${info}`, event || "");
    } else {
      console.log(`[${address}:${portWithRandomLog}] ${info}`, event || "");
    }
  };
  const earlyDataHeader = request.headers.get("sec-websocket-protocol") || "";
  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);
  let remoteSocketWapper = { value: null, connecting: false, writeChain: Promise.resolve() };
  const watchdog = createIdleWatchdog(log, () => {
    safeCloseTcpSocket(remoteSocketWapper.value);
    safeCloseWebSocket(webSocket);
  });
  const OVERALL_TIMEOUT = 120000;
  const overallTimeoutId = setTimeout(() => {
    try {
      log("[TIMEOUT] Overall request timeout reached after 2 minutes");
      watchdog.stop();
      safeCloseTcpSocket(remoteSocketWapper.value);
      safeCloseWebSocket(webSocket);
    } catch (e) {
    }
  }, OVERALL_TIMEOUT);
  let udpStreamWrite = null;
  let isDns = false;
  const writableStream = new WritableStream({
    async write(chunk) {
      watchdog.touch();
      if (isDns && udpStreamWrite) {
        return udpStreamWrite(chunk);
      }
      if (remoteSocketWapper.value || remoteSocketWapper.connecting) {
        await safeWriteToOutbound(remoteSocketWapper, chunk);
        watchdog.touch();
        return;
      }
      
      const {
        hasError,
        message: message2,
        portRemote = 443,
        addressRemote = "",
        rawDataIndex,
        VLVersion = new Uint8Array([0, 0]),
        isUDP
      } = parseVlHeader(chunk, userID);
      address = addressRemote;
      portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? "udp " : "tcp "} `;
      if (hasError) {
        throw new Error(message2);
      }
      const VLResponseHeader = new Uint8Array([VLVersion[0], 0]);
      const rawClientData = chunk.slice(rawDataIndex);
      if (isUDP) {
        if (portRemote === 53) {
          isDns = true;
          const { write } = await handleUDPOutBound(webSocket, VLResponseHeader, log, ctx.globalConfig.dohURL);
          udpStreamWrite = write;
          udpStreamWrite(rawClientData);
          return;
        } else {
          throw new Error("UDP proxy only enable for DNS which is port 53");
        }
      }
      
      remoteSocketWapper.connecting = true;
      await handleTCPOutBound(
        ctx,
        remoteSocketWapper,
        addressRemote,
        portRemote,
        rawClientData,
        webSocket,
        VLResponseHeader,
        log,
        () => watchdog.touch()
      );
    },
    close() {
      clearTimeout(overallTimeoutId);
      watchdog.stop();
      safeCloseTcpSocket(remoteSocketWapper.value);
    },
    abort(reason) {
      clearTimeout(overallTimeoutId);
      watchdog.stop();
      log(`readableWebSocketStream is abort`, JSON.stringify(reason));
    }
  });
  (async () => {
    try {
      await readableWebSocketStream.pipeTo(writableStream);
    } catch (error) {
      log("readableWebSocketStream pipeTo error", error);
      safeCloseTcpSocket(remoteSocketWapper.value);
    } finally {
      clearTimeout(overallTimeoutId);
      watchdog.stop();
    }
  })();
  return new Response(null, {
    status: 101,
    webSocket: client
  });
}
function parseVlHeader(VLBuffer, userID) {
  if (VLBuffer.byteLength < 24) {
    return {
      hasError: true,
      message: "invalid data"
    };
  }
  const version = new Uint8Array(VLBuffer.slice(0, 1));
  const slicedBuffer = new Uint8Array(VLBuffer.slice(1, 17));
  const slicedBufferString = stringify(slicedBuffer);
  const isValidUser = slicedBufferString === userID;
  if (!isValidUser) {
    return {
      hasError: true,
      message: "invalid user"
    };
  }
  const optLength = new Uint8Array(VLBuffer.slice(17, 18))[0];
  const command = new Uint8Array(VLBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
  let isUDP = false;
  if (command === 1) {
  } else if (command === 2) {
    isUDP = true;
  } else {
    return {
      hasError: true,
      message: `command ${command} is not support, command 01-tcp,02-udp,03-mux`
    };
  }
  const portIndex = 18 + optLength + 1;
  const portBuffer = VLBuffer.slice(portIndex, portIndex + 2);
  const portRemote = new DataView(portBuffer).getUint16(0);
  let addressIndex = portIndex + 2;
  const addressBuffer = new Uint8Array(VLBuffer.slice(addressIndex, addressIndex + 1));
  const addressType = addressBuffer[0];
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = "";
  switch (addressType) {
    case 1:
      addressLength = 4;
      addressValue = new Uint8Array(VLBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join(".");
      break;
    case 2:
      addressLength = new Uint8Array(VLBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(VLBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
    case 3: {
      addressLength = 16;
      const dataView = new DataView(VLBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      const ipv6 = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16));
      }
      addressValue = ipv6.join(":");
      break;
    }
    default:
      return {
        hasError: true,
        message: `invild  addressType is ${addressType}`
      };
  }
  if (!addressValue) {
    return {
      hasError: true,
      message: `addressValue is empty, addressType is ${addressType}`
    };
  }
  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    VLVersion: version,
    isUDP
  };
}
function unsafeStringify(arr, offset = 0) {
  const byteToHex = [];
  for (let i = 0; i < 256; ++i) {
    byteToHex.push((i + 256).toString(16).slice(1));
  }
  return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}
function stringify(arr, offset = 0) {
  const uuid = unsafeStringify(arr, offset);
  if (!isValidUUID(uuid)) {
    throw TypeError("Stringified UUID is invalid");
  }
  return uuid;
}
async function handleUDPOutBound(webSocket, VLResponseHeader, log, dohURL = "https://cloudflare-dns.com/dns-query") {
  let isVLHeaderSent = false;
  const transformStream = new TransformStream({
    start(_controller) {
    },
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength;) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength));
        index = index + 2 + udpPakcetLength;
        controller.enqueue(udpData);
      }
    },
    flush(_controller) {
    }
  });
  transformStream.readable.pipeTo(
    new WritableStream({
      async write(chunk) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort();
          log("DoH UDP query timeout after 5s");
        }, 5000);
        try {
          const resp = await fetch(dohURL, {
            method: "POST",
            headers: {
              "content-type": "application/dns-message"
            },
            body: chunk,
            signal: controller.signal
          });
          if (!resp.ok) {
            throw new Error(`DoH UDP query failed with status ${resp.status}`);
          }
          const contentLength = resp.headers.get("content-length");
          if (contentLength && Number.parseInt(contentLength, 10) > MAX_DNS_RESPONSE_SIZE) {
            throw new Error(`DoH UDP response too large: ${contentLength} bytes`);
          }
          const dnsQueryResult = await resp.arrayBuffer();
          if (dnsQueryResult.byteLength > MAX_DNS_RESPONSE_SIZE) {
            throw new Error(`DoH UDP response too large after read: ${dnsQueryResult.byteLength} bytes`);
          }
          const udpSize = dnsQueryResult.byteLength;
          const udpSizeBuffer = new Uint8Array([udpSize >> 8 & 255, udpSize & 255]);
          if (webSocket.readyState === WS_READY_STATE_OPEN) {
            log(`doh success and dns message length is ${udpSize}`);
            if (isVLHeaderSent) {
              webSocket.send(concatUint8Arrays(udpSizeBuffer, dnsQueryResult));
            } else {
              webSocket.send(concatUint8Arrays(VLResponseHeader, udpSizeBuffer, dnsQueryResult));
              isVLHeaderSent = true;
            }
          }
        } catch (error) {
          const message2 = error instanceof Error ? error.message : String(error);
          if (error?.name === "AbortError") {
            log("DoH UDP query was aborted due to timeout");
          } else {
            log(`DoH UDP query error: ${message2}`);
          }
          throw error;
        } finally {
          clearTimeout(timeoutId);
        }
      }
    })
  ).catch((error) => {
    log("dns udp has error" + error);
  });
  const writer = transformStream.writable.getWriter();
  return {
    write(chunk) {
      return writer.write(chunk);
    }
  };
}

// src/protocols/websocket/trojan.ts
async function TrOverWSHandler(ctx) {
  const { request } = ctx;
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();
  let address = "";
  let portWithRandomLog = "";
  const log = (info, event) => {
    if (ctx.log) {
      ctx.log(`[${address}:${portWithRandomLog}] ${info}`, event || "");
    } else {
      console.log(`[${address}:${portWithRandomLog}] ${info}`, event || "");
    }
  };
  const earlyDataHeader = request.headers.get("sec-websocket-protocol") || "";
  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);
  let remoteSocketWapper = { value: null, connecting: false, writeChain: Promise.resolve() };
  const watchdog = createIdleWatchdog(log, () => {
    safeCloseTcpSocket(remoteSocketWapper.value);
    safeCloseWebSocket(webSocket);
  });
  const OVERALL_TIMEOUT = 120000;
  const overallTimeoutId = setTimeout(() => {
    try {
      log("[TIMEOUT] Overall request timeout reached after 2 minutes");
      watchdog.stop();
      safeCloseTcpSocket(remoteSocketWapper.value);
      safeCloseWebSocket(webSocket);
    } catch (e) {
    }
  }, OVERALL_TIMEOUT);
  let udpStreamWrite = null;
  const writableStream = new WritableStream({
    async write(chunk, _controller) {
      watchdog.touch();
      if (udpStreamWrite) {
        return udpStreamWrite(chunk);
      }
      if (remoteSocketWapper.value || remoteSocketWapper.connecting) {
        await safeWriteToOutbound(remoteSocketWapper, chunk);
        watchdog.touch();
        return;
      }
      const {
        hasError,
        message: message2,
        portRemote = 443,
        addressRemote = "",
        rawClientData
      } = await parseTrHeader(ctx, chunk);
      address = addressRemote;
      portWithRandomLog = `${portRemote}--${Math.random()} tcp`;
      if (hasError) {
        throw new Error(message2);
      }
      
      remoteSocketWapper.connecting = true;
      await handleTCPOutBound(
        ctx,
        remoteSocketWapper,
        addressRemote,
        portRemote,
        rawClientData,
        webSocket,
        null,
        log,
        () => watchdog.touch()
      );
    },
    close() {
      clearTimeout(overallTimeoutId);
      watchdog.stop();
      safeCloseTcpSocket(remoteSocketWapper.value);
    },
    abort(reason) {
      clearTimeout(overallTimeoutId);
      watchdog.stop();
      log(`readableWebSocketStream is aborted`, JSON.stringify(reason));
    }
  });
  (async () => {
    try {
      await readableWebSocketStream.pipeTo(writableStream);
    } catch (error) {
      log("readableWebSocketStream pipeTo error", error);
      safeCloseTcpSocket(remoteSocketWapper.value);
    } finally {
      clearTimeout(overallTimeoutId);
      watchdog.stop();
    }
  })();
  return new Response(null, {
    status: 101,
    webSocket: client
  });
}
async function parseTrHeader(ctx, buffer) {
  if (buffer.byteLength < 56) {
    return {
      hasError: true,
      message: "invalid data"
    };
  }
  let crLfIndex = 56;
  const cr = new Uint8Array(buffer.slice(crLfIndex, crLfIndex + 1))[0];
  const lf = new Uint8Array(buffer.slice(crLfIndex + 1, crLfIndex + 2))[0];
  if (cr !== 13 || lf !== 10) {
    return {
      hasError: true,
      message: "invalid header format (missing CR LF)"
    };
  }
  const password = new TextDecoder().decode(buffer.slice(0, crLfIndex));
  const { TrPass } = ctx.globalConfig;
  if (password !== await sha224(TrPass)) {
    return {
      hasError: true,
      message: "invalid password"
    };
  }
  const socks5DataBuffer = buffer.slice(crLfIndex + 2);
  if (socks5DataBuffer.byteLength < 6) {
    return {
      hasError: true,
      message: "invalid SOCKS5 request data"
    };
  }
  const view = new DataView(socks5DataBuffer);
  const cmd = view.getUint8(0);
  if (cmd !== 1) {
    return {
      hasError: true,
      message: "unsupported command, only TCP (CONNECT) is allowed"
    };
  }
  const atype = view.getUint8(1);
  let addressLength = 0;
  let addressIndex = 2;
  let address = "";
  switch (atype) {
    case 1:
      addressLength = 4;
      address = new Uint8Array(socks5DataBuffer.slice(addressIndex, addressIndex + addressLength)).join(".");
      break;
    case 3:
      addressLength = new Uint8Array(socks5DataBuffer.slice(addressIndex, addressIndex + 1))[0];
      addressIndex += 1;
      address = new TextDecoder().decode(socks5DataBuffer.slice(addressIndex, addressIndex + addressLength));
      break;
    case 4: {
      addressLength = 16;
      const dataView = new DataView(socks5DataBuffer.slice(addressIndex, addressIndex + addressLength));
      const ipv6 = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16));
      }
      address = ipv6.join(":");
      break;
    }
    default:
      return {
        hasError: true,
        message: `invalid addressType is ${atype}`
      };
  }
  if (!address) {
    return {
      hasError: true,
      message: `address is empty, addressType is ${atype}`
    };
  }
  const portIndex = addressIndex + addressLength;
  const portBuffer = socks5DataBuffer.slice(portIndex, portIndex + 2);
  const portRemote = new DataView(portBuffer).getUint16(0);
  return {
    hasError: false,
    addressRemote: address,
    portRemote,
    rawClientData: socks5DataBuffer.slice(portIndex + 4)
  };
}
function sha224(string) {
  const rightRotate = (value, amount) => value >>> amount | value << 32 - amount;
  const h = [
    3238371032,
    914150663,
    812702999,
    4144912697,
    4290775857,
    1750603025,
    1694076839,
    3204075428
  ];
  const k = [
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ];
  const utf8Encode = (str) => {
    const utf8 = [];
    for (let i = 0; i < str.length; i++) {
      let charcode = str.charCodeAt(i);
      if (charcode < 128) {
        utf8.push(charcode);
      } else if (charcode < 2048) {
        utf8.push(192 | charcode >> 6, 128 | charcode & 63);
      } else if (charcode < 55296 || charcode >= 57344) {
        utf8.push(
          224 | charcode >> 12,
          128 | charcode >> 6 & 63,
          128 | charcode & 63
        );
      } else {
        i++;
        charcode = 65536 + ((charcode & 1023) << 10 | str.charCodeAt(i) & 1023);
        utf8.push(
          240 | charcode >> 18,
          128 | charcode >> 12 & 63,
          128 | charcode >> 6 & 63,
          128 | charcode & 63
        );
      }
    }
    return utf8;
  };
  const bytes = utf8Encode(string);
  const bitLength = bytes.length * 8;
  bytes.push(128);
  while (bytes.length % 64 !== 56) {
    bytes.push(0);
  }
  const lengthHi = Math.floor(bitLength / 4294967296);
  const lengthLo = bitLength & 4294967295;
  for (let i = 3; i >= 0; i--) {
    bytes.push(lengthHi >> i * 8 & 255);
  }
  for (let i = 3; i >= 0; i--) {
    bytes.push(lengthLo >> i * 8 & 255);
  }
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const w = new Array(64).fill(0);
    for (let i = 0; i < 16; i++) {
      w[i] = bytes[offset + 4 * i] << 24 | bytes[offset + 4 * i + 1] << 16 | bytes[offset + 4 * i + 2] << 8 | bytes[offset + 4 * i + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rightRotate(w[i - 15], 7) ^ rightRotate(w[i - 15], 18) ^ w[i - 15] >>> 3;
      const s1 = rightRotate(w[i - 2], 17) ^ rightRotate(w[i - 2], 19) ^ w[i - 2] >>> 10;
      w[i] = w[i - 16] + s0 + w[i - 7] + s1 | 0;
    }
    let [a, b, c, d, e, f, g, h8] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = e & f ^ ~e & g;
      const temp1 = h8 + S1 + ch + k[i] + w[i] | 0;
      const S0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = a & b ^ a & c ^ b & c;
      const temp2 = S0 + maj | 0;
      h8 = g;
      g = f;
      f = e;
      e = d + temp1 | 0;
      d = c;
      c = b;
      b = a;
      a = temp1 + temp2 | 0;
    }
    h[0] = h[0] + a | 0;
    h[1] = h[1] + b | 0;
    h[2] = h[2] + c | 0;
    h[3] = h[3] + d | 0;
    h[4] = h[4] + e | 0;
    h[5] = h[5] + f | 0;
    h[6] = h[6] + g | 0;
    h[7] = h[7] + h8 | 0;
  }
  return h.slice(0, 7).map((word) => ("00000000" + (word >>> 0).toString(16)).slice(-8)).join("");
}

// src/common/handlers.ts
async function handleWebsocket(ctx) {
  const {
    request,
    wsConfig: { envProxyIPs, envPrefixes, defaultProxyIPs, defaultPrefixes },
    globalConfig: { userID, pathName }
  } = ctx;
  const upgradeHeader = request.headers.get("Upgrade");
  if (!upgradeHeader || upgradeHeader !== "websocket") {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/cf":
        return new Response(JSON.stringify(request.cf, null, 4), {
          status: 200,
          headers: {
            "Content-Type": "application/json;charset=utf-8",
            "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
            "CDN-Cache-Control": "no-store"
          }
        });
      case "/connect":
        const [hostname, port] = ["cloudflare.com", "80"];
        return new Response("HTTP/1.1 200 Connection Established");
      default:
        return new Response(JSON.stringify(request), {
          status: 200,
          headers: {
            "Content-Type": "text/plain;charset=utf-8",
            "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
            "CDN-Cache-Control": "no-store"
          }
        });
    }
  }
  const encodedPathConfig = pathName.replace("/", "");
  try {
    const { protocol, mode, panelIPs } = JSON.parse(atob(encodedPathConfig));
    ctx.wsConfig = {
      ...ctx.wsConfig,
      wsProtocol: protocol,
      proxyMode: mode,
      panelIPs
    };
    if (protocol === "vl" && userID) {
      return await VlOverWSHandler(ctx);
    } else if (protocol === "tr" && userID) {
      return await TrOverWSHandler(ctx);
    } else {
      ctx.wsConfig = {
        ...ctx.wsConfig,
        wsProtocol: "vl",
        proxyMode: "proxyip"
      };
      return await VlOverWSHandler(ctx);
    }
  } catch (error) {
    if (isValidUUID(encodedPathConfig)) {
      ctx.wsConfig = {
        ...ctx.wsConfig,
        wsProtocol: "vl",
        proxyMode: "proxyip"
      };
      return await VlOverWSHandler(ctx);
    } else {
      ctx.wsConfig = {
        ...ctx.wsConfig,
        wsProtocol: "vl",
        proxyMode: "proxyip"
      };
      return await VlOverWSHandler(ctx);
    }
  }
}
async function handlePanel(ctx) {
  const { pathName } = ctx.globalConfig;
  const { request, env } = ctx;
  switch (pathName) {
    case "/panel":
      return await renderPanel(ctx);
    case "/panel/reset-password":
      return await resetPassword(request, env);
    case "/panel/my-ip":
      return await getMyIP(request);
    case "/panel/update-warp":
      return await updateWarpConfigs(request, env);
    case "/panel/get-warp-configs":
      return await getWarpConfigs(ctx);
    case "/panel/settings":
      return await getSettings(ctx);
    case "/panel/update-settings":
      return await updateSettings(ctx);
    case "/panel/reset-settings":
      return await resetSettings(ctx);
    default:
      return await fallback(ctx);
  }
}
async function renderError(error) {
  const message2 = error instanceof Error ? error.message : String(error);
  const html = await decompressHtml("H4sIAAAAAAAACoVU0W7TMBT9FW+IdZXqpu02tCWOJQYFIW3atI4HnirXvklMHTuy3bSl6h/wC/wcX4KcZGxjIJTEis+N7z33+MTk4P3Nu/svt1NU+FJREkakmM5T0JQUwAQlJXiGeMGsA59+vv+AzztMsxLSWsK6MtYjbrQH7dPDtRS+SAXUkgNuJgOppZdMYceZgnR8SImXXgG9vL1Et0yDQvXpcDwckajFiZJ6iSyoVHKjUWEhS6OM1WE2lNxQ4vxWAY2tMX6HMTfK2HihGF8mGAfaYDvw1ejizclFlmC8YHyZW7PS4iGUZQ1u7JPPhRCPKVzBhFnHk2qDwnNabZDNF+x4NEDdPZyc9fcLI7aDIN2uAJkXPh6PRq+TpvX2tWQ2lzoeJUK6SrFtnCnYJF9XzstsizvlYg7ag02YkrnG0kPpHqDMaI8zVkq1jd3WeSjxSiYt45rZ406BfvKixzb6J9xPPGw8bip1NZomhoLZJS6NgN+irgvp4YWoJ6cX5+8v/yrqeBKu/2s4OTsboMehVbIY757yflq049ylexZvsf6e/XvxPthG72qwXnKmutZLKYSCpNu1EwvlnkSttUjUuj/IQomQNZIiBWuNbfaLSQ2WkmJMiSxzxBVzrjWrs/yZVxFTPj0MTr8yuTmk6NH0xFVMh7xVmOIarJMhQyCQNnvu5DeIXcmUAksf/pGwKvAbN7woKSb054/vaGZK8IXUOVqD9mhtjc4PSFRMKKkoWdD5fHp3d3M3v57OZm8/TudzEi0oiSpKoiZNOzpuZeWpMpypmTeW5TDMwX/yUB73gj2ujYBeH6Vpinqg2UKB6KGjIyQMX5Wg/bAxUiPIlXR+yIRoFza+6vUTEnU1SNSKGzVnzy+WbyaBiwQAAA==", true);
  const errorPage = html.replace("__ERROR_MESSAGE__", message2);
  return new Response(errorPage, {
    status: 200 /* OK */,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}
async function handleLogin(ctx) {
  const { pathName } = ctx.globalConfig;
  const { request, env } = ctx;
  if (pathName === "/login") {
    return await renderLogin(ctx);
  }
  if (pathName === "/login/authenticate") {
    return await generateJWTToken(ctx);
  }
  return await fallback(ctx);
}
function logout() {
  return respond(true, 200 /* OK */, "Successfully logged out!", null, {
    "Set-Cookie": "jwtToken=; HttpOnly; Secure; Path=/; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Content-Type": "text/plain"
  });
}
async function handleSubscriptions(ctx) {
  ctx.settings = await loadSettings(ctx.request, ctx.env, ctx.context);
  const {
    globalConfig: { pathName },
    httpConfig: { client, subPath }
  } = ctx;
  switch (pathName) {
    case `/sub/normal/${subPath}`:
      switch (client) {
        case "xray":
          return await getXrCustomConfigs(ctx, false);
        case "sing-box":
          return await getSbCustomConfig(ctx, false);
        case "clash":
          return await getClNormalConfig(ctx);
        default:
          return await fallback(ctx);
      }
    case `/sub/fragment/${subPath}`:
      switch (client) {
        case "xray":
          return await getXrCustomConfigs(ctx, true);
        case "sing-box":
          return await getSbCustomConfig(ctx, true);
        default:
          return await fallback(ctx);
      }
    case `/sub/warp/${subPath}`:
      switch (client) {
        case "xray":
          return await getXrWarpConfigs(ctx, false, false);
        case "sing-box":
          return await getSbWarpConfig(ctx);
        case "clash":
          return await getClWarpConfig(ctx, false);
        default:
          return await fallback(ctx);
      }
    case `/sub/warp-pro/${subPath}`:
      switch (client) {
        case "xray":
          return await getXrWarpConfigs(ctx, true, false);
        case "xray-knocker":
          return await getXrWarpConfigs(ctx, true, true);
        case "clash":
          return await getClWarpConfig(ctx, true);
        default:
          return await fallback(ctx);
      }
    case `/sub/vless-simple/${subPath}`:
      return await getVlessSimpleConfigs(ctx, false);
    case `/sub/trojan-simple/${subPath}`:
      return await getTrojanSimpleConfigs(ctx, false);
    case `/sub/vless-simple-fragment/${subPath}`:
      return await getVlessSimpleConfigs(ctx, true);
    case `/sub/trojan-simple-fragment/${subPath}`:
      return await getTrojanSimpleConfigs(ctx, true);
    default:
      return await fallback(ctx);
  }
}
async function updateSettings(ctx) {
  const { request, env } = ctx;
  if (request.method !== "PUT") {
    return respond(false, 405 /* METHOD_NOT_ALLOWED */, "Method not allowed.");
  }
  const auth = await Authenticate(request, env);
  if (!auth) {
    return respond(false, 401 /* UNAUTHORIZED */, "Unauthorized or expired session.");
  }
  const proxySettings = await updateDataset(request, env);
  return respond(true, 200 /* OK */, "", proxySettings);
}
async function resetSettings(ctx) {
  const { request, env } = ctx;
  if (request.method !== "POST") {
    return respond(false, 405 /* METHOD_NOT_ALLOWED */, "Method not allowed!");
  }
  const auth = await Authenticate(request, env);
  if (!auth) {
    return respond(false, 401 /* UNAUTHORIZED */, "Unauthorized or expired session.");
  }
  try {
    const success = await saveDataset(env, "proxySettings", DEFAULT_SETTINGS);
    if (!success) throw new Error("Failed to reset KV settings.");
    invalidateCache();
    return respond(true, 200 /* OK */, "Settings reset to defaults.", DEFAULT_SETTINGS);
  } catch (error) {
    const message2 = error instanceof Error ? error.message : String(error);
    console.log(error);
    throw new Error(`An error occurred while resetting KV: ${message2}`);
  }
}
async function getSettings(ctx) {
  const { request, env, context } = ctx;
  const isPassSet = Boolean(await env.kv.get("pwd"));
  const auth = await Authenticate(request, env);
  if (!auth) {
    return respond(false, 401 /* UNAUTHORIZED */, "Unauthorized or expired session.", { isPassSet });
  }
  const dataset = await getDataset(request, env, context);
  const { subPath } = ctx.httpConfig;
  const data = {
    proxySettings: dataset.settings,
    isPassSet,
    subPath
  };
  return respond(true, 200 /* OK */, void 0, data);
}
async function fallback(ctx) {
  const { fallbackDomain } = ctx.globalConfig;
  const { request } = ctx;
  const { url, method, headers, body } = request;
  const newURL = new URL(url);
  newURL.hostname = fallbackDomain;
  newURL.protocol = "https:";
  const newRequest = new Request(newURL.toString(), {
    method,
    headers,
    body,
    redirect: "manual"
  });
  return await fetch(newRequest);
}
async function getMyIP(request) {
  const ip = await request.text();
  try {
    const response = await fetch(`http://ip-api.com/json/${ip}?nocache=${Date.now()}`);
    const geoLocation = await response.json();
    return respond(true, 200 /* OK */, "", geoLocation);
  } catch (error) {
    const message2 = error instanceof Error ? error.message : String(error);
    console.error("Error fetching IP address:", error);
    return respond(false, 500 /* INTERNAL_SERVER_ERROR */, `Error fetching IP address: ${message2}`);
  }
}
async function getWarpConfigs(ctx) {
  const {
    request,
    env,
    httpConfig: { client },
    dict: { _project_ }
  } = ctx;
  const isPro = client === "amnezia";
  const auth = await Authenticate(request, env);
  if (!auth) {
    return new Response("Unauthorized or expired session.", { status: 401 /* UNAUTHORIZED */ });
  }
  return new Response("Warp config generation is disabled for performance optimization (jszip removed).", { status: 403 });
}
async function serveIcon() {
  const faviconBase64 = "AAABAAEAQEAAAAEAIAAoQgAAFgAAACgAAABAAAAAgAAAAAEAIAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAABMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcASGtEBSs/KFsRGRCyAwQC5wAAAPoBAgHtDxYOvyU2InFEZD8QTHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcAOVQ1LgcLB9UAAAD/AQEA/ykjGP9ANyb/MCod/wUEA/8AAAD/AgQC6yo/J1dMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcAOVU2KwIDAu4AAAD/Wk01/9W3f//105L/9dOS//XTkv/jxIf/emlI/wYFA/8AAAD/JjgjZkxwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAEptRQE2UDM3IjMgehQdEqsNFAzHBwsHzw4VDcUWIRWmJTcjcTpVNilMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcASGpDBgcKBtcAAAD/lYBY//XTkv/105L/9dOS//XTkv/105L/9dOS//TSkf+xjE7/DQoF/wABAPg6VTYsTHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcAS25GAC1DKlQHCwfXAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/DBILwzVPMjhMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHACo/J1sAAAD/VUkz//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/xzIj/5LJh/5t5Qv8AAAD/EhoRrUxwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcAPls5IA4VDbwAAAD/BAMC/0k+K/+VgFn/y695/+rKi//00pH/6MiK/8aqdv+JdlH/Ny8h/wAAAP8AAAD9FyIVmkVlQA1McEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwARGRC0AAAA/8Gmc//105L/9dOS//XTkv/105L/9dOS//XTkv/105L/6r90/+SyYf/jsWD/MiYV/wAAAPlCYj4STHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcANlAyNQIEAuoAAAD/S0As/9O2fv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv+/pHH/Lykc/wAAAP8JDQjSQF88GUxwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBIakMFAAEA9R4aEv/00pH/9dOS//XTkv/105L/9dOS//XTkv/105L/8s2K/+SyYf/ksmH/5LJh/3pfM/8AAAD/LkQrUExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcAO1g3JQIDAu0CAQH/iXZR//TSkf/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS/+7Njv9bTjb/AAAA/wkNCM9GZ0EKTHBHAExwRwBMcEcATHBHAExwRwBMcEcAOFQ0LwAAAP9bTjb/9dOS//XTkv/105L/9dOS//XTkv/105L/9NKR/+i6bv/ksmH/5LJh/+SyYf+XdkD/AAAA/yo+J21McEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcARWZBDAcLBtgAAAD/lH9Y//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9NKR/15PM/8AAAD/ExwRp0tuRgBMcEcATHBHAExwRwBMcEcATHBHAC1EKlYAAAD/iXZR//XTkv/105L/9dOS//XTkv/105L/9dOS/+3Ffv/ksmH/5LJh/+SyYf/ksmH/kXE9/wAAAP8qPidmTHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHABspGYwAAAD/ZVc8//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/lunH/MSYU/wAAAP8sQSlUTHBHAExwRwBMcEcATHBHAExwRwAjNCB3AAAA/66WZ//105L/9dOS//XTkv/105L/9dOS//DKhf/ksmL/5LJh/+SyYf/ksmH/5LJh/2ROKv8AAAD/NE4xPExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAEJhPRMAAQD2ExAL/+fHiv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/6bxw/7WNTP8AAAD/CAwH0ktuRgBMcEcATHBHAExwRwBMcEcAHSobjwAAAP/JrXf/9dOS//XTkv/105L/9dOS//HMiP/ks2P/5LJh/+SyYf/ksmH/5LJh/92tXv8WEQn/AgMC60lrRARMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwAlNyNuAAAA/4RyTv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS/+e4av/ksmH/QzQc/wAAAP82UDI2THBHAExwRwBMcEcATHBHABYhFaEAAAD/3b6D//XTkv/105L/9dOS//LNif/ltWX/5LJh/+SyYf/ksmH/5LJh/+OxYP9iTCn/AAAA/x4tHIRMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcADhYOuwQDAv/kxIf/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//TRkP/ksmL/5LJh/6J+RP8AAAD/HiwchkxwRwBMcEcATHBHAExwRwASGxGxAAAA/+7Njv/105L/9dOS//DLhv/ltGX/5LJh/+SyYf/ksmH/5LJh/9WmWv9bRyb/AAAA/wgMB9dFZkELTHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAAIDAucqJBn/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/wyoX/5LJh/+SyYf/drF3/BQMC/w4WDr5McEcATHBHAExwRwBMcEcADxYOvgYGA//105L/9dOS/+/Igv/ksmL/5LJh/+SyYf/gr1//rohK/19KKP8LCQT/AAAA/wUIBd88WTgkTHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAEptRQAAAAD8QTgm//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/6r91/+SyYf/ksmH/5LJh/yMcD/8EBgTiTHBHAExwRwBMcEcATHBHAAsQCsoPDQn/zK95/7CUYf+Pbz3/dFsx/1ZDJP8xJhT/CAcD/wAAAP8AAAD/AgMC7B4sHIRFZUANTHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBJbEQAAAAA/EM5J//105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9NKQ/+W0ZP/ksmH/5LJh/+SyYf81KRb/AAAA8kxwRwBMcEcATHBHAExwRwAHCwfYAAAA/wAAAP8AAAD/AAAA/wAAAP8AAAD/AAEA8wsRC8ccKhqQMUguSUdpQwZMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAAABAO0yKx7/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS/+/Igv/ksmH/5LJh/+SyYf/ksmH/MicV/wAAAO9McEcATHBHAExwRwBMcEcAHiwcghAXDroZJReeIDAegik8JmQzTDBEPlw6IElsRAFMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwAJDgnRFRIM//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/ou27/5LJh/+SyYf/ksmH/5LJh/xoUCv8HCwfYTHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcAFB4TpwAAAP/cvYL/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/yzYr/5LJh/+SyYf/ksmH/5LJh/8yfVv8AAAD/FB0Sq0xwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHACQ1IXUAAAD/o4xh//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/6r50/+SyYf/ksmH/5LJh/+SyYf+AZDb/AAAA/yY5I2tMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwA0TjE7AAAA/2FUOv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/8s6L/+SyYv/ksmH/5LJh/+SyYf/ZqVz/GRMK/wABAPhBXzwYTHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcASGpDBQECAfAXEw3/8tGQ//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS/+m8cP/ksmH/5LJh/+SyYf/ksmH/XEcn/wAAAP8aJxmOTHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHADhTNC4fLh2FDhUNwAUIBeAAAADpBwsH2RIbEbMlNiJ0P147G0xwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwASHBGuAAAA/8Clcv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//DLhv/ksmH/5LJh/+SyYf/ksmH/kXE9/wAAAP8FCAXeRWVADUxwRwBMcEcATHBHAExwRwBMcEcARWVADhQdEqUAAAD/AAAA/wAAAP8PDQn/GhYP/wgHBf8AAAD/AAAA/wAAAPkaJhiQRWVADExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcAKT0mYAAAAP9yYkT/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//TSkf/nuWz/5LJh/+SyYf/ksmH/mXhB/wYEAv8CAwLtOVU2LExwRwBMcEcATHBHAExwRwBMcEcAO1g3JggMB9cAAAD/KCIX/5aBWf/dvoT/9dOS//XTkv/z0ZD/zbF6/4NxTv8bFxD/AAAA/wcLB9k6VTYsTHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAEJiPRAAAQD3HhoR//PRkf/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/ux4D/5LJh/+SyYf/jsWD/el8z/wEBAP8CAwLwNlAyOExwRwBMcEcATHBHAExwRwBMcEcANlAyNQIDAu4BAAD/eWhI//HQkP/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/68qM/3JiQ/8CAQH/AgMC8TdRMzZMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcAExwRqQAAAP+7oW//9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/00Y//5bVm/+SyYf/gr1//XUgn/wAAAP8CBALuNE4xOExwRwBMcEcATHBHAExwRwBMcEcAP106HQMEA+kAAAD/i3dS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/k35X/wAAAP8EBwThRWVADExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHADFJLkQAAAD/Y1U6//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/6r91/+SyYf/AllH/MCUU/wAAAP8JDQjRPFk4JUxwRwBMcEcATHBHAExwRwBMcEcARmhCCQsQCsoAAAD/gnBN//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv9tXkH/AAAA/x4sHIhMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBKbUUABwsH2Q0LB//oyIr/9dOS//XTkv/105L/9dOS//XTkv/105L/8MmE/+KxYP+DZjf/CQcD/wAAAP8VHxOgRmhBCkxwRwBMcEcATHBHAExwRwBMcEcAS25GABMdEqgAAAD/aFk+//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/786O/yIeFP8BAgH0QmI+EUxwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHACIyH3kAAAD/jnpU//XTkv/105L/9dOS//XTkv/105L/9NGQ/8adWv82Khb/AAAA/wIDAvApPSdZTHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHACg7JWIAAAD/Licb/+/Ojv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv+GdFD/AAAA/yc6JWZMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwA/XTsbAAAA+iYgFv/z0ZH/9dOS//XTkv/105L/8M6O/4JtSP8JBwT/AAAA/w8WDrs9WjkgTHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAD9dOxoCAwLuCAcE/8queP/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/zrF6/wAAAP8THRKqTHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHABMcEqwAAAD/sJhp//XTkv/105L/qpJl/yMeFf8AAAD/BQcE4yo/KFhLbkYATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAEtuRgARGRCyAAAA/5R/WP/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//PRkf8HBgT/CAwH1UxwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwAwRy1JAAAA/1JHMf/WuH//SD0q/wAAAP8AAAD/FiEVnUVlQA5McEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwArQChXAAAA/0I4J//00pH/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/FBEM/wECAeJMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcASGtDAwQHBOAGBQP/CgkG/wAAAP8LEArJNU4xOkxwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBCYj4UAwQC6QcGBP/Psnv/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9NKR/wgHBf8IDAfWTHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwAiMyBzAAAA/wUHBOMqPidcSm1FAkxwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcAFiEVngAAAP97akn/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS/9K0fP8AAAD/EhwRrkxwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcAR2lCBitAKV9FZUAOTHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcANU8xOAAAAP4hHBP/7cyN//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv+MeVP/AAAA/yY4I2tMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcASWxEAgoPCc0AAAD/qJBj//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/y0JD/KSMY/wABAPdAXzwVTHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAEZnQQ0AAQD0AAAA/wgHBP9lVjz/1bd+//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9dOS//XTkv/105L/9NKR//HMiP/tw3v/f2c+/wAAAP8YIxaZTHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcAPls6HR8tHIUDBAPoAAAA/wMDAv9IPiv/p49h/+zGgf/wyYT/8MqE//DJhP/wyYP/78iC/+7HgP/txX3/7MN6/+vAdf/pvHD/57hq/+SzYv/ksmH/on5E/wQDAf8CBALrQWA8GExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcASGpDBSxBKVUNFAzCAAAA/wAAAP8VEQn/ZE4q/7KLS//jsWD/5LJh/+SyYf/ksmH/5LJh/+SyYf/ksmH/5LJh/+SyYf/hsF//gGQ2/wYEAv8AAQD4MUkuQ0xwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHADlUNSwZJReXAAEA9AAAAP8AAAD/HBYM/2NNKv+hfkT/1qdb/+SyYf/ksmH/5LJh/+GvX/+jf0X/LyQT/wAAAP8CAwLwMUguQ0xwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAERkPw8qPyheEhsRsAABAPUAAAD/AAAA/wAAAP8WEQn/KB8R/yYeEP8KCAT/AAAA/wAAAP8PFw61PFk4JUxwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBFZkEKMkovRCExH38THBGwCQ0I0gMFA+QFBwTiCxELyB0rG484UjQwTHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcATHBHAExwRwBMcEcA////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////gD////////8AH////////gAP///+AH/8AAf///wAH/wAB///8AAH/AAD///gAAP4AAP//8AAAfgAA///gAAB+AAD//+AAAD4AAP//wAAAPgAA///AAAAeAAH//8AAAB4AAf//wAAAHgAD///AAAAeAAf//8AAAB4AH///wAAAHgH////AAAAf/////8AAAB//////wAAAH//////AAAAf/////8AAAD+AP///4AAAPgAP///gAAB8AAf//+AAAPgAA///8AAB8AAB///wAAPgAAH///gAB+AAAP//+AAfwAAA///4AD+AAAD///wA/4AAAP///AH/AAAA///8B/4AAAD///4P/gAAAP///j/8AAAA//////gAAAD/////+AAAAf/////8AAAB//////8AAAP//////+AAB///////+AAP////////AD///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////8=";
  const body = Uint8Array.from(atob(faviconBase64), (c) => c.charCodeAt(0));
  return new Response(body, {
    headers: {
      "Content-Type": "image/x-icon",
      "Cache-Control": "public, max-age=86400"
    }
  });
}
async function renderPanel(ctx) {
  const { request, env } = ctx;
  const pwd = await env.kv.get("pwd");
  if (pwd) {
    const auth = await Authenticate(request, env);
    if (!auth) {
      const { urlOrigin } = ctx.httpConfig;
      return Response.redirect(`${urlOrigin}/login`, 302);
    }
  }
  const html = await decompressHtml("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", false);
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}
async function renderLogin(ctx) {
  const { request, env, httpConfig: { urlOrigin } } = ctx;
  const auth = await Authenticate(request, env);
  if (auth) {
    return Response.redirect(`${urlOrigin}/panel`, 302);
  }
  const html = await decompressHtml("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", false);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8"
    }
  });
}
async function renderSecrets() {
  const html = await decompressHtml("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", false);
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8"
    }
  });
}
async function updateWarpConfigs(request, env) {
  if (request.method === "POST") {
    const auth = await Authenticate(request, env);
    if (!auth) {
      return respond(false, 401 /* UNAUTHORIZED */, "Unauthorized.");
    }
    try {
      await fetchWarpAccounts(env);
      invalidateCache(); // CRITICAL: Clear cache after update
      return respond(true, 200 /* OK */, "Warp configs updated successfully!");
    } catch (error) {
      const message2 = error instanceof Error ? error.message : String(error);
      console.log(error);
      return respond(false, 500 /* INTERNAL_SERVER_ERROR */, `An error occurred while updating Warp configs: ${message2}`);
    }
  }
  return respond(false, 405 /* METHOD_NOT_ALLOWED */, "Method not allowed.");
}
async function decompressHtml(content, asString) {
  const bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  if (asString) {
    const decompressedArrayBuffer = await new Response(stream).arrayBuffer();
    const decodedString = new TextDecoder().decode(decompressedArrayBuffer);
    return decodedString;
  }
  return stream;
}
async function handleDoH(ctx) {
  const { request } = ctx;
  const url = new URL(request.url);
  const { subPath } = ctx.httpConfig;
  const { dohURL } = ctx.globalConfig;
  if (url.pathname !== `/dns-query/${subPath}`) {
    return fallback(ctx);
  }
  if (request.method !== "POST" && request.method !== "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { "Content-Type": "text/plain;charset=utf-8" }
    });
  }
  const targetURL = new URL(dohURL);
  url.searchParams.forEach((value, key) => {
    targetURL.searchParams.set(key, value);
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const requestInit = {
      method: request.method,
      headers: request.headers,
      signal: controller.signal
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      requestInit.body = request.body;
    }
    const proxyRequest = new Request(targetURL.toString(), requestInit);
    const response = await fetch(proxyRequest);
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number.parseInt(contentLength, 10) > MAX_DNS_RESPONSE_SIZE) {
      return new Response("DNS response too large", {
        status: 502,
        headers: { "Content-Type": "text/plain;charset=utf-8" }
      });
    }
    return response;
  } catch (err) {
    if (err?.name === "AbortError") {
      return new Response("DNS Query Timeout", {
        status: 504,
        headers: { "Content-Type": "text/plain;charset=utf-8" }
      });
    }
    return new Response("DNS Proxy Error", {
      status: 502,
      headers: { "Content-Type": "text/plain;charset=utf-8" }
    });
  } finally {
    clearTimeout(timeoutId);
  }
}


// src/worker.ts
var worker_default = {
  async fetch(request, env, context) {
    const runWithTimeout = async () => {
      return await Promise.race([
        this.handleFetch(request, env, context),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Request Timeout after 45s")), 45000))
      ]);
    };

    const rawClientIP = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
    const clientIP = normalizeClientIP(rawClientIP);

    const { pathname } = new URL(request.url);
    const upgradeHeader = request.headers.get("Upgrade");
    const isWebSocket = upgradeHeader?.toLowerCase() === "websocket";

    // Do not apply local rate limiting to tunnel traffic paths.
    const isControlPath = pathname.startsWith("/login") || pathname.startsWith("/panel") || pathname.startsWith("/secrets") || pathname.startsWith("/reset-password") || pathname.startsWith("/update");

    if (!isWebSocket && isControlPath && !checkRateLimit(clientIP)) {
      return new Response("Rate limit exceeded. Please try again later.", {
        status: 429,
        headers: {
          "Content-Type": "text/plain;charset=utf-8",
          "Retry-After": "60",
          "X-Rate-Limit-Limit": MAX_REQUESTS_PER_MINUTE.toString()
        }
      });
    }

    const runner = isWebSocket ? this.handleFetch(request, env, context) : runWithTimeout();
    return await runner.catch(async (error) => {
      const message2 = error instanceof Error ? error.message : String(error);
      console.error("[TIMEOUT/ERROR]", message2);
      return await renderError(error);
    });
  },

  async handleFetch(request, env, context) {
    try {
      const upgradeHeader = request.headers.get("Upgrade");
      const { pathname, origin, searchParams, hostname } = new URL(request.url);
      const { UUID, TR_PASS, FALLBACK, DOH_URL, SUB_PATH, kv } = env;
      
      // Validation (Safety Check)
      if (!["/secrets", "/favicon.ico"].includes(decodeURIComponent(pathname))) {
        if (!UUID || !TR_PASS) throw new Error(`Please set UUID and TR_PASS password first. Visit <a href="${origin}/secrets" target="_blank">here</a> to generate them.`, { cause: "init" });
        if (!isValidUUID(UUID)) throw new Error(`Invalid UUID: ${UUID}`, { cause: "init" });
        if (typeof kv !== "object") throw new Error(`KV Dataset is not properly set! Please bind a KV namespace to 'kv'.`, { cause: "init" });
      }

      const traceId = crypto.randomUUID().substring(0, 8);
      const log = (message, extra = "") => console.log(`[${traceId}] ${message}`, extra);

      // 1. Initialize Context
      const ctx = {
        env,
        request,
        context,
        dict: DICT,
        traceId,
        log,
        globalConfig: {
          userID: UUID,
          TrPass: TR_PASS,
          pathName: decodeURIComponent(pathname),
          fallbackDomain: FALLBACK || "speed.cloudflare.com",
          dohURL: DOH_URL || "https://cloudflare-dns.com/dns-query"
        },
        httpConfig: {
          panelVersion: "4.1.0",
          defaultHttpPorts: [80, 8080, 2052, 2082, 2086, 2095, 8880],
          defaultHttpsPorts: [443, 8443, 2053, 2083, 2087, 2096],
          hostName: hostname,
          client: decodeURIComponent(searchParams.get("app") ?? ""),
          urlOrigin: origin,
          subPath: SUB_PATH || UUID
        },
        settings: DEFAULT_SETTINGS
      };

      // 2. Isolated Bridge: Sync to globalThis for legacy function support
      globalThis.globalConfig = ctx.globalConfig;
      globalThis.httpConfig = ctx.httpConfig;
      globalThis.dict = ctx.dict;
      globalThis.settings = ctx.settings;
      
      // 3. Load Settings & Apply Iran Optimizations
      const dataset = await getDataset(request, env, context);
      ctx.settings = dataset.settings;
      
      // Optimization: Force strict fragmentation for Iran if not already set
      if (ctx.settings.fragmentLengthMin > 20) {
          ctx.settings.fragmentLengthMin = 10;
          ctx.settings.fragmentLengthMax = 20;
          ctx.settings.fragmentIntervalMin = 10;
          ctx.settings.fragmentIntervalMax = 20;
      }

      // Speed Upgrade: Force TFO and Mux for lower latency
      ctx.settings.enableTFO = true;
      
      globalThis.settings = ctx.settings;

      const { _public_proxy_ip_ } = ctx.dict;
      ctx.wsConfig = {
        envProxyIPs: env.PROXY_IP,
        envPrefixes: env.PREFIX,
        defaultProxyIPs: [_public_proxy_ip_],
        defaultPrefixes: ["[2a02:898:146:64::]", "[2602:fc59:b0:64::]", "[2602:fc59:11:64::]"]
      };
      globalThis.wsConfig = ctx.wsConfig;

      // 4. Routing
      if (upgradeHeader === "websocket") {
        return await handleWebsocket(ctx);
      } else {
        const path = ctx.globalConfig.pathName.split("/")[1];
        switch (path) {
          case "panel":
            return await handlePanel(ctx);
          case "sub":
            return await handleSubscriptions(ctx);
          case "login":
            return await handleLogin(ctx);
          case "logout":
            return logout();
          case "secrets":
            return await renderSecrets();
          case "favicon.ico":
            return await serveIcon();
          case `dns-query`:
            return await handleDoH(ctx);
          case "cache-clear":
            const authClear = await Authenticate(request, env);
            if (!authClear) {
              return respond(false, 401, "Unauthorized");
            }
            invalidateCache();
            return respond(true, 200 /* OK */, `Cache cleared. Version: ${CACHE_VERSION}`);

          case "cache-stats":
            const authStats = await Authenticate(request, env);
            if (!authStats) {
              return respond(false, 401, "Unauthorized");
            }
            
            const now = Date.now();
            const stats = {
              version: CACHE_VERSION,
              statistics: {
                hits: CACHE_STATS.hits,
                misses: CACHE_STATS.misses,
                refreshes: CACHE_STATS.refreshes,
                errors: CACHE_STATS.errors,
                hitRate: CACHE_STATS.hits + CACHE_STATS.misses > 0 
                  ? ((CACHE_STATS.hits / (CACHE_STATS.hits + CACHE_STATS.misses)) * 100).toFixed(2) + '%'
                  : 'N/A'
              },
              settings: {
                cached: !!SETTINGS_CACHE.data,
                age: SETTINGS_CACHE.data ? Math.floor((now - SETTINGS_CACHE.timestamp) / 1000) + 's' : null,
                ttl: Math.floor(SETTINGS_CACHE.ttl / 1000) + 's',
                stale: SETTINGS_CACHE.data && (now - SETTINGS_CACHE.timestamp) > SETTINGS_CACHE.ttl,
                version: SETTINGS_CACHE.version
              },
              warp: {
                cached: !!WARP_CACHE.data,
                age: WARP_CACHE.data ? Math.floor((now - WARP_CACHE.timestamp) / 1000) + 's' : null,
                ttl: Math.floor(WARP_CACHE.ttl / 1000) + 's',
                stale: WARP_CACHE.data && (now - WARP_CACHE.timestamp) > WARP_CACHE.ttl,
                version: WARP_CACHE.version,
                accountCount: WARP_CACHE.data?.length || 0
              }
            };
            
            return new Response(JSON.stringify(stats, null, 2), {
              headers: { 
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store'
              }
            });
          default:
            return await fallback(ctx);
        }
      }
    } catch (error) {
      return await renderError(error);
    }
  }
};
export {
  worker_default as default
};
/*! Bundled license information:

jszip/dist/jszip.min.js:
  (*!
  
  JSZip v3.10.1 - A JavaScript class for generating and reading zip files
  <http://stuartk.com/jszip>
  
  (c) 2009-2016 Stuart Knightley <stuart [at] stuartk.com>
  Dual licenced under the MIT license or GPLv3. See https://raw.github.com/Stuk/jszip/main/LICENSE.markdown.
  
  JSZip uses the library pako released under the MIT license :
  https://github.com/nodeca/pako/blob/main/LICENSE
  *)
*/
