import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import { apiIdempotencyKeys, chatMessages, chats } from "@orchestrat/db";
import { eq } from "drizzle-orm";
import { AttachmentService } from "../services/attachment-service.js";
import { workspace } from "../test/workspace.js";

const key = () => ({ "idempotency-key": randomUUID() });

async function twoBranches() {
  const space = await workspace();
  const feature = (
    await space.alice("POST", `/projects/${space.project.id}/branches`, {
      name: "feat/content"
    })
  ).json().branch;
  return {
    ...space,
    main: space.project.default_branch_id as string,
    feature: feature.id as string
  };
}

type Space = Awaited<ReturnType<typeof twoBranches>>;

const createDocument = async (s: Space, path: string, branchId?: string) => {
  const response = await s.alice(
    "POST",
    `/projects/${s.project.id}/documents${branchId ? `?branch_id=${branchId}` : ""}`,
    { path, content: `# ${path}` }
  );
  assert.equal(response.statusCode, 201, response.body);
  return response.json().document as { id: string; branch_id: string };
};

const directChat = async (s: Space, branchId?: string) =>
  s.alice(
    "POST",
    `/projects/${s.project.id}/chats${branchId ? `?branch_id=${branchId}` : ""}`,
    { kind: "direct", participants: [{ type: "human", id: s.bobUser.id }] },
    key()
  );

test("documents and folders live on one branch", async (t) => {
  const s = await twoBranches();
  t.after(() => s.app.close());
  const onMain = await createDocument(s, "docs/plan.md");
  const onFeature = await createDocument(s, "docs/plan.md", s.feature);
  assert.equal(onMain.branch_id, s.main);
  assert.equal(onFeature.branch_id, s.feature, "paths are unique per branch");
  const duplicate = await s.alice(
    "POST",
    `/projects/${s.project.id}/documents`,
    { path: "docs/plan.md", content: "again" }
  );
  assert.equal(duplicate.statusCode, 409);

  const folder = await s.alice(
    "POST",
    `/projects/${s.project.id}/document-folders?branch_id=${s.feature}`,
    { path: "notes" }
  );
  assert.equal(folder.statusCode, 201, folder.body);
  assert.equal(folder.json().folder.branch_id, s.feature);
  const listed = async (query: string) =>
    (
      await s.alice("GET", `/projects/${s.project.id}/documents${query}`)
    ).json();
  const main = await listed("");
  assert.deepEqual(
    main.documents.map((document: { id: string }) => document.id),
    [onMain.id]
  );
  assert.deepEqual(main.folders, []);
  const feature = await listed(`?branch_id=${s.feature}`);
  assert.deepEqual(
    feature.documents.map((document: { id: string }) => document.id),
    [onFeature.id]
  );
  assert.deepEqual(
    feature.folders.map((value: { path: string }) => value.path),
    ["notes"]
  );
});

test("agents write documents on their branch only", async (t) => {
  const s = await twoBranches();
  t.after(() => s.app.close());
  const { call } = await s.createAgent("codex");
  const session = (
    await call("POST", "/sessions", {
      runtime: "codex",
      integration: "codex",
      branch_id: s.feature
    })
  ).json().session;
  const pinned = { "x-orchestrat-session-id": session.id };
  const created = await call(
    "POST",
    "/documents",
    { path: "agent.md", content: "from the agent" },
    pinned
  );
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().document.branch_id, s.feature);
  const listed = await call("GET", "/documents", undefined, pinned);
  assert.equal(listed.json().documents.length, 1);

  const mainDocument = await createDocument(s, "main.md");
  const read = await call(
    "GET",
    `/documents/${mainDocument.id}`,
    undefined,
    pinned
  );
  assert.equal(read.statusCode, 200, "reads across branches are allowed");
  const write = await call(
    "PATCH",
    `/documents/${mainDocument.id}`,
    { content: "changed", base_revision: 1 },
    pinned
  );
  assert.equal(write.statusCode, 409);
  assert.equal(write.json().error.code, "BRANCH_MISMATCH");
  const rename = await call(
    "PATCH",
    `/documents/${mainDocument.id}/path`,
    { path: "moved.md", expected_revision: 1 },
    pinned
  );
  assert.equal(rename.json().error.code, "BRANCH_MISMATCH");
  const legacy = await call("PATCH", `/documents/${mainDocument.id}`, {
    content: "old client",
    base_revision: 1
  });
  assert.equal(legacy.statusCode, 200, "old clients send no branch");
});

test("archived branches freeze documents and attachments", async (t) => {
  const s = await twoBranches();
  t.after(() => s.app.close());
  const frozen = await createDocument(s, "frozen.md", s.feature);
  const live = await createDocument(s, "live.md");
  await s.alice(
    "POST",
    `/projects/${s.project.id}/branches/${s.feature}/archive`,
    {}
  );
  const edit = await s.alice("PATCH", `/documents/${frozen.id}`, {
    content: "late",
    base_revision: 1
  });
  assert.equal(edit.statusCode, 409);
  assert.equal(edit.json().error.code, "CONFLICT");
  assert.equal(edit.json().error.details.reason, "branch_archived");
  for (const action of ["archive", "restore"])
    assert.equal(
      (await s.alice("POST", `/documents/${frozen.id}/${action}`, {}))
        .statusCode,
      409,
      action
    );
  const create = await s.alice(
    "POST",
    `/projects/${s.project.id}/documents?branch_id=${s.feature}`,
    { path: "late.md", content: "late" }
  );
  assert.equal(create.json().error.code, "BRANCH_ARCHIVED");
  assert.equal(
    (await s.alice("GET", `/documents/${frozen.id}`)).statusCode,
    200,
    "archived documents stay readable"
  );

  const config = {
    endpoint: "https://storage.example.test",
    region: "auto",
    accessKeyId: "test",
    secretAccessKey: "test",
    bucket: "attachments"
  };
  const attachments = new AttachmentService(s.db, {
    ...config,
    client: new S3Client({
      forcePathStyle: true,
      region: config.region,
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      }
    })
  });
  const upload = {
    filename: "a.txt",
    content_type: "text/plain",
    size_bytes: 3
  };
  await assert.rejects(
    attachments.create(s.aliceUser.id, frozen.id, upload),
    (error: { code?: string; details?: { reason?: string } }) =>
      error.code === "CONFLICT" && error.details?.reason === "branch_archived"
  );
  const started = await attachments.create(s.aliceUser.id, live.id, upload);
  assert.equal(started.upload.status, "pending");
});

test("direct messages are per branch", async (t) => {
  const s = await twoBranches();
  t.after(() => s.app.close());
  const main = await directChat(s);
  assert.equal(main.statusCode, 201, main.body);
  assert.equal(main.json().branch_id, s.main);
  const feature = await directChat(s, s.feature);
  assert.equal(feature.statusCode, 201, "a branch gets its own DM");
  assert.notEqual(feature.json().id, main.json().id);
  const again = await directChat(s);
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().id, main.json().id);
  const ids = async (query: string) =>
    (await s.bob("GET", `/projects/${s.project.id}/chats${query}`))
      .json()
      .chats.map((chat: { id: string }) => chat.id);
  assert.deepEqual(await ids(""), [main.json().id]);
  assert.deepEqual(await ids(`?branch_id=${s.feature}`), [feature.json().id]);
});

test("messages only reference documents on the chat's branch", async (t) => {
  const s = await twoBranches();
  t.after(() => s.app.close());
  const chat = (await directChat(s)).json();
  const mainDocument = await createDocument(s, "main.md");
  const featureDocument = await createDocument(s, "feature.md", s.feature);
  const crossed = await s.alice(
    "POST",
    `/chats/${chat.id}/messages`,
    { body_markdown: "see this", document_ids: [featureDocument.id] },
    key()
  );
  assert.equal(crossed.statusCode, 400);
  assert.equal(crossed.json().error.details.reason, "cross_branch");
  const sent = await s.alice(
    "POST",
    `/chats/${chat.id}/messages`,
    { body_markdown: "see this", document_ids: [mainDocument.id] },
    key()
  );
  assert.equal(sent.statusCode, 201, sent.body);
  assert.equal(sent.json().branch_id, s.main);
  assert.deepEqual(sent.json().documents, [
    { id: mainDocument.id, path: "main.md" }
  ]);
});

test("the inbox is per branch and never counts imported messages", async (t) => {
  const s = await twoBranches();
  t.after(() => s.app.close());
  const mainChat = (await directChat(s)).json();
  const featureChat = (await directChat(s, s.feature)).json();
  for (const chat of [mainChat, featureChat])
    assert.equal(
      (
        await s.bob(
          "POST",
          `/chats/${chat.id}/messages`,
          { body_markdown: "ping" },
          key()
        )
      ).statusCode,
      201
    );
  const inbox = async (query: string) =>
    (await s.alice("GET", `/projects/${s.project.id}/inbox${query}`)).json()
      .unread_chats;
  assert.deepEqual(
    (await inbox("")).map((chat: { chat_id: string }) => chat.chat_id),
    [mainChat.id]
  );
  assert.deepEqual(
    (await inbox(`?branch_id=${s.feature}`)).map(
      (chat: { chat_id: string }) => chat.chat_id
    ),
    [featureChat.id]
  );
  const everywhere = await inbox("?all_branches=true");
  assert.deepEqual(
    everywhere
      .map((chat: { chat_id: string; branch_id: string }) => [
        chat.chat_id,
        chat.branch_id
      ])
      .sort(),
    [
      [mainChat.id, s.main],
      [featureChat.id, s.feature]
    ].sort()
  );

  // A message a merge copied in is history, not news.
  const [row] = await s.db
    .select()
    .from(chats)
    .where(eq(chats.id, mainChat.id));
  await s.db.insert(chatMessages).values({
    projectId: s.project.id,
    branchId: s.main,
    chatId: mainChat.id,
    sequence: row!.lastSequence + 1,
    authorType: "human",
    authorUserId: s.bobUser.id,
    authorName: "Bob",
    bodyMarkdown: "imported",
    importedAt: new Date()
  });
  await s.db
    .update(chats)
    .set({ lastSequence: row!.lastSequence + 1 })
    .where(eq(chats.id, mainChat.id));
  assert.equal((await inbox(""))[0].unread_count, 1);
  const detail = (await s.alice("GET", `/chats/${mainChat.id}`)).json();
  assert.equal(detail.unread_count, 1);
  const unread = (
    await s.alice("GET", `/chats/${mainChat.id}/messages?unread_only=true`)
  ).json().messages;
  assert.deepEqual(
    unread.map((message: { body_markdown: string }) => message.body_markdown),
    ["ping"]
  );
});

test("create_chat replays keys cached against the project", async (t) => {
  const s = await twoBranches();
  t.after(() => s.app.close());
  const headers = { "idempotency-key": "legacy-chat" };
  const body = {
    kind: "group",
    name: "Crew",
    participants: [{ type: "human", id: s.bobUser.id }]
  };
  const first = await s.alice(
    "POST",
    `/projects/${s.project.id}/chats`,
    body,
    headers
  );
  assert.equal(first.statusCode, 201, first.body);
  await s.db
    .update(apiIdempotencyKeys)
    .set({ resourceId: s.project.id })
    .where(eq(apiIdempotencyKeys.idempotencyKey, "legacy-chat"));
  const replay = await s.alice(
    "POST",
    `/projects/${s.project.id}/chats`,
    body,
    headers
  );
  assert.equal(replay.statusCode, 201);
  assert.equal(replay.json().id, first.json().id);
  const onFeature = await s.alice(
    "POST",
    `/projects/${s.project.id}/chats?branch_id=${s.feature}`,
    body,
    headers
  );
  assert.equal(onFeature.statusCode, 201);
  assert.notEqual(onFeature.json().id, first.json().id, "keys are per branch");
});

test("agent chats and human handoffs follow the branch", async (t) => {
  const s = await twoBranches();
  t.after(() => s.app.close());
  const { agent, call } = await s.createAgent("codex");
  const group = await call(
    "POST",
    "/chats",
    {
      kind: "group",
      name: "Feature crew",
      participants: [{ type: "human", id: s.aliceUser.id }]
    },
    { "x-orchestrat-branch-id": s.feature, ...key() }
  );
  assert.equal(group.statusCode, 201, group.body);
  assert.equal(group.json().branch_id, s.feature);
  assert.equal((await call("GET", "/chats")).json().chats.length, 0);

  const task = (
    await s.alice(
      "POST",
      `/projects/${s.project.id}/tasks?branch_id=${s.feature}`,
      { title: "Hand me off" },
      key()
    )
  ).json();
  const handoff = await s.alice(
    "POST",
    `/projects/${s.project.id}/handoffs?branch_id=${s.feature}`,
    {
      to: { type: "agent", id: agent.id },
      body_markdown: "Your turn",
      task_id: task.id
    },
    key()
  );
  assert.equal(handoff.statusCode, 201, handoff.body);
  const dm = (
    await s.alice("GET", `/chats/${handoff.json().handoff.chat_id}`)
  ).json();
  assert.equal(dm.branch_id, s.feature);
  const wrongBranch = await s.alice(
    "POST",
    `/projects/${s.project.id}/handoffs`,
    {
      to: { type: "agent", id: agent.id },
      body_markdown: "Your turn",
      task_id: task.id
    },
    key()
  );
  assert.equal(wrongBranch.statusCode, 400);
  assert.equal(wrongBranch.json().error.details.reason, "cross_branch");
});
