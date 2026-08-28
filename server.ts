import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import QRCode from "qrcode";

dotenv.config();

const app = express();
const PORT = 3000;
const DATA_FILE = path.resolve(process.env.DATA_FILE || "data/links.json");
const PUBLIC_DIR = path.resolve("public");

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

export interface Link {
  id: string;
  title: string;
  target_url: string;
  tags: string[];
  folder?: string;
  clicks: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  last_clicked_at?: string | null;
}

function isValidUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !!parsed.hostname;
  } catch {
    return false;
  }
}

function isValidSlug(slug: string): boolean {
  return /^[A-Za-z0-9-_]+$/.test(slug);
}

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
  res.json({ status: "ok" });
});

// Legacy redirect
app.get("/ref", (_req: Request, res: Response) => {
  const target = process.env.TARGET_URL || "https://example.com";
  res.redirect(302, target);
});

// Slug suggestion generator (like Short.io spark chips)
app.get("/api/slug-suggestions", (_req: Request, res: Response) => {
  const links = readLinks();
  const suggestions: string[] = [];
  while (suggestions.length < 3) {
    const slug = generateRandomSlug(6);
    if (!links[slug] && !suggestions.includes(slug)) {
      suggestions.push(slug);
    }
  }
  res.json({ suggestions });
});

// Auto-fetch title from destination URL
app.get("/api/fetch-title", async (req: Request, res: Response) => {
  const target = req.query.url;
  if (!target || typeof target !== "string" || !isValidUrl(target)) {
    return res.status(400).json({ error: "URL inválida" });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    const response = await fetch(target, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return res.json({ title: "" });
    }

    const html = await response.text();
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : "";
    res.json({ title });
  } catch {
    res.json({ title: "" });
  }
});

// List all links (supports search and tag filters)
app.get("/api/links", (req: Request, res: Response) => {
  const links = Object.values(readLinks());
  const search = typeof req.query.search === "string" ? req.query.search.toLowerCase().trim() : "";
  const tagFilter = typeof req.query.tag === "string" ? req.query.tag.toLowerCase().trim() : "";
  const folderFilter = typeof req.query.folder === "string" ? req.query.folder.trim() : "";

  let filtered = links;

  if (search) {
    filtered = filtered.filter((l) =>
      l.title.toLowerCase().includes(search) ||
      l.id.toLowerCase().includes(search) ||
      l.target_url.toLowerCase().includes(search) ||
      l.tags.some((t) => t.toLowerCase().includes(search))
    );
  }

  if (tagFilter) {
    filtered = filtered.filter((l) =>
      l.tags.some((t) => t.toLowerCase() === tagFilter)
    );
  }

  if (folderFilter && folderFilter !== "All") {
    filtered = filtered.filter((l) => (l.folder || "None") === folderFilter);
  }

  // Sort newest first
  filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  res.json(filtered);
});

// Create link
app.post("/api/links", (req: Request, res: Response) => {
  const { title, target_url, slug, tags, folder } = req.body || {};

  if (!target_url || typeof target_url !== "string" || !isValidUrl(target_url)) {
    return res.status(422).json({ detail: "A URL original deve começar com http:// ou https://" });
  }

  if (slug && (typeof slug !== "string" || !isValidSlug(slug))) {
    return res.status(422).json({ detail: "O slug deve conter apenas letras, números, hífens ou underscores" });
  }

  const links = readLinks();
  let codeId = (slug && typeof slug === "string") ? slug.trim() : generateRandomSlug(6);

  if (slug && links[codeId]) {
    return res.status(400).json({ detail: `O slug '${codeId}' já está em uso. Escolha outro.` });
  }

  while (links[codeId]) {
    codeId = generateRandomSlug(6);
  }

  const now = new Date().toISOString();
  let linkTitle = (typeof title === "string" && title.trim()) ? title.trim().slice(0, 200) : "";

  if (!linkTitle) {
    try {
      const parsed = new URL(target_url);
      linkTitle = parsed.hostname + (parsed.pathname.length > 1 ? parsed.pathname : "");
    } catch {
      linkTitle = "Novo QR Code";
    }
  }

  const parsedTags: string[] = Array.isArray(tags)
    ? tags.map((t: any) => String(t).trim()).filter(Boolean)
    : [];

  const newLink: Link = {
    id: codeId,
    title: linkTitle,
    target_url: target_url.trim(),
    tags: parsedTags,
    folder: folder && typeof folder === "string" ? folder.trim() : "None",
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
app.get("/api/links/:code_id", (req: Request, res: Response) => {
  const codeId = req.params.code_id;
  const link = findLink(codeId);
  if (!link) {
    return res.status(404).json({ detail: "QR Code não encontrado" });
  }
  res.json(link);
});

// Update link (Destino, Título, Tags, Pasta, Slug)
app.put("/api/links/:code_id", (req: Request, res: Response) => {
  const oldCodeId = req.params.code_id;
  const { title, target_url, new_slug, tags, folder, is_active } = req.body || {};

  if (!target_url || typeof target_url !== "string" || !isValidUrl(target_url)) {
    return res.status(422).json({ detail: "A URL original deve começar com http:// ou https://" });
  }

  const links = readLinks();
  const link = links[oldCodeId];
  if (!link) {
    return res.status(404).json({ detail: "QR Code não encontrado" });
  }

  let finalCodeId = oldCodeId;
  if (new_slug && typeof new_slug === "string" && new_slug.trim() !== oldCodeId) {
    const trimmedSlug = new_slug.trim();
    if (!isValidSlug(trimmedSlug)) {
      return res.status(422).json({ detail: "O novo slug contém caracteres inválidos." });
    }
    if (links[trimmedSlug]) {
      return res.status(400).json({ detail: `O slug '${trimmedSlug}' já está em uso.` });
    }
    finalCodeId = trimmedSlug;
  }

  const now = new Date().toISOString();
  const linkTitle = (typeof title === "string" && title.trim()) ? title.trim().slice(0, 200) : link.title;
  const parsedTags = Array.isArray(tags)
    ? tags.map((t: any) => String(t).trim()).filter(Boolean)
    : link.tags;

  const updatedLink: Link = {
    ...link,
    id: finalCodeId,
    title: linkTitle,
    target_url: target_url.trim(),
    tags: parsedTags,
    folder: folder !== undefined ? String(folder).trim() : link.folder,
    is_active: typeof is_active === "boolean" ? is_active : link.is_active,
    updated_at: now,
  };

  if (finalCodeId !== oldCodeId) {
    delete links[oldCodeId];
  }
  links[finalCodeId] = updatedLink;
  writeLinks(links);

  res.json(updatedLink);
});

// Toggle link active status
app.patch("/api/links/:code_id/toggle-status", (req: Request, res: Response) => {
  const codeId = req.params.code_id;
  const links = readLinks();
  const link = links[codeId];
  if (!link) {
    return res.status(404).json({ detail: "QR Code não encontrado" });
  }

  link.is_active = !link.is_active;
  link.updated_at = new Date().toISOString();
  links[codeId] = link;
  writeLinks(links);

  res.json(link);
});

// Delete link
app.delete("/api/links/:code_id", (req: Request, res: Response) => {
  const codeId = req.params.code_id;
  const links = readLinks();
  if (!links[codeId]) {
    return res.status(404).json({ detail: "QR Code não encontrado" });
  }

  delete links[codeId];
  writeLinks(links);
  res.json({ message: "Link excluído com sucesso", id: codeId });
});

// QR Code image generator (PNG)
app.get(["/q/:code_id/qr", "/api/links/:code_id/qr.png"], async (req: Request, res: Response) => {
  const codeId = req.params.code_id;
  const link = findLink(codeId);
  if (!link) {
    return res.status(404).json({ detail: "QR Code não encontrado" });
  }

  try {
    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const host = req.headers["x-forwarded-host"] || req.get("host") || `localhost:${PORT}`;
    const redirectUrl = `${protocol}://${host}/q/${encodeURIComponent(link.id)}`;

    const darkColor = typeof req.query.dark === "string" ? `#${req.query.dark.replace("#", "")}` : "#000000";
    const lightColor = typeof req.query.light === "string" ? `#${req.query.light.replace("#", "")}` : "#ffffff";
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
    res.setHeader("Cache-Control", "no-cache");
    if (download) {
      res.setHeader("Content-Disposition", `attachment; filename="qrcode-${link.id}.png"`);
    }
    res.send(qrBuffer);
  } catch (error) {
    console.error("Erro ao gerar QR Code:", error);
    res.status(500).json({ detail: "Erro ao gerar imagem do QR Code" });
  }
});

// QR Code SVG generator
app.get("/api/links/:code_id/qr.svg", async (req: Request, res: Response) => {
  const codeId = req.params.code_id;
  const link = findLink(codeId);
  if (!link) {
    return res.status(404).json({ detail: "QR Code não encontrado" });
  }

  try {
    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const host = req.headers["x-forwarded-host"] || req.get("host") || `localhost:${PORT}`;
    const redirectUrl = `${protocol}://${host}/q/${encodeURIComponent(link.id)}`;

    const darkColor = typeof req.query.dark === "string" ? `#${req.query.dark.replace("#", "")}` : "#000000";
    const lightColor = typeof req.query.light === "string" ? `#${req.query.light.replace("#", "")}` : "#ffffff";
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
    res.setHeader("Cache-Control", "no-cache");
    if (download) {
      res.setHeader("Content-Disposition", `attachment; filename="qrcode-${link.id}.svg"`);
    }
    res.send(qrSvg);
  } catch (error) {
    console.error("Erro ao gerar SVG do QR Code:", error);
    res.status(500).json({ detail: "Erro ao gerar SVG do QR Code" });
  }
});

// Helper function to handle redirection and click count
function handleRedirection(codeId: string, _req: Request, res: Response) {
  const links = readLinks();
  const link = links[codeId];

  if (!link) {
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
        a{display:inline-block;margin-top:18px;background:#0d9488;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600}
      </style>
      </head>
      <body>
        <div class="box">
          <div style="font-size:48px;margin-bottom:12px">🔍</div>
          <h1>QR Code não encontrado</h1>
          <p>O link ou QR Code <code>/${encodeURIComponent(codeId)}</code> não existe ou foi removido.</p>
          <a href="/">Ir para o Painel</a>
        </div>
      </body>
      </html>
    `);
  }

  if (link.is_active === false) {
    return res.status(403).send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head><meta charset="utf-8"><title>Link Pausado</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>
        body{font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#1e293b;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}
        .box{background:#fff;padding:36px;border-radius:16px;border:1px solid #e2e8f0;max-width:440px;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.05)}
        h1{font-size:1.5rem;color:#0f172a;margin-top:0}
        p{color:#64748b;font-size:0.95rem;line-height:1.5}
      </style>
      </head>
      <body>
        <div class="box">
          <div style="font-size:48px;margin-bottom:12px">⏸️</div>
          <h1>QR Code Temporariamente Pausado</h1>
          <p>O administrador pausou os redirecionamentos para este QR Code temporariamente.</p>
        </div>
      </body>
      </html>
    `);
  }

  // Increment clicks and record last access timestamp
  link.clicks = (link.clicks || 0) + 1;
  link.last_clicked_at = new Date().toISOString();
  links[codeId] = link;
  writeLinks(links);

  // 302 Redirect to destination
  res.redirect(302, link.target_url);
}

// Dynamic QR Redirect route with /q/:code_id
app.get("/q/:code_id", (req: Request, res: Response) => {
  handleRedirection(req.params.code_id, req, res);
});

// Dynamic Root Short URL Redirect route /:code_id (excluding reserved endpoints)
const RESERVED_PREFIXES = ["api", "q", "health", "ref", "public", "assets", "favicon.ico", "robots.txt"];
app.get("/:code_id", (req: Request, res: Response, next) => {
  const codeId = req.params.code_id;
  if (RESERVED_PREFIXES.includes(codeId.toLowerCase()) || codeId.includes(".")) {
    return next();
  }
  const link = findLink(codeId);
  if (link) {
    return handleRedirection(codeId, req, res);
  }
  next();
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Dynamic QR Redirect running on http://0.0.0.0:${PORT}`);
});
