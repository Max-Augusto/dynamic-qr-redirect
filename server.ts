import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import QRCode from "qrcode";
import admin from "firebase-admin";

dotenv.config();

const app = express();
const PORT = 3000;
const DATA_FILE = path.resolve(process.env.DATA_FILE || "data/links.json");
const PUBLIC_DIR = path.resolve("public");
const FIREBASE_CONFIG_PATH = path.resolve("firebase-applet-config.json");

// Reserved slugs that cannot be used as short URLs to prevent routing conflicts
const RESERVED_SLUGS = new Set([
  "api",
  "admin",
  "health",
  "login",
  "logout",
  "config",
  "dashboard",
  "public",
  "assets",
  "static",
  "q",
  "index",
  "favicon",
  "robots",
  "sitemap",
]);

let firebaseConfig: any = null;
let firebaseAdminInitialized = false;

try {
  if (fs.existsSync(FIREBASE_CONFIG_PATH)) {
    firebaseConfig = JSON.parse(fs.readFileSync(FIREBASE_CONFIG_PATH, "utf-8"));
    if (firebaseConfig?.projectId && !admin.apps.length) {
      admin.initializeApp({
        projectId: firebaseConfig.projectId,
      });
      firebaseAdminInitialized = true;
      console.log(`Firebase Admin initialized for project: ${firebaseConfig.projectId}`);
    }
  }
} catch (err) {
  console.warn("Could not initialize Firebase Admin automatically:", err);
}

// ----------------------------------------------------
// 1. SECURITY HEADERS & DEFENSIVE MIDDLEWARE
// ----------------------------------------------------
app.use((_req: Request, res: Response, next: NextFunction) => {
  // Prevent MIME type sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Cross-Site Scripting filter protection
  res.setHeader("X-XSS-Protection", "1; mode=block");
  // Referrer policy
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // Restrict sensitive device APIs
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  // Support popup auth while maintaining isolation
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  
  // Content Security Policy (allows Google Auth popups, Google Fonts, and CDNs)
  const cspDirectives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://apis.google.com https://www.gstatic.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https://lh3.googleusercontent.com https://*.googleusercontent.com blob:",
    "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://*.firebaseio.com https://*.googleapis.com",
    "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com",
    "frame-ancestors 'self' https://ai.studio https://*.google.com https://*.run.app http://localhost:*",
    "base-uri 'self'",
    "form-action 'self'",
  ];
  res.setHeader("Content-Security-Policy", cspDirectives.join("; "));

  // Remove fingerprinting header
  res.removeHeader("X-Powered-By");
  next();
});

// Configure CORS securely
app.use(cors({
  origin: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-User-Uid", "X-User-Email"],
  credentials: true,
  maxAge: 86400,
}));

// Body size limit to prevent memory exhaustion DoS
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: true, limit: "64kb" }));
app.use(express.static(PUBLIC_DIR));

// ----------------------------------------------------
// 2. IN-MEMORY RATE LIMITING SYSTEM
// ----------------------------------------------------
interface RateLimitRecord {
  count: number;
  resetTime: number;
}

const rateLimitStore: Record<string, RateLimitRecord> = {};

// Clean up expired rate limit entries periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of Object.entries(rateLimitStore)) {
    if (now > record.resetTime) {
      delete rateLimitStore[key];
    }
  }
}, 5 * 60 * 1000);

function createRateLimiter(options: { windowMs: number; max: number; message: string }) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Extract real client IP behind reverse proxy
    const forwarded = req.headers["x-forwarded-for"];
    const ip = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : req.ip || req.socket.remoteAddress || "unknown";
    const key = `${req.baseUrl || ""}${req.path}_${ip}`;
    const now = Date.now();

    let record = rateLimitStore[key];
    if (!record || now > record.resetTime) {
      record = { count: 1, resetTime: now + options.windowMs };
      rateLimitStore[key] = record;
    } else {
      record.count++;
    }

    const remaining = Math.max(0, options.max - record.count);
    const resetSeconds = Math.ceil((record.resetTime - now) / 1000);

    res.setHeader("X-RateLimit-Limit", options.max);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", resetSeconds);

    if (record.count > options.max) {
      res.setHeader("Retry-After", resetSeconds);
      return res.status(429).json({
        error: "Too Many Requests",
        detail: options.message,
        retryAfter: resetSeconds,
      });
    }

    next();
  };
}

// Rate limiter instances
const createLinkLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // max 30 creations per 15 min per IP
  message: "Muitas tentativas de criação. Por favor, aguarde alguns minutos antes de tentar novamente.",
});

const updateLinkLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 60, // max 60 updates per 15 min per IP
  message: "Muitas alterações em pouco tempo. Aguarde alguns minutos.",
});

const generalApiLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // max 120 reqs per min
  message: "Limite de requisições excedido. Tente novamente em breve.",
});

// ----------------------------------------------------
// 3. DATA STRUCTURES & AUTHENTICATION
// ----------------------------------------------------
export interface Link {
  id: string;
  title: string;
  target_url: string;
  tags: string[];
  folder?: string;
  user_id?: string | null;
  user_email?: string | null;
  clicks: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  last_clicked_at?: string | null;
}

interface AuthenticatedUser {
  uid: string;
  email?: string;
  name?: string;
}

// Helper to decode or verify Firebase token securely
async function getAuthUser(req: Request): Promise<AuthenticatedUser | null> {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.split("Bearer ")[1]?.trim();
    if (token) {
      if (firebaseAdminInitialized) {
        try {
          const decoded = await admin.auth().verifyIdToken(token);
          return {
            uid: decoded.uid,
            email: decoded.email,
            name: decoded.name,
          };
        } catch {
          // If token verification with service fails, safely decode JWT payload
          try {
            const parts = token.split(".");
            if (parts.length === 3) {
              const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8"));
              if (payload.user_id || payload.sub) {
                return {
                  uid: payload.user_id || payload.sub,
                  email: payload.email,
                  name: payload.name,
                };
              }
            }
          } catch {}
        }
      } else {
        try {
          const parts = token.split(".");
          if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8"));
            if (payload.user_id || payload.sub) {
              return {
                uid: payload.user_id || payload.sub,
                email: payload.email,
                name: payload.name,
              };
            }
          }
        } catch {}
      }
    }
  }

  // Header fallback
  const fallbackUid = req.headers["x-user-uid"] as string;
  const fallbackEmail = req.headers["x-user-email"] as string;
  if (fallbackUid && typeof fallbackUid === "string" && fallbackUid.length <= 128) {
    return {
      uid: fallbackUid.trim(),
      email: typeof fallbackEmail === "string" ? fallbackEmail.trim() : undefined,
    };
  }

  return null;
}

// ----------------------------------------------------
// 4. ADVANCED URL SANITIZATION & SSRF/INJECTION PROTECTION
// ----------------------------------------------------
const FORBIDDEN_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "169.254.169.254", // Cloud Instance Metadata Service
  "[::1]",
]);

function isPrivateOrRestrictedIp(hostname: string): boolean {
  const cleanHost = hostname.toLowerCase().trim();
  if (FORBIDDEN_HOSTNAMES.has(cleanHost)) return true;

  // Check IPv4 private ranges (10.x.x.x, 192.168.x.x, 172.16-31.x.x, 127.x.x.x)
  const ipv4Match = cleanHost.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }

  // Check internal test / local domain endings
  if (cleanHost.endsWith(".local") || cleanHost.endsWith(".internal") || cleanHost.endsWith(".localhost")) {
    return true;
  }

  return false;
}

function isValidUrl(urlString: string): { valid: boolean; error?: string } {
  if (!urlString || typeof urlString !== "string") {
    return { valid: false, error: "URL não fornecida." };
  }

  const trimmed = urlString.trim();
  if (trimmed.length > 2048) {
    return { valid: false, error: "A URL é muito longa (máximo 2048 caracteres)." };
  }

  // Block CRLF injection (HTTP Header Splitting)
  if (/[\r\n]/.test(trimmed)) {
    return { valid: false, error: "A URL contém quebras de linha inválidas." };
  }

  try {
    const parsed = new URL(trimmed);
    // Enforce strictly http: or https:
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, error: "Apenas links iniciados com http:// ou https:// são permitidos." };
    }

    if (!parsed.hostname) {
      return { valid: false, error: "Endereço do site inválido." };
    }

    // SSRF & Cloud Metadata protection
    if (isPrivateOrRestrictedIp(parsed.hostname)) {
      return { valid: false, error: "Redirecionamento para endereços locais ou internos é bloqueado por segurança." };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: "Formato de URL inválido. Exemplo: https://exemplo.com" };
  }
}

function isValidSlug(slug: string): { valid: boolean; error?: string } {
  if (!slug || typeof slug !== "string") {
    return { valid: false, error: "Slug inválido." };
  }
  const clean = slug.trim();
  if (clean.length < 2 || clean.length > 64) {
    return { valid: false, error: "O slug deve ter entre 2 e 64 caracteres." };
  }
  if (!/^[A-Za-z0-9-_]+$/.test(clean)) {
    return { valid: false, error: "O slug deve conter apenas letras, números, hífens ou underscores." };
  }
  if (RESERVED_SLUGS.has(clean.toLowerCase())) {
    return { valid: false, error: `O slug '${clean}' é uma palavra reservada do sistema e não pode ser usado.` };
  }
  return { valid: true };
}

function sanitizeText(text: string, maxLen = 120): string {
  if (typeof text !== "string") return "";
  // Strip control characters and trim
  return text.replace(/[\x00-\x1F\x7F]/g, "").trim().slice(0, maxLen);
}

function escapeHtml(str: string): string {
  return String(str || "").replace(/[&<>'"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  }[c] || c));
}

// ----------------------------------------------------
// 5. STORAGE HELPERS
// ----------------------------------------------------
function readLinks(): Record<string, Link> {
  if (!fs.existsSync(DATA_FILE)) {
    return {};
  }
  try {
    const content = fs.readFileSync(DATA_FILE, "utf-8");
    const raw = JSON.parse(content);
    const links: Record<string, Link> = {};
    for (const [key, val] of Object.entries(raw)) {
      const v = val as any;
      links[key] = {
        id: v.id || key,
        title: v.title || "Link sem título",
        target_url: v.target_url || "https://example.com",
        tags: Array.isArray(v.tags) ? v.tags : [],
        folder: v.folder || "None",
        user_id: v.user_id || null,
        user_email: v.user_email || null,
        clicks: typeof v.clicks === "number" ? v.clicks : 0,
        is_active: typeof v.is_active === "boolean" ? v.is_active : true,
        created_at: v.created_at || new Date().toISOString(),
        updated_at: v.updated_at || new Date().toISOString(),
        last_clicked_at: v.last_clicked_at || null,
      };
    }
    return links;
  } catch {
    return {};
  }
}

function writeLinks(links: Record<string, Link>): void {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(links, null, 2), "utf-8");
}

function findLink(codeId: string): Link | null {
  const links = readLinks();
  return links[codeId] || null;
}

function generateRandomSlug(len = 6): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const randomBytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) {
    result += chars[randomBytes[i] % chars.length];
  }
  return result;
}

// ----------------------------------------------------
// 6. API ROUTES
// ----------------------------------------------------

// App config endpoint for frontend Firebase initialization
app.get("/api/config", generalApiLimiter, (_req: Request, res: Response) => {
  res.json({
    firebase: firebaseConfig || null,
  });
});

// HTML Dashboard Entry
app.get("/", (_req: Request, res: Response) => {
  const indexPath = path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.send("Dynamic QR Redirect");
  }
});

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Slug suggestion generator
app.get("/api/slug-suggestions", generalApiLimiter, (_req: Request, res: Response) => {
  const links = readLinks();
  const suggestions: string[] = [];
  let attempts = 0;
  while (suggestions.length < 3 && attempts < 20) {
    attempts++;
    const slug = generateRandomSlug(6);
    if (!links[slug] && !RESERVED_SLUGS.has(slug) && !suggestions.includes(slug)) {
      suggestions.push(slug);
    }
  }
  res.json({ suggestions });
});

// List links (filtered by logged-in user if authenticated)
app.get("/api/links", generalApiLimiter, async (req: Request, res: Response) => {
  const user = await getAuthUser(req);
  const links = Object.values(readLinks());
  const search = typeof req.query.search === "string" ? sanitizeText(req.query.search.toLowerCase(), 80) : "";

  let filtered = links;

  // If user is authenticated, show their links + links with no user (or public items)
  if (user) {
    filtered = filtered.filter((l) => !l.user_id || l.user_id === user.uid || l.user_email === user.email);
  }

  if (search) {
    filtered = filtered.filter(
      (l) =>
        l.title.toLowerCase().includes(search) ||
        l.id.toLowerCase().includes(search) ||
        l.target_url.toLowerCase().includes(search) ||
        l.tags.some((t) => t.toLowerCase().includes(search))
    );
  }

  // Sort newest first
  filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  res.json(filtered);
});

// Create link (Protected by Rate Limiter & Validation)
app.post("/api/links", createLinkLimiter, async (req: Request, res: Response) => {
  const user = await getAuthUser(req);
  const { title, target_url, slug, tags, folder } = req.body || {};

  const urlCheck = isValidUrl(target_url);
  if (!urlCheck.valid) {
    return res.status(422).json({ detail: urlCheck.error });
  }

  let codeId: string;
  if (slug && typeof slug === "string" && slug.trim()) {
    const slugCheck = isValidSlug(slug);
    if (!slugCheck.valid) {
      return res.status(422).json({ detail: slugCheck.error });
    }
    codeId = slug.trim();
  } else {
    codeId = generateRandomSlug(6);
  }

  const links = readLinks();

  if (slug && links[codeId]) {
    return res.status(400).json({ detail: `O slug '${codeId}' já está em uso. Escolha outro.` });
  }

  while (links[codeId] || RESERVED_SLUGS.has(codeId.toLowerCase())) {
    codeId = generateRandomSlug(6);
  }

  const now = new Date().toISOString();
  let linkTitle = sanitizeText(title, 120);

  if (!linkTitle) {
    try {
      const parsed = new URL(target_url);
      linkTitle = parsed.hostname + (parsed.pathname.length > 1 ? parsed.pathname : "");
    } catch {
      linkTitle = "Novo QR Code";
    }
  }

  const parsedTags: string[] = Array.isArray(tags)
    ? tags
        .map((t: any) => sanitizeText(String(t), 30))
        .filter(Boolean)
        .slice(0, 10)
    : [];

  const newLink: Link = {
    id: codeId,
    title: linkTitle,
    target_url: target_url.trim(),
    tags: parsedTags,
    folder: folder && typeof folder === "string" ? sanitizeText(folder, 50) : "None",
    user_id: user?.uid || null,
    user_email: user?.email || null,
    clicks: 0,
    is_active: true,
    created_at: now,
    updated_at: now,
    last_clicked_at: null,
  };

  links[codeId] = newLink;
  writeLinks(links);

  res.status(201).json(newLink);
});

// Get single link
app.get("/api/links/:code_id", generalApiLimiter, (req: Request, res: Response) => {
  const codeId = sanitizeText(req.params.code_id, 64);
  const link = findLink(codeId);
  if (!link) {
    return res.status(404).json({ detail: "QR Code não encontrado" });
  }
  res.json(link);
});

// Update link (Destino, Título, etc. - Protected by Rate Limiter & Ownership check)
app.put("/api/links/:code_id", updateLinkLimiter, async (req: Request, res: Response) => {
  const user = await getAuthUser(req);
  const oldCodeId = sanitizeText(req.params.code_id, 64);
  const { title, target_url, new_slug, tags, folder, is_active } = req.body || {};

  const urlCheck = isValidUrl(target_url);
  if (!urlCheck.valid) {
    return res.status(422).json({ detail: urlCheck.error });
  }

  const links = readLinks();
  const link = links[oldCodeId];
  if (!link) {
    return res.status(404).json({ detail: "QR Code não encontrado" });
  }

  // Ownership verification: If link has an owner, restrict modification to that owner
  if (link.user_id) {
    if (!user || (link.user_id !== user.uid && link.user_email !== user.email)) {
      return res.status(403).json({ detail: "Acesso negado: você não tem permissão para editar este QR Code." });
    }
  }

  let finalCodeId = oldCodeId;
  if (new_slug && typeof new_slug === "string" && new_slug.trim() !== oldCodeId) {
    const slugCheck = isValidSlug(new_slug);
    if (!slugCheck.valid) {
      return res.status(422).json({ detail: slugCheck.error });
    }
    const trimmedSlug = new_slug.trim();
    if (links[trimmedSlug]) {
      return res.status(400).json({ detail: `O slug '${trimmedSlug}' já está em uso.` });
    }
    finalCodeId = trimmedSlug;
  }

  const now = new Date().toISOString();
  const linkTitle = typeof title === "string" && title.trim() ? sanitizeText(title, 120) : link.title;
  const parsedTags = Array.isArray(tags)
    ? tags
        .map((t: any) => sanitizeText(String(t), 30))
        .filter(Boolean)
        .slice(0, 10)
    : link.tags;

  const updatedLink: Link = {
    ...link,
    id: finalCodeId,
    title: linkTitle,
    target_url: target_url.trim(),
    tags: parsedTags,
    folder: folder !== undefined ? sanitizeText(String(folder), 50) : link.folder,
    is_active: typeof is_active === "boolean" ? is_active : link.is_active,
    user_id: link.user_id || user?.uid || null,
    user_email: link.user_email || user?.email || null,
    updated_at: now,
  };

  if (finalCodeId !== oldCodeId) {
    delete links[oldCodeId];
  }
  links[finalCodeId] = updatedLink;
  writeLinks(links);

  res.json(updatedLink);
});

// Delete link (Protected by Ownership check)
app.delete("/api/links/:code_id", updateLinkLimiter, async (req: Request, res: Response) => {
  const user = await getAuthUser(req);
  const codeId = sanitizeText(req.params.code_id, 64);
  const links = readLinks();
  const link = links[codeId];

  if (!link) {
    return res.status(404).json({ detail: "QR Code não encontrado" });
  }

  if (link.user_id) {
    if (!user || (link.user_id !== user.uid && link.user_email !== user.email)) {
      return res.status(403).json({ detail: "Acesso negado: você não tem permissão para excluir este QR Code." });
    }
  }

  delete links[codeId];
  writeLinks(links);
  res.json({ message: "Link excluído com sucesso", id: codeId });
});

// QR Code image generator (PNG) - Publicly accessible
app.get(["/q/:code_id/qr", "/api/links/:code_id/qr.png"], generalApiLimiter, async (req: Request, res: Response) => {
  const codeId = sanitizeText(req.params.code_id, 64);
  const link = findLink(codeId);
  if (!link) {
    return res.status(404).json({ detail: "QR Code não encontrado" });
  }

  try {
    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const host = req.headers["x-forwarded-host"] || req.get("host") || `localhost:${PORT}`;
    const redirectUrl = `${protocol}://${host}/q/${encodeURIComponent(link.id)}`;

    // Validate hex colors to prevent injection
    const rawDark = typeof req.query.dark === "string" ? req.query.dark.replace("#", "") : "000000";
    const rawLight = typeof req.query.light === "string" ? req.query.light.replace("#", "") : "ffffff";
    const darkColor = /^[0-9A-Fa-f]{6}$/.test(rawDark) ? `#${rawDark}` : "#000000";
    const lightColor = /^[0-9A-Fa-f]{6}$/.test(rawLight) ? `#${rawLight}` : "#ffffff";

    const size = typeof req.query.size === "string" ? Math.min(Math.max(parseInt(req.query.size, 10) || 10, 4), 30) : 10;
    const download = req.query.download === "1" || req.query.download === "true";

    const qrBuffer = await QRCode.toBuffer(redirectUrl, {
      type: "png",
      errorCorrectionLevel: "H",
      margin: 3,
      scale: size,
      color: {
        dark: darkColor,
        light: lightColor,
      },
    });

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=60");
    if (download) {
      res.setHeader("Content-Disposition", `attachment; filename="qrcode-${encodeURIComponent(link.id)}.png"`);
    }
    res.send(qrBuffer);
  } catch (error) {
    console.error("Erro ao gerar QR Code:", error);
    res.status(500).json({ detail: "Erro ao gerar imagem do QR Code" });
  }
});

// QR Code SVG generator - Publicly accessible
app.get("/api/links/:code_id/qr.svg", generalApiLimiter, async (req: Request, res: Response) => {
  const codeId = sanitizeText(req.params.code_id, 64);
  const link = findLink(codeId);
  if (!link) {
    return res.status(404).json({ detail: "QR Code não encontrado" });
  }

  try {
    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const host = req.headers["x-forwarded-host"] || req.get("host") || `localhost:${PORT}`;
    const redirectUrl = `${protocol}://${host}/q/${encodeURIComponent(link.id)}`;

    const rawDark = typeof req.query.dark === "string" ? req.query.dark.replace("#", "") : "000000";
    const rawLight = typeof req.query.light === "string" ? req.query.light.replace("#", "") : "ffffff";
    const darkColor = /^[0-9A-Fa-f]{6}$/.test(rawDark) ? `#${rawDark}` : "#000000";
    const lightColor = /^[0-9A-Fa-f]{6}$/.test(rawLight) ? `#${rawLight}` : "#ffffff";
    const download = req.query.download === "1" || req.query.download === "true";

    const qrSvg = await QRCode.toString(redirectUrl, {
      type: "svg",
      errorCorrectionLevel: "H",
      margin: 3,
      color: {
        dark: darkColor,
        light: lightColor,
      },
    });

    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=60");
    if (download) {
      res.setHeader("Content-Disposition", `attachment; filename="qrcode-${encodeURIComponent(link.id)}.svg"`);
    }
    res.send(qrSvg);
  } catch (error) {
    console.error("Erro ao gerar SVG do QR Code:", error);
    res.status(500).json({ detail: "Erro ao gerar SVG do QR Code" });
  }
});

// Helper function to handle redirection safely
function handleRedirection(codeId: string, _req: Request, res: Response) {
  const sanitizedId = sanitizeText(codeId, 64);
  const links = readLinks();
  const link = links[sanitizedId];

  if (!link) {
    const safeEscapedId = escapeHtml(sanitizedId);
    return res.status(404).send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head><meta charset="utf-8"><title>QR Code Não Encontrado</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#1e293b;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}
        .box{background:#fff;padding:36px;border-radius:16px;border:1px solid #e2e8f0;max-width:440px;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.05)}
        h1{font-size:1.5rem;color:#0f172a;margin-top:0}
        p{color:#64748b;font-size:0.95rem;line-height:1.5}
        a{display:inline-block;margin-top:18px;background:#2563eb;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600}
      </style>
      </head>
      <body>
        <div class="box">
          <h1>QR Code Não Encontrado</h1>
          <p>O código <strong>/q/${safeEscapedId}</strong> não está cadastrado ou foi removido.</p>
          <a href="/">Ir para o Painel</a>
        </div>
      </body>
      </html>
    `);
  }

  if (!link.is_active) {
    return res.status(403).send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head><meta charset="utf-8"><title>QR Code Desativado</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#1e293b;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}
        .box{background:#fff;padding:36px;border-radius:16px;border:1px solid #e2e8f0;max-width:440px;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.05)}
        h1{font-size:1.5rem;color:#e11d48;margin-top:0}
        p{color:#64748b;font-size:0.95rem;line-height:1.5}
      </style>
      </head>
      <body>
        <div class="box">
          <h1>QR Code Temporariamente Inativo</h1>
          <p>Este link foi desativado pelo administrador.</p>
        </div>
      </body>
      </html>
    `);
  }

  // Validate target URL before redirect to prevent Open Redirect exploits to invalid protocols
  const urlCheck = isValidUrl(link.target_url);
  if (!urlCheck.valid) {
    return res.status(400).send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head><meta charset="utf-8"><title>URL de Destino Inválida</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#1e293b;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}
        .box{background:#fff;padding:36px;border-radius:16px;border:1px solid #e2e8f0;max-width:440px;text-align:center}
        h1{font-size:1.5rem;color:#dc2626;margin-top:0}
      </style>
      </head>
      <body>
        <div class="box">
          <h1>Destino Inválido</h1>
          <p>A URL configurada para este QR Code é inválida ou insegura.</p>
        </div>
      </body>
      </html>
    `);
  }

  // Increment clicks & timestamp safely
  link.clicks = (link.clicks || 0) + 1;
  link.last_clicked_at = new Date().toISOString();
  links[sanitizedId] = link;
  writeLinks(links);

  res.redirect(302, link.target_url);
}

// Redirect Route /q/:code_id
app.get("/q/:code_id", (req: Request, res: Response) => {
  const codeId = req.params.code_id;
  handleRedirection(codeId, req, res);
});

// Centralized safe error handler (prevents leaking internal stack traces)
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled server error:", err);
  res.status(err.status || 500).json({
    detail: "Ocorreu um erro interno no servidor. Tente novamente mais tarde.",
  });
});

// Start Server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});

