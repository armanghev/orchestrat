import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const apiRequire = createRequire(
  new URL("../../api/package.json", import.meta.url)
);
const {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} = apiRequire("@aws-sdk/client-s3") as typeof import("@aws-sdk/client-s3");
const { getSignedUrl } = apiRequire(
  "@aws-sdk/s3-request-presigner"
) as typeof import("@aws-sdk/s3-request-presigner");

const ids = {
  organization: "00000000-0000-4000-8000-000000000001",
  project: "00000000-0000-4000-8000-000000000004",
  user: "00000000-0000-4000-8000-000000000006",
  document: "00000000-0000-4000-8000-000000000007",
  revision: "00000000-0000-4000-8000-000000000008"
} as const;
const now = "2026-09-06T00:00:00.000Z";

function storageEnvironment() {
  const values = new Map<string, string>();
  for (const line of readFileSync(
    new URL("../../../.worktrees/realtime-documents-storage/.env", import.meta.url),
    "utf8"
  ).split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  const required = (name: string) => {
    const value = values.get(name);
    if (!value) throw new Error(`Missing ${name} in the R2 test environment.`);
    return value;
  };
  return {
    bucket: required("DOCUMENT_STORAGE_BUCKET"),
    endpoint: required("DOCUMENT_STORAGE_S3_ENDPOINT"),
    region: required("DOCUMENT_STORAGE_S3_REGION"),
    credentials: {
      accessKeyId: required("DOCUMENT_STORAGE_S3_ACCESS_KEY_ID"),
      secretAccessKey: required("DOCUMENT_STORAGE_S3_SECRET_ACCESS_KEY")
    }
  };
}

async function seed(page: Page) {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("orchestrat.e2e.auth", "signedIn");
  });
}

async function mockDocuments(
  page: Page,
  initialContent = "# Shared plan\n\n- [x] Existing work\n\n| Owner | Status |\n| --- | --- |\n| Human | Ready |",
  history: Array<{ revision_number: number; content: string }> = []
) {
  let content = initialContent;
  let revision = history[0]?.revision_number ?? 1;
  let savedBody: { content: string; base_revision: number } | null = null;
  const project = {
    id: ids.project,
    organization_id: ids.organization,
    name: "Alpha",
    slug: "alpha",
    description: null,
    status: "active",
    created_at: now,
    updated_at: now,
    archived_at: null
  };
  const document = () => ({
    id: ids.document,
    project_id: ids.project,
    path: "README.md",
    current_revision: revision,
    archived_at: null,
    created_by: { type: "human", id: ids.user },
    created_at: now,
    updated_at: now
  });
  const detail = () => ({
    document: document(),
    revision: {
      id: ids.revision,
      document_id: ids.document,
      revision_number: revision,
      content,
      author: { type: "human", id: ids.user },
      created_at: now
    }
  });
  await page.route("https://api.orchestrat.test/api/v1/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    const method = route.request().method();
    if (pathname === "/api/v1/organizations")
      return route.fulfill({
        json: {
          organizations: [
            {
              id: ids.organization,
              name: "Acme",
              slug: "acme",
              role: "owner",
              created_at: now,
              updated_at: now
            }
          ]
        }
      });
    if (pathname.endsWith("/projects"))
      return route.fulfill({ json: { projects: [project] } });
    if (pathname === `/api/v1/projects/${ids.project}`)
      return route.fulfill({ json: project });
    if (pathname === "/api/v1/profile")
      return route.fulfill({
        json: {
          user_id: ids.user,
          provider: "github",
          username: "e2e_user",
          full_name: "E2E User",
          email: "e2e@example.com",
          avatar_url: null
        }
      });
    if (pathname === `/api/v1/projects/${ids.project}/presence`)
      return route.fulfill({ json: { agents: [] } });
    if (pathname === "/api/v1/realtime/tickets")
      return route.fulfill({
        json: { ticket: "e2e-realtime-ticket", expires_at: now }
      });
    if (pathname === `/api/v1/projects/${ids.project}/documents`)
      return route.fulfill({
        json: { documents: [document()], next_cursor: null }
      });
    if (pathname === `/api/v1/documents/${ids.document}/revisions`) {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      const revisions = history.length
        ? cursor
          ? history.slice(4)
          : history.slice(0, 4)
        : [{ revision_number: revision, content }];
      return route.fulfill({
        json: {
          revisions: revisions.map((item) => ({
            ...detail().revision,
            id: `${ids.revision.slice(0, -1)}${item.revision_number}`,
            revision_number: item.revision_number,
            content_size_bytes: item.content.length,
            content_sha256: "a".repeat(64)
          })),
          next_cursor: history.length > 4 && !cursor ? "older" : null
        }
      });
    }
    const revisionMatch = pathname.match(
      new RegExp(`^/api/v1/documents/${ids.document}/revisions/(\\d+)$`)
    );
    if (revisionMatch) {
      const revisionNumber = Number(revisionMatch[1]);
      const item = history.find(
        (candidate) => candidate.revision_number === revisionNumber
      );
      return item
        ? route.fulfill({
            json: {
              revision: {
                ...detail().revision,
                id: `${ids.revision.slice(0, -1)}${revisionNumber}`,
                revision_number: revisionNumber,
                content: item.content
              }
            }
          })
        : route.fulfill({ status: 404 });
    }
    if (pathname === `/api/v1/documents/${ids.document}/attachments`)
      return route.fulfill({ json: { attachments: [] } });
    if (pathname === `/api/v1/documents/${ids.document}` && method === "GET")
      return route.fulfill({ json: detail() });
    if (pathname === `/api/v1/documents/${ids.document}` && method === "PATCH") {
      savedBody = route.request().postDataJSON() as typeof savedBody;
      content = savedBody!.content;
      revision += 1;
      return route.fulfill({ json: detail() });
    }
    return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND" } } });
  });
  return { getSavedBody: () => savedBody };
}

test("MDXEditor edits rich text, exposes source, and saves Markdown", async ({
  page
}, testInfo) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await seed(page);
  const state = await mockDocuments(page);
  await page.goto(`/projects/${ids.project}/documents`);

  await expect(page.getByRole("heading", { name: "Shared plan" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Preview|Editing)$/ })).toHaveCount(0);
  await expect(page.getByText("Human", { exact: true })).toHaveCSS("margin-top", "0px");
  if (testInfo.project.name === "macos-default")
    await page.screenshot({
      path: "/private/tmp/orchestrat-mvp-editor.png",
      fullPage: true
    });
  await expect(page.getByRole("radio", { name: "Source mode" })).toBeVisible();
  await page.getByRole("radio", { name: "Source mode" }).click();

  const source = page.locator(".cm-content");
  await expect(source).toContainText("# Shared plan");
  await source.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
  await page.keyboard.type("\n\n## Browser edit");
  await page.getByRole("button", { name: "Save now" }).click();

  await expect.poll(() => state.getSavedBody()).not.toBeNull();
  expect(state.getSavedBody()).toMatchObject({ base_revision: 1 });
  expect(state.getSavedBody()!.content).toContain("## Browser edit");
  await expect(page.getByRole("status")).toContainText("Saved revision 2");
  expect(consoleErrors).toEqual([]);
});

test("document history compares saved revisions and keeps the draft", async ({
  page
}, testInfo) => {
  const current = "# Roadmap\n\nCurrent saved direction.\n\nShared line";
  const revisions = [
    { revision_number: 6, content: current },
    { revision_number: 5, content: "# Roadmap\n\nPrevious direction.\n\nShared line" },
    { revision_number: 4, content: "# Roadmap\n\nRetired direction.\n\nShared line" },
    { revision_number: 3, content: "# Roadmap\n\nThird direction." },
    { revision_number: 2, content: "# Roadmap\n\nOlder direction." },
    { revision_number: 1, content: "# Roadmap\n\nFirst direction." }
  ];
  await seed(page);
  await mockDocuments(page, current, revisions);
  await page.route(
    `https://api.orchestrat.test/api/v1/documents/${ids.document}`,
    (route) =>
      route.request().method() === "PATCH"
        ? new Promise<void>(() => undefined)
        : route.fallback()
  );
  await page.goto(`/projects/${ids.project}/documents`);
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Revision 5\b/ })).toHaveCount(0);

  await page.getByRole("radio", { name: "Source mode" }).click();
  const editor = page.locator(".mdxeditor-source-editor .cm-content");
  await editor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
  await page.keyboard.type("\n\nUnsaved browser draft.");
  await page.getByRole("button", { name: "History" }).click();

  const dialog = page.getByRole("dialog", { name: "Document history" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Unsaved draft changes are excluded");
  await expect(page.getByRole("button", { name: /^Revision 5\b/ })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByRole("button", { name: /^Revision 6\b/ })).toBeDisabled();
  const comparison = page.getByRole("textbox", { name: "Revision comparison" });
  await expect(comparison).toHaveAttribute("contenteditable", "false");
  await expect(comparison).toContainText("Previous direction.");
  await expect(comparison).toContainText("Current saved direction.");

  await page.getByRole("button", { name: /^Revision 4\b/ }).click();
  await expect(comparison).toContainText("Retired direction.");
  await page.getByRole("button", { name: "Load older revisions" }).click();
  await page.getByRole("button", { name: /^Revision 2\b/ }).click();
  await expect(comparison).toContainText("Older direction.");
  for (const theme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.screenshot({
      path: `/private/tmp/orchestrat-document-history-${theme}-${testInfo.project.name}.png`,
      animations: "disabled"
    });
  }
  await page.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect(editor).toContainText("Unsaved browser draft.");
});

test("the rich-text toolbar creates a saved link and preserves an unlabeled code fence", async ({
  page
}) => {
  await seed(page);
  const state = await mockDocuments(
    page,
    "# Link test\n\nCreate a reference.\n\n```\nconst ok = true;\n```"
  );
  await page.goto(`/projects/${ids.project}/documents`);

  const paragraph = page.getByText("Create a reference.", { exact: true });
  await paragraph.click();
  await page.keyboard.press("End");
  await page.getByRole("button", { name: "Create link" }).click();
  const linkDialog = page.getByRole("dialog");
  await linkDialog.locator('input[name="url"]').fill("https://orchestrat.dev/docs");
  await page.getByLabel("Anchor text").fill("Documentation");
  await page.getByRole("button", { name: "Set URL" }).click();
  await page.getByRole("button", { name: "Save now" }).click();

  await expect.poll(() => state.getSavedBody()).not.toBeNull();
  expect(state.getSavedBody()!.content).toContain(
    "[Documentation](https://orchestrat.dev/docs)"
  );
  expect(state.getSavedBody()!.content).toContain("const ok = true;");
  expect(state.getSavedBody()!.content).toMatch(/```(?:text)?\nconst ok = true;\n```/);
});

test("a conversion error preserves source and never autosaves empty content", async ({
  page
}) => {
  await seed(page);
  const state = await mockDocuments(page, "# Agent note\n\n<Unknown value={draft} />");
  await page.goto(`/projects/${ids.project}/documents`);

  await expect(page.getByRole("alert")).toContainText(
    "Markdown could not be rendered"
  );
  await page.getByRole("radio", { name: "Source mode" }).click();
  await expect(page.locator(".cm-content")).toContainText(
    "<Unknown value={draft} />"
  );
  await page.waitForTimeout(1_700);
  expect(state.getSavedBody()).toBeNull();
});

test("document typography and editor menus follow the theme without changing Markdown", async ({
  page
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await seed(page);
  const state = await mockDocuments(page,
    '# Shared plan\n\nCoordinate the next release.\n\n## Next steps\n\n- Review the changes\n\n- [x] Connect an agent\n\n> Keep the team in sync.\n\n```javascript\n// Agent status\nconst status = "Ready for review";\n```'
  );
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`/projects/${ids.project}/documents`);
  const heading = page.getByRole("heading", { name: "Shared plan", exact: true });
  const blockType = page.getByRole("combobox", { name: "Block type", exact: true });

  for (const theme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await heading.click();
    await expect(blockType).toHaveText("Heading 1");
    await page.locator(".mdxeditor").evaluate((element) => element.scrollIntoView({ block: "start" }));
    await blockType.click();
    const menu = page.getByRole("listbox");
    await expect(menu).toBeVisible();
    await page.screenshot({ path: `/private/tmp/orchestrat-editor-${theme}-${testInfo.project.name}.png`, animations: "disabled" });
    const colors = await menu.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        foreground: style.color,
        expectedBackground: style.getPropertyValue("--popover").trim(),
        expectedForeground: style.getPropertyValue("--foreground").trim()
      };
    });
    expect(colors.background).toBe(colors.expectedBackground);
    expect(colors.foreground).toBe(colors.expectedForeground);
    await page.keyboard.press("Escape");
    await expect(heading).toHaveCSS("font-size", "32px");
    await expect(heading).toHaveCSS("font-weight", "600");
    await expect(page.getByRole("heading", { name: "Next steps" })).toHaveCSS("font-size", "24px");
    const background = await page.locator("html").evaluate((element) =>
      getComputedStyle(element).getPropertyValue("--background").trim()
    );
    await expect(page.locator(".cm-editor")).toHaveCSS("background-color", background);
    const keywordColor = await page.locator("html").evaluate((element) =>
      getComputedStyle(element).getPropertyValue("--primary-text").trim()
    );
    await expect(page.locator(".cm-line").getByText("const", { exact: true })).toHaveCSS("color", keywordColor);
    await page.getByRole("radio", { name: "Source mode" }).click();
    await expect(page.locator(".mdxeditor-source-editor .cm-editor")).toHaveCSS("background-color", background);
    await page.getByRole("radio", { name: "Rich text", exact: true }).click();
    expect(state.getSavedBody()).toBeNull();
  }

  await page.getByText("Coordinate the next release.", { exact: true }).click();
  await blockType.click();
  await page.getByRole("option", { name: "Heading 3", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Coordinate the next release.", level: 3 })).toHaveCSS("font-size", "20px");
  await blockType.focus();
  await page.keyboard.press("Tab");
  await expect(page.locator(".orchestrat-markdown-editor :focus")).toHaveCSS("outline-style", "solid");
  await page.getByRole("radio", { name: "Source mode" }).click();
  const source = page.locator(".mdxeditor-source-editor .cm-content");
  await source.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
  await page.keyboard.type("\n\nKeep this draft.");
  const selectionBefore = await source.evaluate(() => window.getSelection()?.anchorOffset);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(source).toBeFocused();
  await expect(source).toContainText("Keep this draft.");
  expect(await source.evaluate(() => window.getSelection()?.anchorOffset)).toBe(selectionBefore);
  await page.screenshot({ path: `/private/tmp/orchestrat-editor-source-${testInfo.project.name}.png`, animations: "disabled" });
  await page.getByRole("button", { name: "Save now" }).click();
  await expect.poll(() => state.getSavedBody()?.content).toContain("### Coordinate the next release.");
  expect(state.getSavedBody()?.content).toContain("Keep this draft.");
  await page.getByRole("radio", { name: "Rich text", exact: true }).click();
  await expect(heading).toHaveCSS("font-size", "32px");
  expect(errors).toEqual([]);
});

test("@r2 browser attachment UI uploads through an actual signed R2 PUT", async ({
  page
}) => {
  test.skip(!process.env.R2_BROWSER_E2E, "Set R2_BROWSER_E2E=1 to use the test bucket.");
  const config = storageEnvironment();
  expect(config.bucket).toBe("orchestrat-documents");
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    forcePathStyle: true
  });
  const objectKey = `e2e/${crypto.randomUUID()}/${crypto.randomUUID()}/browser-upload.txt`;
  const bytes = Buffer.from(`orchestrat-r2-browser-${crypto.randomUUID()}`);
  const uploadId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  try {
    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: config.bucket, Key: objectKey }),
      { expiresIn: 300 }
    );
    await seed(page);
    await mockDocuments(page);
    let completed = false;
    const attachment = {
      id: attachmentId,
      document_id: ids.document,
      filename: "browser-upload.txt",
      content_type: "text/plain",
      size_bytes: bytes.length,
      created_at: now
    };
    await page.route(
      `https://api.orchestrat.test/api/v1/documents/${ids.document}/attachments**`,
      async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (route.request().method() === "GET")
          return route.fulfill({
            json: { attachments: completed ? [attachment] : [] }
          });
        if (path.endsWith("/uploads"))
          return route.fulfill({
            json: {
              upload: {
                id: uploadId,
                mode: "single",
                upload_url: uploadUrl,
                expires_at: new Date(Date.now() + 300_000).toISOString()
              }
            }
          });
        if (path.endsWith(`/${uploadId}/complete`)) {
          completed = true;
          return route.fulfill({ json: { attachment } });
        }
        return route.fulfill({ status: 404 });
      }
    );
    await page.goto(`/projects/${ids.project}/documents`);
    await page.getByRole("button", { name: "Choose File" }).setInputFiles({
      name: "browser-upload.txt",
      mimeType: "text/plain",
      buffer: bytes
    });
    await page.getByRole("button", { name: "Add attachment" }).click();
    await expect.poll(() => completed).toBe(true);

    const stored = await client.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: objectKey })
    );
    expect(Buffer.from(await stored.Body!.transformToByteArray())).toEqual(bytes);
    expect(consoleErrors).toEqual([]);
  } finally {
    await client.send(
      new DeleteObjectCommand({ Bucket: config.bucket, Key: objectKey })
    );
    client.destroy();
  }
});
