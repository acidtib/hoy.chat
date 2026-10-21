// HOY-369: web_fetch and web_search, shipped with Hoy and working with no key
// or account. Search goes to Exa's public MCP endpoint (free, keyless) and falls
// back to Bing's results page when Exa fails. Both tools are read-only.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import TurndownService from "turndown";
import { Type } from "typebox";

export const WEB_TOOLS = ["web_fetch", "web_search"];

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Hoy/1.0";
const FETCH_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_S = 120;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
// What goes back to the model; the rest is cut with a note.
const MAX_OUTPUT_CHARS = 100_000;
const SEARCH_TIMEOUT_MS = 20_000;
const EXA_ENDPOINT = "https://mcp.exa.ai/mcp";
const SNIPPET_CHARS = 700;

export type FetchFormat = "markdown" | "text" | "html";

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  published?: string;
}

function textResult(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function timeoutSignal(ms: number, outer?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return outer ? AbortSignal.any([outer, t]) : t;
}

export function htmlToMarkdown(html: string): string {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  td.remove(["script", "style", "noscript", "iframe", "svg", "canvas", "form", "nav", "footer", "aside"] as any);
  return td.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function cap(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[Truncated: showed ${MAX_OUTPUT_CHARS} of ${text.length} characters.]`;
}

function isTextual(mime: string): boolean {
  return (
    !mime ||
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime.endsWith("+json") ||
    mime === "application/xml" ||
    mime.endsWith("+xml") ||
    mime === "application/javascript"
  );
}

async function readBounded(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error(`Response too large (over ${MAX_BODY_BYTES / 1024 / 1024} MB).`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function webFetch(
  url: string,
  format: FetchFormat = "markdown",
  timeoutS?: number,
  signal?: AbortSignal,
): Promise<{ text: string; contentType: string; finalUrl: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("URL must use http:// or https://.");
  }
  const ms = Math.min(Math.max(timeoutS ?? FETCH_TIMEOUT_MS / 1000, 1), MAX_TIMEOUT_S) * 1000;
  const res = await fetch(parsed, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: format === "html" ? "text/html,*/*;q=0.8" : "text/markdown,text/plain;q=0.9,text/html;q=0.8,*/*;q=0.5",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
    signal: timeoutSignal(ms, signal),
  });
  if (res.headers.get("cf-mitigated") === "challenge") {
    throw new Error(
      `${parsed.host} answered with a bot challenge that a plain fetch cannot pass. Try the site's API or raw source instead (for example registry.npmjs.org or raw.githubusercontent.com).`,
    );
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${parsed.href}`);
  const contentType = res.headers.get("content-type") ?? "";
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (!isTextual(mime)) throw new Error(`Unsupported content type: ${mime}. web_fetch reads text, HTML, JSON and XML.`);
  const body = await readBounded(res);
  const isHtml = mime === "text/html" || mime === "application/xhtml+xml";
  const text = !isHtml || format === "html" ? body : format === "text" ? htmlToText(body) : htmlToMarkdown(body);
  return { text: cap(text), contentType: mime, finalUrl: res.url || parsed.href };
}

// Exa's MCP text: blocks separated by "\n\n---\n\n", each with Title/URL/Published
// header lines and a Highlights or Text body.
export function parseExaResults(text: string): SearchResult[] {
  return text.split(/\n\n---\n\n/).flatMap((block) => {
    const url = block.match(/^URL:\s*(.+)$/m)?.[1]?.trim();
    if (!url) return [];
    const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
    const published = block.match(/^Published:\s*(.+)$/m)?.[1]?.trim();
    const body = block.match(/^(?:Highlights|Text):\s*\n?([\s\S]*)$/m)?.[1]?.trim();
    return [
      {
        url,
        title: title && title !== "N/A" ? title : url,
        ...(body ? { snippet: body.replace(/\s+/g, " ").slice(0, SNIPPET_CHARS) } : {}),
        ...(published && published !== "N/A" ? { published } : {}),
      },
    ];
  });
}

async function searchExa(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch(EXA_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "web_search_exa", arguments: { query, numResults: count } },
    }),
    signal: timeoutSignal(SEARCH_TIMEOUT_MS, signal),
  });
  if (!res.ok) throw new Error(`Exa HTTP ${res.status}`);
  const raw = await res.text();
  // The endpoint answers as one server-sent event or as plain JSON.
  const json = raw.includes("data:") ? raw.split("\n").find((l) => l.startsWith("data:"))?.slice(5) : raw;
  const msg = JSON.parse(json ?? "{}");
  if (msg.error) throw new Error(`Exa: ${msg.error.message ?? "error"}`);
  const text: string | undefined = msg.result?.content?.find((c: any) => c?.type === "text")?.text;
  return text ? parseExaResults(text).slice(0, count) : [];
}

// Bing result links are redirects carrying the target as "a1" + base64url in `u`.
function bingTarget(href: string): string {
  const u = decodeEntities(href).match(/[?&]u=a1([^&]+)/)?.[1];
  if (!u) return decodeEntities(href);
  try {
    return Buffer.from(u.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return decodeEntities(href);
  }
}

export function parseBingResults(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  for (const li of html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? []) {
    const a = li.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const snippet = li.match(/<p[^>]*>([\s\S]*?)<\/p>/)?.[1];
    out.push({
      url: bingTarget(a[1]),
      title: htmlToText(a[2]),
      ...(snippet ? { snippet: htmlToText(snippet).slice(0, SNIPPET_CHARS) } : {}),
    });
  }
  return out;
}

async function searchBing(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en&count=${count}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
    signal: timeoutSignal(SEARCH_TIMEOUT_MS, signal),
  });
  if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
  return parseBingResults(await res.text()).slice(0, count);
}

export async function webSearch(
  query: string,
  count = 8,
  signal?: AbortSignal,
): Promise<{ results: SearchResult[]; source: "exa" | "bing" }> {
  const n = Math.min(Math.max(Math.round(count), 1), 20);
  let exaError: unknown;
  try {
    const results = await searchExa(query, n, signal);
    if (results.length > 0) return { results, source: "exa" };
  } catch (e) {
    if (signal?.aborted) throw e;
    exaError = e;
  }
  try {
    return { results: await searchBing(query, n, signal), source: "bing" };
  } catch (e) {
    throw new Error(`Web search failed: ${exaError ? `${exaError}; ` : ""}${e}`);
  }
}

export function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `No results for "${query}".`;
  return results
    .map((r, i) =>
      [`${i + 1}. ${r.title}`, `   ${r.url}`, r.published ? `   Published: ${r.published}` : "", r.snippet ? `   ${r.snippet}` : ""]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

export function createHoyWeb() {
  return function hoyWeb(pi: ExtensionAPI) {
    pi.registerTool({
      name: "web_fetch",
      label: "Web Fetch",
      description:
        "Fetch an http(s) URL and return its content: HTML converted to markdown by default, or plain text, or the raw HTML. Read-only. Use it for documentation pages, READMEs, changelogs, API references, and raw files.",
      promptSnippet: "web_fetch (read a web page as markdown)",
      parameters: Type.Object({
        url: Type.String({ description: "The http or https URL to fetch." }),
        format: Type.Optional(
          Type.Union([Type.Literal("markdown"), Type.Literal("text"), Type.Literal("html")], {
            description: "markdown (default), text, or html.",
          }),
        ),
        timeout: Type.Optional(Type.Number({ description: `Timeout in seconds, up to ${MAX_TIMEOUT_S}. Default 30.` })),
      }),
      execute: async (_id, params, signal) => {
        const r = await webFetch(params.url, (params.format as FetchFormat) ?? "markdown", params.timeout, signal);
        return textResult(r.text || "(empty response)", { url: r.finalUrl, contentType: r.contentType });
      },
    });

    pi.registerTool({
      name: "web_search",
      label: "Web Search",
      description:
        "Search the web and return titles, URLs, and snippets. Read-only. Use it to find current documentation, release notes, issues, and error messages, then read the best results with web_fetch.",
      promptSnippet: "web_search (search the web)",
      parameters: Type.Object({
        query: Type.String({ description: "The search query." }),
        count: Type.Optional(Type.Number({ description: "How many results, 1 to 20. Default 8." })),
      }),
      execute: async (_id, params, signal) => {
        const { results, source } = await webSearch(params.query, params.count ?? 8, signal);
        return textResult(formatResults(params.query, results), { source, count: results.length });
      },
    });
  };
}
