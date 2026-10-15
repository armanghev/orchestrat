import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  branchItemBaselines,
  branchMergeDecisions,
  chatMessages,
  chatParticipants,
  chats,
  documentAttachments,
  documentFolders,
  documentRevisions,
  documents,
  projectEvents
} from "@orchestrat/db";
import { asc, eq } from "drizzle-orm";
import { workspace } from "../test/workspace.js";
import { AgentService } from "./agent-service.js";
import { BranchService } from "./branch-service.js";
import {
  MergeEngine,
  type AttachmentKey,
  type AttachmentObjects
} from "./merges/engine.js";

const key = () => ({ "idempotency-key": randomUUID() });

async function setup() {
  const s = await workspace();
  const copies: { from: AttachmentKey; to: AttachmentKey }[] = [];
  const objects: AttachmentObjects = {
    copy: async (from, to) => {
      copies.push({ from, to });
    },
    remove: async () => undefined
  };
  const engine = new MergeEngine(
    s.db,
    new BranchService(s.db, new AgentService(s.db)),
    objects
  );
  const feature = (
    await s.alice("POST", `/projects/${s.project.id}/branches`, {
      name: "feat/content"
    })
  ).json().branch.id as string;
  const main = s.project.default_branch_id as string;
  const on = (branchId: string) =>
    branchId === main ? "" : `?branch_id=${branchId}`;
  const document = async (path: string, content: string, branchId = main) => {
    const created = await s.alice(
      "POST",
      `/projects/${s.project.id}/documents${on(branchId)}`,
      { path, content }
    );
    assert.equal(created.statusCode, 201, created.body);
    return created.json().document as { id: string };
  };
  const row = async (id: string) =>
    (await s.db.select().from(documents).where(eq(documents.id, id)))[0]!;
  const write = async (id: string, content: string) => {
    const response = await s.alice("PATCH", `/documents/${id}`, {
      content,
      base_revision: (await row(id)).currentRevision
    });
    assert.equal(response.statusCode, 200, response.body);
  };
  const rename = async (id: string, path: string) => {
    const response = await s.alice("PATCH", `/documents/${id}/path`, {
      path,
      expected_revision: (await row(id)).currentRevision
    });
    assert.equal(response.statusCode, 200, response.body);
  };
  const attach = async (documentId: string, filename: string) => {
    const document = await row(documentId);
    const [attachment] = await s.db
      .insert(documentAttachments)
      .values({
        projectId: s.project.id,
        branchId: document.branchId,
        documentId,
        filename,
        mimeType: "image/png",
        sizeBytes: 3,
        addedByType: "human",
        addedByUserId: s.aliceUser.id
      })
      .returning();
    return attachment!;
  };
  const docsOn = (branchId: string) =>
    s.db
      .select()
      .from(documents)
      .where(eq(documents.branchId, branchId))
      .orderBy(asc(documents.path));
  const copyOf = async (lineage: string, branchId: string) =>
    (await docsOn(branchId)).find(
      (doc) => (doc.originId ?? doc.id) === lineage
    );
  const chat = async (
    body: object,
    branchId = main,
    as: typeof s.alice = s.alice
  ) => {
    const created = await as(
      "POST",
      `/projects/${s.project.id}/chats${on(branchId)}`,
      body,
      key()
    );
    assert.ok([200, 201].includes(created.statusCode), created.body);
    return created.json() as { id: string };
  };
  const send = async (
    chatId: string,
    text: string,
    extra: object = {},
    as: typeof s.alice = s.alice
  ) => {
    const sent = await as(
      "POST",
      `/chats/${chatId}/messages`,
      { body_markdown: text, ...extra },
      key()
    );
    assert.equal(sent.statusCode, 201, sent.body);
    return sent.json();
  };
  const messagesOf = (chatId: string) =>
    s.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.chatId, chatId))
      .orderBy(asc(chatMessages.sequence));
  const chatsOn = (branchId: string) =>
    s.db.select().from(chats).where(eq(chats.branchId, branchId));
  const merge = (source: string, target: string) =>
    engine.apply(s.project.id, {
      sourceBranchId: source,
      targetBranchId: target,
      kind: "merge",
      trigger: "dashboard",
      userId: s.aliceUser.id
    });
  const importAll = (source: string, target: string) =>
    engine.apply(s.project.id, {
      sourceBranchId: source,
      targetBranchId: target,
      kind: "import",
      selection: { tasks: "all", documents: "all", chats: "all" },
      trigger: "dashboard",
      userId: s.aliceUser.id
    });
  return {
    ...s,
    engine,
    copies,
    main,
    feature,
    document,
    row,
    write,
    rename,
    attach,
    docsOn,
    copyOf,
    chat,
    send,
    messagesOf,
    chatsOn,
    merge,
    importAll
  };
}

test("documents copy with every revision, their attachments and folders", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  await s.alice("POST", `/projects/${s.project.id}/document-folders`, {
    path: "notes"
  });
  const plan = await s.document("notes/plan.md", "v1");
  const image = await s.attach(plan.id, "diagram.png");
  await s.write(plan.id, `v2 ![diagram](orchestrat-attachment:${image.id})`);

  const run = (await s.importAll(s.main, s.feature)).body.run;
  assert.equal(run.counts["document.copy"], 1);
  assert.equal(run.counts["document_attachment.copy"], 1);
  const copy = (await s.copyOf(plan.id, s.feature))!;
  assert.equal(copy.path, "notes/plan.md");
  assert.equal(copy.currentRevision, 2);
  const [attachment] = await s.db
    .select()
    .from(documentAttachments)
    .where(eq(documentAttachments.documentId, copy.id));
  assert.equal(attachment!.originId, image.id);
  assert.notEqual(attachment!.id, image.id, "copies get new ids");
  assert.deepEqual(s.copies, [
    {
      from: {
        projectId: s.project.id,
        documentId: plan.id,
        attachmentId: image.id
      },
      to: {
        projectId: s.project.id,
        documentId: copy.id,
        attachmentId: attachment!.id
      }
    }
  ]);
  const history = await s.db
    .select()
    .from(documentRevisions)
    .where(eq(documentRevisions.documentId, copy.id))
    .orderBy(asc(documentRevisions.revisionNumber));
  assert.deepEqual(
    history.map((revision) => [
      revision.revisionNumber,
      revision.contentMarkdown
    ]),
    [
      [1, "v1"],
      [2, `v2 ![diagram](orchestrat-attachment:${attachment!.id})`]
    ],
    "references point at the target's attachment"
  );
  assert.ok(history.every((revision) => revision.contentSha256 === null));
  assert.equal(history[0]!.authorUserId, s.aliceUser.id);
  const folders = await s.db
    .select()
    .from(documentFolders)
    .where(eq(documentFolders.branchId, s.feature));
  assert.deepEqual(
    folders.map((folder) => folder.path),
    ["notes"]
  );

  // Rewritten references are not a change: merging back finds nothing.
  const back = await s.engine.preview(s.project.id, {
    sourceBranchId: s.feature,
    targetBranchId: s.main,
    kind: "merge"
  });
  assert.deepEqual(
    back.items.map((item) => item.outcome),
    ["unchanged"]
  );
});

test("attachment copies respect a configured project quota", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const plan = await s.document("plan.md", "v1");
  await s.attach(plan.id, "diagram.png"); // 3 bytes
  const engine = (quota: number) =>
    new MergeEngine(
      s.db,
      new BranchService(s.db, new AgentService(s.db)),
      { copy: async () => undefined, remove: async () => undefined },
      quota
    );
  const run = (quota: number) =>
    engine(quota).apply(s.project.id, {
      sourceBranchId: s.main,
      targetBranchId: s.feature,
      kind: "import",
      selection: { tasks: "all", documents: "all", chats: "all" },
      trigger: "dashboard",
      userId: s.aliceUser.id
    });
  await assert.rejects(
    run(5),
    (error: { code?: string }) => error.code === "ATTACHMENT_QUOTA_EXCEEDED"
  );
  assert.equal((await run(6)).body.run.counts["document_attachment.copy"], 1);
});

test("body, path and archive changes apply; a taken path is never overwritten", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const edited = await s.document("edited.md", "before");
  const moved = await s.document("moved.md", "content");
  const shelved = await s.document("shelved.md", "content");
  const clash = await s.document("clash.md", "content");
  await s.merge(s.main, s.feature);
  const featureEdited = (await s.copyOf(edited.id, s.feature))!;

  await s.write(edited.id, "after");
  await s.rename(moved.id, "renamed.md");
  await s.alice("POST", `/documents/${shelved.id}/archive`, {});
  await s.document("taken.md", "theirs", s.feature);
  await s.rename(clash.id, "taken.md");
  const run = (await s.merge(s.main, s.feature)).body.run;

  const revisions = await s.db
    .select()
    .from(documentRevisions)
    .where(eq(documentRevisions.documentId, featureEdited.id))
    .orderBy(asc(documentRevisions.revisionNumber));
  assert.deepEqual(
    revisions.map((revision) => revision.contentMarkdown),
    ["before", "after"],
    "one new revision, history kept"
  );
  const [mainRevision] = await s.db
    .select()
    .from(documentRevisions)
    .where(eq(documentRevisions.documentId, edited.id))
    .orderBy(asc(documentRevisions.revisionNumber))
    .offset(1);
  assert.equal(revisions[1]!.originId, mainRevision!.id);
  assert.equal((await s.copyOf(moved.id, s.feature))!.path, "renamed.md");
  assert.ok((await s.copyOf(shelved.id, s.feature))!.archivedAt);
  assert.equal(
    (await s.copyOf(clash.id, s.feature))!.path,
    "clash.md",
    "the target keeps its path"
  );
  assert.equal(run.decision_count, 1);
  const [decision] = await s.db.select().from(branchMergeDecisions);
  assert.equal(decision!.reason, "path_collision");
  assert.equal(decision!.itemType, "document");
});

test("the same path added on both sides is one logical document", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  await s.document("same.md", "identical");
  await s.document("same.md", "identical", s.feature);
  await s.document("differs.md", "main's");
  await s.document("differs.md", "feature's", s.feature);
  const run = (await s.merge(s.main, s.feature)).body.run;
  assert.equal(run.counts["document.unchanged"], 1);
  assert.equal(run.counts["document.conflict"], 1);
  assert.equal((await s.docsOn(s.feature)).length, 2, "nothing duplicated");
  const [decision] = await s.db.select().from(branchMergeDecisions);
  assert.equal(decision!.reason, "added_on_both");
  const baselines = await s.db
    .select()
    .from(branchItemBaselines)
    .where(eq(branchItemBaselines.itemType, "document"));
  assert.equal(baselines.length, 1, "the agreement is remembered");
});

test("chats copy verbatim and nobody has unread imported history", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const { agent } = await s.createAgent("codex");
  const crew = await s.chat({
    kind: "group",
    name: "Crew",
    participants: [
      { type: "human", id: s.bobUser.id },
      { type: "agent", id: agent.id }
    ]
  });
  await s.send(crew.id, "one");
  await s.send(crew.id, "two");
  await s.merge(s.main, s.feature);

  const [copy] = await s.chatsOn(s.feature);
  assert.equal(copy!.name, "Crew");
  assert.equal(copy!.hasHuman, true);
  assert.equal(copy!.originId, crew.id);
  const participants = await s.db
    .select()
    .from(chatParticipants)
    .where(eq(chatParticipants.chatId, copy!.id));
  assert.equal(participants.length, 3);
  assert.ok(participants.every((row) => row.lastReadSequence === 2));
  const messages = await s.messagesOf(copy!.id);
  assert.deepEqual(
    messages.map((row) => [
      row.sequence,
      row.bodyMarkdown,
      Boolean(row.importedAt)
    ]),
    [
      [1, "one", true],
      [2, "two", true]
    ]
  );
  const inbox = (
    await s.bob("GET", `/projects/${s.project.id}/inbox?branch_id=${s.feature}`)
  ).json();
  assert.deepEqual(inbox.unread_chats, []);
  const events = await s.db
    .select()
    .from(projectEvents)
    .where(eq(projectEvents.branchId, s.feature));
  assert.deepEqual(
    events.map((event) => event.type),
    ["merge.merge_applied"],
    "no chat events or notices"
  );
});

test("direct messages match by their pair and gain the missing messages", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const dm = {
    kind: "direct",
    participants: [{ type: "human", id: s.bobUser.id }]
  };
  const onMain = await s.chat(dm);
  const onFeature = await s.chat(dm, s.feature);
  await s.send(onFeature.id, "from the feature");
  await s.send(onMain.id, "from main");
  await s.merge(s.main, s.feature);
  assert.equal((await s.chatsOn(s.feature)).length, 1);
  assert.deepEqual(
    (await s.messagesOf(onFeature.id)).map((row) => [
      row.sequence,
      row.bodyMarkdown,
      Boolean(row.importedAt)
    ]),
    [
      [1, "from the feature", false],
      [2, "from main", true]
    ]
  );
  await s.merge(s.main, s.feature);
  assert.equal((await s.messagesOf(onFeature.id)).length, 2, "appended once");
});

test("appending never widens who can read a group", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const { agent } = await s.createAgent("codex");
  const group = await s.chat({
    kind: "group",
    name: "Private",
    participants: [{ type: "human", id: s.bobUser.id }]
  });
  await s.merge(s.main, s.feature);
  const [copy] = await s.chatsOn(s.feature);
  await s.alice("POST", `/chats/${copy!.id}/members`, {
    action: "add",
    participant: { type: "agent", id: agent.id }
  });
  await s.send(group.id, "for bob only");
  const run = (await s.merge(s.main, s.feature)).body.run;
  assert.deepEqual(run.skipped, [
    {
      item_type: "chat",
      lineage_key: group.id,
      label: "Private",
      reason: "audience_would_widen"
    }
  ]);
  assert.equal((await s.messagesOf(copy!.id)).length, 0);

  // A wider source is fine: the target's readers all saw it already.
  await s.alice("POST", `/chats/${group.id}/members`, {
    action: "add",
    participant: { type: "agent", id: agent.id }
  });
  await s.merge(s.main, s.feature);
  assert.deepEqual(
    (await s.messagesOf(copy!.id)).map((row) => row.bodyMarkdown),
    ["for bob only"]
  );
});

test("chat names follow the three-way rule and refs follow documents", async (t) => {
  const s = await setup();
  t.after(() => s.app.close());
  const spec = await s.document("spec.md", "spec");
  const group = await s.chat({
    kind: "group",
    name: "Team",
    participants: [{ type: "human", id: s.bobUser.id }]
  });
  await s.send(group.id, "see the spec", { document_ids: [spec.id] });
  await s.merge(s.main, s.feature);
  const featureSpec = (await s.copyOf(spec.id, s.feature))!;
  const [copy] = await s.chatsOn(s.feature);
  const [message] = await s.messagesOf(copy!.id);
  assert.deepEqual(message!.documentRefs, [
    { id: featureSpec.id, path: "spec.md" }
  ]);

  await s.db
    .update(chats)
    .set({ name: "Team renamed" })
    .where(eq(chats.id, group.id));
  await s.merge(s.main, s.feature);
  assert.equal((await s.chatsOn(s.feature))[0]!.name, "Team renamed");
  await s.db
    .update(chats)
    .set({ name: "Main name" })
    .where(eq(chats.id, group.id));
  await s.db
    .update(chats)
    .set({ name: "Feature name" })
    .where(eq(chats.id, copy!.id));
  const run = (await s.merge(s.main, s.feature)).body.run;
  assert.equal(run.decision_count, 1);
  assert.equal((await s.chatsOn(s.feature))[0]!.name, "Feature name");
});
