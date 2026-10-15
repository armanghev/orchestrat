import assert from "node:assert/strict";
import test from "node:test";

// Run against a production build: next start --port 8840, then pnpm test:seo.
const base = process.env.SEO_TEST_BASE_URL ?? "http://localhost:8840";
const origin = "https://orchestrat.dev";
const paths = [
  "",
  "/about",
  "/faq",
  "/guides",
  "/guides/coordinate-multiple-coding-agents",
  "/guides/mcp-agent-coordination",
  "/guides/shared-context-for-coding-agents",
  "/terms",
  "/privacy",
  ...[
    "",
    "/quickstart",
    "/configuration",
    "/users",
    "/storage",
    "/git-providers",
    "/connect-agents",
    "/upgrades",
    "/https",
    "/architecture",
    "/api",
    "/contributing"
  ].map((page) => `/docs${page}`)
];

test("public pages, crawl files, structured data, and real 404 responses", async () => {
  const titles = new Set<string>();
  for (const path of paths) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
    // The legal name appears once, in the footer's license line; copy uses the handle.
    assert.equal(
      (markup.match(/Arman Ghevondyan/g) ?? []).length,
      1,
      `${path}: public handle`
    );
    assert.match(
      markup,
      /© \d{4} Arman Ghevondyan ·/,
      `${path}: footer license line`
    );
    assert.match(
      markup,
      /<a[^>]*href="https:\/\/x\.com\/armanghev"[^>]*>@armanghev<\/a>/,
      `${path}: linked profile`
    );
    assert.doesNotMatch(
      markup.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, "").replace(/<[^>]*>/g, ""),
      /@armanghev/,
      `${path}: no unlinked visible mentions`
    );
    const title = markup.match(/<title>(.*?)<\/title>/)?.[1];
    assert.ok(title, `${path}: title`);
    assert.ok(!titles.has(title), `${path}: distinct title`);
    titles.add(title);
    assert.equal(
      (markup.match(/<h1[\s>]/g) ?? []).length,
      1,
      `${path}: one h1`
    );
    assert.equal(
      (markup.match(/rel="canonical"/g) ?? []).length,
      1,
      `${path}: one canonical`
    );
    assert.ok(
      markup.includes(`rel="canonical" href="${origin}${path}"`),
      `${path}: canonical`
    );
    assert.ok(
      markup.includes(`property="og:url" content="${origin}${path}"`),
      `${path}: social URL`
    );
    assert.ok(
      markup.includes(`property="og:title" content="${title}"`),
      `${path}: OG title`
    );
    assert.ok(
      markup.includes(`name="twitter:title" content="${title}"`),
      `${path}: Twitter title`
    );
    assert.ok(
      !/<meta[^>]+name="robots"[^>]+noindex/.test(markup),
      `${path}: indexable`
    );
    const graphs = [
      ...html.matchAll(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g
      )
    ].map((match) => JSON.parse(match[1]));
    if (!["/terms", "/privacy"].includes(path)) {
      assert.ok(graphs.length, `${path}: structured data`);
      for (const graph of graphs)
        assert.equal(graph["@context"], "https://schema.org");
    }
    if (path === "") {
      for (const text of [
        "Keep plans and decisions in versioned Markdown",
        "See who is working",
        "orchestrat mcp --integration codex",
        "arman@orchestrat.dev",
        'href="/docs/quickstart"',
        'href="https://github.com/armanghev/orchestrat"',
        'href="/privacy#cookies"'
      ]) {
        assert.ok(markup.includes(text), `homepage HTML: ${text}`);
      }
      assert.deepEqual(
        graphs[0]["@graph"].map(
          (node: Record<string, unknown>) => node["@type"]
        ),
        ["Organization", "WebSite", "SoftwareApplication"]
      );
      assert.ok(
        !graphs[0]["@graph"][2].offers,
        "no invented price or preorder offer"
      );
      assert.deepEqual(graphs[0]["@graph"][0].founder, {
        "@type": "Person",
        name: "@armanghev",
        url: "https://x.com/armanghev"
      });
    }
    if (path === "/faq") {
      const faq = graphs[0]["@graph"].find(
        (node: Record<string, unknown>) => node["@type"] === "FAQPage"
      );
      assert.equal(faq.mainEntity.length, 8);
      for (const question of faq.mainEntity)
        assert.ok(
          markup.includes(question.name),
          "FAQ schema matches visible questions"
        );
    }
    if (path === "/privacy") {
      assert.ok(markup.includes('id="cookies"'), "linked cookie information");
      assert.ok(markup.includes("October 14, 2026"), "current policy date");
      assert.doesNotMatch(
        markup,
        /waitlist|Supabase|Neon|Resend|Cloudflare R2/
      );
      assert.ok(
        !markup.includes("feature-interest buttons"),
        "no stale form disclosure"
      );
    }
    if (path.startsWith("/guides/")) {
      const article = graphs[0]["@graph"].find(
        (node: Record<string, unknown>) => node["@type"] === "Article"
      );
      assert.equal(article.mainEntityOfPage, `${origin}${path}`);
      assert.ok(
        markup.toLowerCase().includes(`datetime="${article.datePublished}"`),
        "visible publication date"
      );
    }
  }

  for (const path of [
    "/missing-seo-check",
    "/guides/missing-seo-check",
    "/docs/missing-seo-check"
  ]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
    const html = (await response.text()).replace(
      /<script\b[^>]*>[\s\S]*?<\/script>/gi,
      ""
    );
    assert.ok(
      html.includes("This page is off the board."),
      `${path}: custom page`
    );
    assert.ok(
      html.includes("Page not found | Orchestrat"),
      `${path}: custom title`
    );
    assert.match(html, /<meta[^>]+name="robots"[^>]+noindex/);
    assert.doesNotMatch(html, /rel="canonical"|property="og:|name="twitter:/);
  }

  const robots = await fetch(`${base}/robots.txt`);
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get("content-type") ?? "", /text\/plain/);
  const rules = await robots.text();
  for (const line of [
    "User-Agent: *",
    "Allow: /",
    "Disallow: /api/",
    `Sitemap: ${origin}/sitemap.xml`
  ])
    assert.ok(rules.includes(line), line);
  const sitemap = await fetch(`${base}/sitemap.xml`);
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get("content-type") ?? "", /xml/);
  const urls = [...(await sitemap.text()).matchAll(/<loc>(.*?)<\/loc>/g)].map(
    (match) => match[1]
  );
  assert.deepEqual(urls.sort(), paths.map((path) => origin + path).sort());

  for (const file of ["llms.txt", "llms-full.txt"]) {
    const response = await fetch(`${base}/${file}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
    const body = await response.text();
    assert.ok(body.startsWith("# Orchestrat"));
    assert.ok(body.includes("[@armanghev](https://x.com/armanghev)"));
    assert.doesNotMatch(body, /Arman Ghevondyan/);
    for (const path of paths.filter((path) => path && path !== "/guides"))
      assert.ok(body.includes(origin + path), `${file}: ${path}`);
    if (file === "llms-full.txt") {
      for (const text of [
        "npx @orchestrat/cli setup --server http://localhost:8801",
        "Draft: this describes v1, which is still being built.",
        "orchestrat mcp --integration codex",
        "Read current state before writing",
        "Elastic License 2.0"
      ])
        assert.ok(body.includes(text), text);
      assert.doesNotMatch(body, /TODO\(verify\)|<Draft|<Callout/);
    }
  }
  const slash = await fetch(`${base}/docs/`, { redirect: "manual" });
  assert.equal(slash.status, 308);
  assert.equal(new URL(slash.headers.get("location")!, base).pathname, "/docs");
  const image = await fetch(`${base}/opengraph-image`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
});
