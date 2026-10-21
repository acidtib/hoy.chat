import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  formatResults,
  htmlToMarkdown,
  htmlToText,
  parseBingResults,
  parseExaResults,
  webFetch,
} from "./hoy-web";
import { decide } from "./hoy-permissions";

describe("htmlToMarkdown", () => {
  test("keeps content and drops scripts, styles and page chrome", () => {
    const md = htmlToMarkdown(
      `<html><head><style>p{}</style><script>alert(1)</script></head><body><nav>Menu</nav>` +
        `<h1>Title</h1><p>Hello <a href="https://x.dev">link</a></p><pre><code>let a = 1;</code></pre><footer>foot</footer></body></html>`,
    );
    expect(md).toContain("# Title");
    expect(md).toContain("[link](https://x.dev)");
    expect(md).toContain("let a = 1;");
    expect(md).not.toContain("alert");
    expect(md).not.toContain("Menu");
    expect(md).not.toContain("foot");
  });

  test("htmlToText decodes entities and strips tags", () => {
    expect(htmlToText("<p>a &amp; b</p><script>x</script><p>c&#39;d</p>")).toBe("a & b\nc'd");
  });
});

describe("search result parsing", () => {
  test("Exa blocks become results, N/A fields dropped", () => {
    const text =
      "Title: core | Tauri\nURL: https://v2.tauri.app/core\nPublished: N/A\nAuthor: N/A\nHighlights:\nA message channel used to stream values.\n\n---\n\n" +
      "Title: Second\nURL: https://example.com/2\nPublished: 2025-01-02\nText: Body two";
    expect(parseExaResults(text)).toEqual([
      { url: "https://v2.tauri.app/core", title: "core | Tauri", snippet: "A message channel used to stream values." },
      { url: "https://example.com/2", title: "Second", snippet: "Body two", published: "2025-01-02" },
    ]);
  });

  test("Bing results decode the redirect target", () => {
    const target = Buffer.from("https://tauri.app/").toString("base64url");
    const html =
      `<li class="b_algo" data-x="1"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1${target}&amp;ntb=1">Tauri <strong>2.0</strong></a></h2>` +
      `<div><p class="b_lineclamp2">Bring your &amp; web stack.</p></div></li>`;
    expect(parseBingResults(html)).toEqual([
      { url: "https://tauri.app/", title: "Tauri 2.0", snippet: "Bring your & web stack." },
    ]);
  });

  test("formatResults numbers each result and handles none", () => {
    expect(formatResults("q", [])).toBe('No results for "q".');
    expect(formatResults("q", [{ title: "A", url: "https://a" }])).toBe("1. A\n   https://a");
  });
});

describe("webFetch", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/page") return new Response("<h2>Docs</h2><p>Body</p>", { headers: { "content-type": "text/html; charset=utf-8" } });
        if (path === "/json") return Response.json({ ok: true });
        if (path === "/cf") return new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } });
        if (path === "/img") return new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } });
        return new Response("nope", { status: 404 });
      },
    });
    base = `http://localhost:${server.port}`;
  });
  afterAll(() => server.stop(true));

  test("converts HTML to markdown by default, raw HTML on request", async () => {
    expect((await webFetch(`${base}/page`)).text).toBe("## Docs\n\nBody");
    expect((await webFetch(`${base}/page`, "html")).text).toBe("<h2>Docs</h2><p>Body</p>");
  });

  test("passes JSON through", async () => {
    expect((await webFetch(`${base}/json`)).text).toBe('{"ok":true}');
  });

  test("rejects binary content, HTTP errors, and non-http URLs", async () => {
    await expect(webFetch(`${base}/img`)).rejects.toThrow("Unsupported content type");
    await expect(webFetch(`${base}/missing`)).rejects.toThrow("HTTP 404");
    await expect(webFetch(`${base}/cf`)).rejects.toThrow("bot challenge");
    await expect(webFetch("file:///etc/passwd")).rejects.toThrow("http:// or https://");
  });
});

test("the web tools never gate, in any mode", () => {
  for (const mode of ["manual", "acceptEdits", "plan", "autonomous"] as const) {
    expect(decide(mode, "web_fetch")).toBe("allow");
    expect(decide(mode, "web_search")).toBe("allow");
  }
});
