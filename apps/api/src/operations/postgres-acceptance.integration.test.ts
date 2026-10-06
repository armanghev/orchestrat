import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { createDatabase } from "@orchestrat/db";
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  ListObjectsV2Command
} from "@aws-sdk/client-s3";
import { buildApp } from "../app.js";
import { readDocumentStorageConfig } from "../document-storage-config.js";
import { createStorageClient, backfill } from "./storage-operations.js";
import { DocumentService } from "../services/document-service.js";
import { ChatService } from "../services/chat-service.js";

// Opt in with a local/CI PostgreSQL role allowed to create databases. Every run
// creates and drops its own database; never migrates the supplied database.
const postgresUrl = process.env.ORCHESTRAT_TEST_POSTGRES_URL;
const testR2 = process.env.ORCHESTRAT_TEST_R2 === "1";

test(
  "PostgreSQL migrations and concurrent agent/document workflows",
  { skip: !postgresUrl },
  async (t) => {
    const admin = createDatabase({ connectionString: postgresUrl, max: 1 });
    const name = `orchestrat_test_${randomUUID().replaceAll("-", "")}`;
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    const url = new URL(postgresUrl!);
    url.pathname = `/${name}`;
    const { db, pool } = createDatabase({
      connectionString: url.toString(),
      max: 8
    });
    const storageConfig = testR2 ? readDocumentStorageConfig() : undefined;
    if (testR2 && !storageConfig)
      throw new Error(
        "R2 acceptance requires the DOCUMENT_STORAGE_* environment values."
      );
    const storage = storageConfig
      ? createStorageClient(storageConfig)
      : undefined;
    const app = buildApp({
      allowedOrigins: [],
      db,
      documentStorage: storageConfig,
      auth: {
        async authenticate(request) {
          const token = [...(request.headers as Iterable<[string, string]>)]
            .find(([key]) => key.toLowerCase() === "authorization")?.[1]
            ?.replace(/^Bearer\s+/, "");
          if (token !== "alice" && token !== "bob" && token !== "carol")
            return null;
          return {
            authSubject: `postgres-${token}`,
            avatarUrl: null,
            email: `${token}@example.com`,
            name:
              token === "alice" ? "Alice" : token === "bob" ? "Bob" : "Carol",
            provider: "supabase",
            username: token
          };
        }
      }
    });
    try {
      const migrations = new URL(
        "../../../../packages/db/drizzle/",
        import.meta.url
      );
      const files = (await readdir(migrations))
        .filter((file) => file.endsWith(".sql"))
        .sort();
      const legacy = {
        user: randomUUID(),
        admin: randomUUID(),
        member: randomUUID(),
        org: randomUUID(),
        project: randomUUID(),
        task: randomUUID()
      };
      // Rows seeded right before 0016 in every table it moves onto a branch.
      const beforeBranches = {
        blocker: randomUUID(),
        agent: randomUUID(),
        session: randomUUID(),
        document: randomUUID(),
        chat: randomUUID()
      };
      for (const file of files) {
        if (file.startsWith("0011_")) {
          await pool.query(
            "INSERT INTO users (id,auth_subject,auth_provider,name,email) VALUES ($1,'legacy','supabase','Original author','legacy@example.com')",
            [legacy.user]
          );
          await pool.query(
            "INSERT INTO organizations (id,name,slug) VALUES ($1,'Legacy','legacy')",
            [legacy.org]
          );
          await pool.query(
            "INSERT INTO projects (id,organization_id,name,slug) VALUES ($1,$2,'Legacy','legacy')",
            [legacy.project, legacy.org]
          );
          await pool.query(
            "INSERT INTO tasks (id,project_id,task_key,task_number,title,created_by_user_id) VALUES ($1,$2,'PRJ-1',1,'Preserved task',$3)",
            [legacy.task, legacy.project, legacy.user]
          );
          await pool.query(
            "INSERT INTO task_comments (task_id,author_user_id,body_markdown) VALUES ($1,$2,'Preserved comment')",
            [legacy.task, legacy.user]
          );
        }
        if (file.startsWith("0013_")) {
          for (const [id, role] of [
            [legacy.admin, "admin"],
            [legacy.member, "member"]
          ]) {
            await pool.query(
              "INSERT INTO users (id,auth_subject,auth_provider,name,email) VALUES ($1,$2,'supabase',$3,$4)",
              [id, `legacy-${role}`, role, `${role}@legacy.example.com`]
            );
          }
          for (const [userId, role] of [
            [legacy.user, "owner"],
            [legacy.admin, "admin"],
            [legacy.member, "member"]
          ])
            await pool.query(
              "INSERT INTO organization_members (organization_id,user_id,role) VALUES ($1,$2,$3)",
              [legacy.org, userId, role]
            );
        }
        if (file.startsWith("0016_")) {
          const seed = [
            [
              "INSERT INTO tasks (id,project_id,task_key,task_number,title,created_by_type,created_by_user_id) VALUES ($1,$2,'PRJ-2',2,'Blocker','human',$3)",
              [beforeBranches.blocker, legacy.project, legacy.user]
            ],
            [
              "INSERT INTO task_dependencies (project_id,task_id,depends_on_task_id) VALUES ($1,$2,$3)",
              [legacy.project, legacy.task, beforeBranches.blocker]
            ],
            [
              "INSERT INTO agents (id,project_id,name) VALUES ($1,$2,'legacy-agent')",
              [beforeBranches.agent, legacy.project]
            ],
            [
              "INSERT INTO agent_sessions (id,project_id,agent_id,runtime,integration) VALUES ($1,$2,$3,'codex','codex')",
              [beforeBranches.session, legacy.project, beforeBranches.agent]
            ],
            [
              "INSERT INTO task_claims (project_id,task_id,agent_id,session_id,token_hash,lease_expires_at) VALUES ($1,$2,$3,$4,'legacy-claim-hash',now() + interval '5 minutes')",
              [
                legacy.project,
                beforeBranches.blocker,
                beforeBranches.agent,
                beforeBranches.session
              ]
            ],
            [
              "INSERT INTO documents (id,project_id,path) VALUES ($1,$2,'notes/legacy.md')",
              [beforeBranches.document, legacy.project]
            ],
            [
              "INSERT INTO document_revisions (project_id,document_id,revision_number,content_markdown,author_type,author_user_id) VALUES ($1,$2,1,'Legacy body','human',$3)",
              [legacy.project, beforeBranches.document, legacy.user]
            ],
            [
              "INSERT INTO document_folders (project_id,path) VALUES ($1,'notes')",
              [legacy.project]
            ],
            [
              "INSERT INTO document_attachments (project_id,document_id,filename,mime_type,size_bytes,added_by_type,added_by_user_id) VALUES ($1,$2,'a.png','image/png',3,'human',$3)",
              [legacy.project, beforeBranches.document, legacy.user]
            ],
            [
              "INSERT INTO document_attachment_uploads (project_id,document_id,filename,mime_type,reserved_bytes,upload_mode,actor_type,actor_user_id,expires_at) VALUES ($1,$2,'b.png','image/png',3,'single','human',$3,now() + interval '1 hour')",
              [legacy.project, beforeBranches.document, legacy.user]
            ],
            [
              "INSERT INTO chats (id,project_id,kind,name,has_human,creator_type,creator_user_id,last_sequence) VALUES ($1,$2,'group','Legacy chat',true,'human',$3,1)",
              [beforeBranches.chat, legacy.project, legacy.user]
            ],
            [
              "INSERT INTO chat_participants (project_id,chat_id,user_id,last_read_sequence) VALUES ($1,$2,$3,1)",
              [legacy.project, beforeBranches.chat, legacy.user]
            ],
            [
              "INSERT INTO chat_messages (project_id,chat_id,sequence,author_type,author_user_id,author_name,body_markdown) VALUES ($1,$2,1,'human',$3,'Original author','Legacy message')",
              [legacy.project, beforeBranches.chat, legacy.user]
            ],
            [
              "INSERT INTO project_events (project_id,type,entity_id,payload) VALUES ($1,'task.created',$2,'{}'::jsonb),($1,'agent.created',$3,'{}'::jsonb),($1,'credential.issued',$3,'{}'::jsonb)",
              [legacy.project, legacy.task, beforeBranches.agent]
            ]
          ] as const;
          for (const [sql, values] of seed) await pool.query(sql, [...values]);
        }
        await pool.query(await readFile(new URL(file, migrations), "utf8"));
      }
      await t.test(
        "0016 moves every existing row onto one default branch with ids intact",
        async () => {
          const branches = await pool.query(
            "SELECT id,name,is_default,name_source,created_via,onboarding_state,archived_at FROM project_branches WHERE project_id=$1",
            [legacy.project]
          );
          assert.equal(branches.rowCount, 1);
          const [branch] = branches.rows;
          assert.deepEqual(
            { ...branch, id: undefined },
            {
              id: undefined,
              name: "main",
              is_default: true,
              name_source: "fallback",
              created_via: "migration",
              onboarding_state: "completed",
              archived_at: null
            }
          );
          for (const table of [
            "tasks",
            "task_comments",
            "task_dependencies",
            "task_claims",
            "agent_sessions",
            "documents",
            "document_folders",
            "document_revisions",
            "document_attachments",
            "document_attachment_uploads",
            "chats",
            "chat_participants",
            "chat_messages"
          ]) {
            const counts = (
              await pool.query(
                `SELECT count(*)::int AS total, count(*) FILTER (WHERE branch_id = $2)::int AS on_default, count(*) FILTER (WHERE branch_id IS NULL)::int AS missing FROM "${table}" WHERE project_id = $1`,
                [legacy.project, branch.id]
              )
            ).rows[0];
            assert.ok(counts.total > 0, table);
            assert.equal(counts.on_default, counts.total, table);
            assert.equal(counts.missing, 0, table);
          }
          const events = await pool.query(
            "SELECT type, branch_id FROM project_events WHERE project_id=$1 ORDER BY id",
            [legacy.project]
          );
          assert.deepEqual(events.rows, [
            { type: "task.created", branch_id: branch.id },
            { type: "agent.created", branch_id: null },
            { type: "credential.issued", branch_id: null }
          ]);
          const task = (
            await pool.query(
              "SELECT task_key, origin_id FROM tasks WHERE id=$1",
              [legacy.task]
            )
          ).rows[0];
          assert.deepEqual(task, { task_key: "PRJ-1", origin_id: null });
          const chat = (
            await pool.query(
              "SELECT last_read_sequence FROM chat_participants WHERE chat_id=$1",
              [beforeBranches.chat]
            )
          ).rows[0];
          assert.equal(chat.last_read_sequence, 1);
          // The API that is live while the hosted database is migrated never
          // sets branch_id; the 0016 shim puts its rows on the default branch.
          const legacyInsert = await pool.query(
            "INSERT INTO tasks (id,project_id,task_key,task_number,title,created_by_type,created_by_user_id) VALUES ($1,$2,'PRJ-3',3,'Old API task','human',$3) RETURNING branch_id",
            [randomUUID(), legacy.project, legacy.user]
          );
          assert.equal(legacyInsert.rows[0].branch_id, branch.id);
          await assert.rejects(
            pool.query(
              "INSERT INTO project_branches (project_id,name,is_default,name_source,created_via) VALUES ($1,'second-default',true,'user','dashboard')",
              [legacy.project]
            ),
            /project_branches_one_default/
          );
        }
      );
      await t.test(
        "all migrations preserve existing human task/comment authors",
        async () => {
          const task = (
            await pool.query(
              "SELECT created_by_type,created_by_user_id,created_by_agent_id FROM tasks WHERE id=$1",
              [legacy.task]
            )
          ).rows[0];
          assert.deepEqual(task, {
            created_by_type: "human",
            created_by_user_id: legacy.user,
            created_by_agent_id: null
          });
          const comment = (
            await pool.query(
              "SELECT project_id,author_type,author_name FROM task_comments WHERE task_id=$1",
              [legacy.task]
            )
          ).rows[0];
          assert.deepEqual(comment, {
            project_id: legacy.project,
            author_type: "human",
            author_name: "Original author"
          });
          const memberships = await pool.query(
            "SELECT user_id,role FROM project_members WHERE project_id=$1 ORDER BY role",
            [legacy.project]
          );
          assert.deepEqual(memberships.rows, [
            { user_id: legacy.user, role: "owner" },
            { user_id: legacy.admin, role: "admin" },
            { user_id: legacy.member, role: "member" }
          ]);
          const futureMember = randomUUID();
          await pool.query(
            "INSERT INTO users (id,auth_subject,auth_provider,name,email) VALUES ($1,'future-member','supabase','Future','future@example.com')",
            [futureMember]
          );
          await pool.query(
            "INSERT INTO organization_members (organization_id,user_id,role) VALUES ($1,$2,'member')",
            [legacy.org, futureMember]
          );
          const futureProjectMembership = await pool.query(
            "SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2",
            [legacy.project, futureMember]
          );
          assert.equal(futureProjectMembership.rowCount, 0);
        }
      );
      const request = async (
        method: "GET" | "POST" | "PATCH" | "DELETE",
        path: string,
        payload?: object,
        token = "alice",
        key?: string
      ) =>
        app.inject({
          method,
          url: `/api/v1${path}`,
          headers: {
            authorization: `Bearer ${token}`,
            ...(key ? { "idempotency-key": key } : {})
          },
          payload
        });
      const org = (
        await request("POST", "/organizations", { name: "Postgres acceptance" })
      ).json();
      const projectResponse = await request(
        "POST",
        `/organizations/${org.id}/projects`,
        { name: "Primary" }
      );
      assert.equal(projectResponse.statusCode, 201, projectResponse.body);
      const project = projectResponse.json();
      await t.test(
        "concurrent redeemers consume an invitation once",
        async () => {
          const invitation = (
            await request("POST", `/projects/${project.id}/invitations`)
          ).json();
          const replies = await Promise.all(
            ["bob", "carol"].map((token) =>
              request(
                "POST",
                "/project-invitations/accept",
                { token: invitation.token },
                token
              )
            )
          );
          assert.deepEqual(
            replies.map((reply) => reply.statusCode).sort(),
            [200, 409]
          );
          const membership = await pool.query(
            "SELECT count(*)::int AS count FROM project_members pm INNER JOIN users u ON u.id=pm.user_id WHERE pm.project_id=$1 AND u.auth_subject IN ('postgres-bob','postgres-carol')",
            [project.id]
          );
          assert.equal(membership.rows[0]?.count, 1);
        }
      );
      const bob = (
        await pool.query(
          "SELECT id FROM users WHERE auth_subject='postgres-bob' AND auth_provider='supabase'"
        )
      ).rows[0] as { id: string };
      const alice = (
        await pool.query(
          "SELECT id FROM users WHERE auth_subject='postgres-alice' AND auth_provider='supabase'"
        )
      ).rows[0] as { id: string };
      await pool.query(
        "INSERT INTO organization_members (organization_id,user_id,role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING",
        [org.id, bob.id]
      );
      await pool.query(
        "INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING",
        [project.id, bob.id]
      );
      await t.test("PostgreSQL inbox aggregates unread mentions", async () => {
        const created = await request(
          "POST",
          `/projects/${project.id}/chats`,
          {
            kind: "group",
            name: "Inbox aggregate",
            participants: [{ type: "human", id: bob.id }]
          },
          "alice",
          "postgres-inbox-chat"
        );
        assert.equal(created.statusCode, 201, created.body);
        const chat = created.json();
        const sent = await request(
          "POST",
          `/chats/${chat.id}/messages`,
          {
            body_markdown: "Unread mention",
            mentions: [{ type: "human", id: bob.id }]
          },
          "alice",
          "postgres-inbox-mention"
        );
        assert.equal(sent.statusCode, 201, sent.body);
        const ownReply = await request(
          "POST",
          `/chats/${chat.id}/messages`,
          { body_markdown: "Own message" },
          "bob",
          "postgres-inbox-own-message"
        );
        assert.equal(ownReply.statusCode, 201, ownReply.body);
        const inbox = await request(
          "GET",
          `/projects/${project.id}/inbox`,
          undefined,
          "bob"
        );
        assert.equal(inbox.statusCode, 200, inbox.body);
        assert.deepEqual(inbox.json().unread_chats, [
          { chat_id: chat.id, unread_count: 1, mention_count: 1 }
        ]);
      });
      await t.test(
        "chat reads reuse their transaction connection with a one-connection pool",
        async () => {
          const limited = createDatabase({
            connectionString: url.toString(),
            max: 1
          });
          try {
            const chats = new ChatService(limited.db);
            const reads = Promise.all([
              chats.listHuman(alice.id, project.id),
              chats.listHuman(alice.id, project.id)
            ]);
            const result = await Promise.race([
              reads,
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error("chat reads deadlocked")),
                  2_000
                )
              )
            ]);
            assert.equal(result.length, 2);
          } finally {
            await limited.pool.end();
          }
        }
      );
      await pool.query(
        "INSERT INTO organization_members (organization_id,user_id,role) VALUES ($1,$2,'member') ON CONFLICT DO NOTHING",
        [org.id, bob.id]
      );
      const raceProject = (
        await request("POST", `/organizations/${org.id}/projects`, {
          name: "Owner race"
        })
      ).json();
      const addedOwner = await request(
        "POST",
        `/projects/${raceProject.id}/members`,
        { user_id: bob.id, role: "owner" }
      );
      assert.equal(addedOwner.statusCode, 201, addedOwner.body);
      await t.test(
        "last project owner survives concurrent demotion and removal",
        async () => {
          const replies = await Promise.all([
            request(
              "PATCH",
              `/projects/${raceProject.id}/members/${alice.id}`,
              { role: "member" }
            ),
            request(
              "DELETE",
              `/projects/${raceProject.id}/members/${bob.id}`,
              undefined,
              "bob"
            )
          ]);
          assert.deepEqual(
            replies.map((reply) => reply.statusCode).sort(),
            [200, 409]
          );
          const owners = await pool.query(
            "SELECT count(*)::int AS count FROM project_members WHERE project_id=$1 AND role='owner'",
            [raceProject.id]
          );
          assert.equal(owners.rows[0]?.count, 1);
        }
      );
      const other = (
        await request("POST", `/organizations/${org.id}/projects`, {
          name: "Other"
        })
      ).json();
      const workers: Array<{
        agent: { id: string };
        token: string;
        session: { id: string };
      }> = [];
      for (const agentName of ["Builder", "Reviewer"]) {
        const agent = (
          await request("POST", `/projects/${project.id}/agents`, {
            name: agentName
          })
        ).json();
        const { token } = (
          await request(
            "POST",
            `/projects/${project.id}/agents/${agent.id}/credentials`
          )
        ).json();
        const { session } = (
          await request(
            "POST",
            "/agent/sessions",
            { runtime: "test", integration: agentName },
            token
          )
        ).json();
        workers.push({ agent, token, session });
      }
      const [a, b] = workers;
      await t.test(
        "concurrent direct chat creation returns one canonical conversation",
        async () => {
          const createWorker = async (name: string) => {
            const agent = (
              await request("POST", `/projects/${project.id}/agents`, {
                name
              })
            ).json();
            const credential = (
              await request(
                "POST",
                `/projects/${project.id}/agents/${agent.id}/credentials`
              )
            ).json();
            return { agent, token: credential.token as string };
          };
          const [left, right] = await Promise.all([
            createWorker("Concurrent left"),
            createWorker("Concurrent right")
          ]);
          const replies = await Promise.all([
            request(
              "POST",
              "/agent/chats",
              {
                kind: "direct",
                participants: [{ type: "agent", id: right.agent.id }]
              },
              left.token,
              "postgres-concurrent-direct-left"
            ),
            request(
              "POST",
              "/agent/chats",
              {
                kind: "direct",
                participants: [{ type: "agent", id: left.agent.id }]
              },
              right.token,
              "postgres-concurrent-direct-right"
            )
          ]);
          assert.deepEqual(
            replies.map((reply) => reply.statusCode).sort(),
            [200, 201]
          );
          const first = replies[0].json();
          assert.equal(replies[1].json().id, first.id);
          const rows = await pool.query(
            "SELECT count(*)::int AS count FROM chats WHERE project_id=$1 AND id=$2",
            [project.id, first.id]
          );
          assert.equal(rows.rows[0]?.count, 1);
        }
      );
      await t.test(
        "concurrent chat sends stay ordered, retries deduplicate, and reads advance monotonically",
        async () => {
          const created = await request(
            "POST",
            "/agent/chats",
            {
              kind: "direct",
              participants: [{ type: "agent", id: b.agent.id }]
            },
            a.token,
            "postgres-chat-create"
          );
          assert.equal(created.statusCode, 201, created.body);
          const chat = created.json();

          const sent = await Promise.all(
            ["First", "Second"].map((body, index) =>
              request(
                "POST",
                `/agent/chats/${chat.id}/messages`,
                { body_markdown: body },
                a.token,
                `postgres-chat-send-${index}`
              )
            )
          );
          for (const response of sent)
            assert.equal(response.statusCode, 201, response.body);
          assert.deepEqual(
            sent.map((response) => response.json().sequence).sort(),
            [1, 2]
          );

          const retried = await Promise.all(
            [1, 2].map(() =>
              request(
                "POST",
                `/agent/chats/${chat.id}/messages`,
                { body_markdown: "Retried once" },
                a.token,
                "postgres-chat-retry"
              )
            )
          );
          for (const response of retried)
            assert.equal(response.statusCode, 201, response.body);
          assert.equal(retried[0].json().id, retried[1].json().id);
          assert.equal(retried[0].json().sequence, 3);
          const stored = await pool.query(
            "SELECT sequence FROM chat_messages WHERE chat_id=$1 ORDER BY sequence",
            [chat.id]
          );
          assert.deepEqual(stored.rows, [
            { sequence: 1 },
            { sequence: 2 },
            { sequence: 3 }
          ]);

          const newest = retried[0].json().id as string;
          const oldest = sent
            .find((response) => response.json().sequence === 1)!
            .json().id as string;
          const newestAck = await request(
            "POST",
            `/agent/chats/${chat.id}/read`,
            { through_message_id: newest },
            b.token
          );
          assert.equal(newestAck.statusCode, 200, newestAck.body);
          assert.equal(newestAck.json().last_read_sequence, 3);
          const staleAck = await request(
            "POST",
            `/agent/chats/${chat.id}/read`,
            { through_message_id: oldest },
            b.token
          );
          assert.equal(staleAck.statusCode, 200, staleAck.body);
          assert.equal(staleAck.json().last_read_sequence, 3);
        }
      );
      let authored: { id: string };
      await t.test(
        "concurrent retries create one task and one agent comment",
        async () => {
          const replies = await Promise.all(
            [1, 2].map(() =>
              request(
                "POST",
                "/agent/tasks",
                { title: "Follow up", status: "ready" },
                a.token,
                "task-retry"
              )
            )
          );
          for (const reply of replies)
            assert.equal(reply.statusCode, 201, reply.body);
          authored = replies[0].json();
          assert.equal(replies[1].json().id, authored.id);
          const notes = await Promise.all(
            [1, 2].map(() =>
              request(
                "POST",
                `/agent/tasks/${authored.id}/comments`,
                { body_markdown: "Agent progress" },
                a.token,
                "comment-retry"
              )
            )
          );
          for (const note of notes)
            assert.equal(note.statusCode, 201, note.body);
          assert.equal(notes[0].json().id, notes[1].json().id);
          assert.equal(notes[0].json().author.type, "agent");
          const wrong = await request(
            "POST",
            "/agent/tasks",
            { title: "Changed" },
            a.token,
            "task-retry"
          );
          assert.equal(wrong.json().error.code, "IDEMPOTENCY_CONFLICT");
        }
      );
      await t.test(
        "same-version edits produce one winner without losing data",
        async () => {
          const replies = await Promise.all(
            ["Left", "Right"].map((title) =>
              request(
                "PATCH",
                `/agent/tasks/${authored.id}`,
                { title, expected_version: 1 },
                a.token
              )
            )
          );
          assert.deepEqual(
            replies.map((reply) => reply.statusCode).sort(),
            [200, 409]
          );
          assert.equal(
            replies.find((reply) => reply.statusCode === 409)!.json().error
              .details.current_version,
            2
          );
        }
      );
      await t.test(
        "simultaneous claims have one owner and completion is durable",
        async () => {
          const replies = await Promise.all(
            workers.map((worker) =>
              request(
                "POST",
                `/agent/tasks/${authored.id}/claim`,
                { session_id: worker.session.id, lease_seconds: 300 },
                worker.token
              )
            )
          );
          assert.deepEqual(
            replies.map((reply) => reply.statusCode).sort(),
            [200, 409]
          );
          const index = replies.findIndex((reply) => reply.statusCode === 200);
          const winner = workers[index],
            loser = workers[1 - index];
          const { claim_token } = replies[index].json();
          const denied = await request(
            "POST",
            `/agent/sessions/${loser.session.id}/claims/complete`,
            { claim_token },
            loser.token
          );
          assert.equal(denied.statusCode, 403, denied.body);
          const completed = await request(
            "POST",
            `/agent/sessions/${winner.session.id}/claims/complete`,
            { claim_token },
            winner.token
          );
          assert.equal(completed.statusCode, 200, completed.body);
          const status = (
            await request(
              "GET",
              `/agent/tasks/${authored.id}`,
              undefined,
              a.token
            )
          ).json().status;
          assert.equal(status, "done");
          const claims = (
            await pool.query(
              "SELECT status FROM task_claims WHERE task_id=$1",
              [authored.id]
            )
          ).rows;
          assert.deepEqual(claims, [{ status: "completed" }]);
          const events = (
            await pool.query(
              "SELECT type FROM project_events WHERE payload->>'task_id'=$1 AND type='claim.created'",
              [authored.id]
            )
          ).rows;
          assert.equal(events.length, 1);
        }
      );
      await t.test(
        "an expired claim can be taken over and its former owner cannot complete",
        async () => {
          const created = await request(
            "POST",
            "/agent/tasks",
            { title: "Expired takeover", status: "ready" },
            a.token,
            "expired-takeover"
          );
          assert.equal(created.statusCode, 201, created.body);
          const taskId = created.json().id;
          const first = await request(
            "POST",
            `/agent/tasks/${taskId}/claim`,
            { session_id: a.session.id, lease_seconds: 300 },
            a.token
          );
          assert.equal(first.statusCode, 200, first.body);
          await pool.query(
            "UPDATE task_claims SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
            [first.json().claim.id]
          );

          const takeover = await request(
            "POST",
            `/agent/tasks/${taskId}/claim`,
            { session_id: b.session.id, lease_seconds: 300 },
            b.token
          );
          assert.equal(takeover.statusCode, 200, takeover.body);
          assert.equal(takeover.json().claim.agent_id, b.agent.id);
          const staleCompletion = await request(
            "POST",
            `/agent/sessions/${a.session.id}/claims/complete`,
            { claim_token: first.json().claim_token },
            a.token
          );
          assert.equal(staleCompletion.statusCode, 409, staleCompletion.body);
          assert.equal(staleCompletion.json().error.code, "CLAIM_NOT_FOUND");
          const oldClaim = (
            await pool.query("SELECT status FROM task_claims WHERE id=$1", [
              first.json().claim.id
            ])
          ).rows[0];
          assert.deepEqual(oldClaim, { status: "expired" });

          const completed = await request(
            "POST",
            `/agent/sessions/${b.session.id}/claims/complete`,
            { claim_token: takeover.json().claim_token },
            b.token
          );
          assert.equal(completed.statusCode, 200, completed.body);
        }
      );
      await t.test(
        "claims reject unresolved dependencies and allow them once resolved",
        async () => {
          const blocker = await request(
            "POST",
            "/agent/tasks",
            { title: "Dependency blocker", status: "ready" },
            a.token,
            "dependency-blocker"
          );
          const dependent = await request(
            "POST",
            "/agent/tasks",
            { title: "Dependency gated", status: "ready" },
            a.token,
            "dependency-gated"
          );
          assert.equal(blocker.statusCode, 201, blocker.body);
          assert.equal(dependent.statusCode, 201, dependent.body);
          const blockerTask = blocker.json();
          const dependentTask = dependent.json();
          const added = await request(
            "POST",
            `/tasks/${dependentTask.id}/dependencies`,
            {
              depends_on_task_id: blockerTask.id,
              expected_version: dependentTask.version
            }
          );
          assert.equal(added.statusCode, 200, added.body);

          const rejected = await request(
            "POST",
            `/agent/tasks/${dependentTask.id}/claim`,
            { session_id: a.session.id, lease_seconds: 300 },
            a.token
          );
          assert.equal(rejected.statusCode, 409, rejected.body);
          assert.equal(rejected.json().error.code, "TASK_NOT_CLAIMABLE");
          assert.equal(
            rejected.json().error.details.depends_on_task_id,
            blockerTask.id
          );

          const resolved = await request(
            "POST",
            `/tasks/${blockerTask.id}/move`,
            {
              status: "done",
              expected_version: blockerTask.version
            }
          );
          assert.equal(resolved.statusCode, 200, resolved.body);
          const claimed = await request(
            "POST",
            `/agent/tasks/${dependentTask.id}/claim`,
            { session_id: a.session.id, lease_seconds: 300 },
            a.token
          );
          assert.equal(claimed.statusCode, 200, claimed.body);
        }
      );
      await t.test(
        "document row locks reject same-base edits and keep contiguous revisions",
        async () => {
          const created = await request(
            "POST",
            `/projects/${project.id}/documents`,
            { path: "docs/plan.md", content: "Original" }
          );
          assert.equal(created.statusCode, 201, created.body);
          const id = created.json().document.id;
          const replies = await Promise.all(
            ["Left", "Right"].map((content) =>
              request("PATCH", `/documents/${id}`, {
                base_revision: 1,
                content
              })
            )
          );
          assert.deepEqual(
            replies.map((reply) => reply.statusCode).sort(),
            [200, 409]
          );
          assert.equal(
            replies.find((reply) => reply.statusCode === 409)!.json().error
              .code,
            "DOCUMENT_CONFLICT"
          );
          const revisions = (
            await pool.query(
              "SELECT revision_number AS revision FROM document_revisions WHERE document_id=$1 ORDER BY revision_number",
              [id]
            )
          ).rows;
          assert.deepEqual(revisions, [{ revision: 1 }, { revision: 2 }]);
        }
      );
      await t.test(
        "project credentials cannot read, edit, or comment across projects",
        async () => {
          const foreign = (
            await request(
              "POST",
              `/projects/${other.id}/tasks`,
              { title: "Other project task" },
              "alice",
              "foreign-task"
            )
          ).json();
          for (const [method, suffix, payload] of [
            ["GET", "", undefined],
            ["PATCH", "", { title: "Wrong project", expected_version: 1 }],
            ["GET", "/comments", undefined],
            ["POST", "/comments", { body_markdown: "Wrong project" }]
          ] as const) {
            const reply = await request(
              method,
              `/agent/tasks/${foreign.id}${suffix}`,
              payload,
              a.token,
              "foreign-comment"
            );
            assert.equal(reply.statusCode, 404, reply.body);
          }
          await request(
            "POST",
            `/projects/${project.id}/agents/${b.agent.id}/revoke`
          );
          const revoked = await request(
            "POST",
            "/agent/tasks",
            { title: "Revoked" },
            b.token,
            "revoked-task"
          );
          assert.equal(revoked.statusCode, 401, revoked.body);
        }
      );
      await t.test(
        "R2 document backfill and direct/multipart attachments round trip",
        { skip: !testR2 },
        async () => {
          const userId = (
            await pool.query(
              "SELECT id FROM users WHERE auth_subject='postgres-alice'"
            )
          ).rows[0].id;
          const inline = await new DocumentService(db).create(
            userId,
            project.id,
            { path: "docs/legacy.md", content: "# Preserved inline content\n" }
          );
          const before = await backfill(db, storage!, storageConfig!, false);
          assert.equal(before.planned, 1);
          assert.equal(before.uploaded, 0);
          const applied = await backfill(db, storage!, storageConfig!, true);
          assert.equal(applied.updated, 1);
          assert.equal(
            (await backfill(db, storage!, storageConfig!, true)).planned,
            0
          );
          const loaded = await request(
            "GET",
            `/documents/${inline.document.id}`
          );
          assert.equal(
            loaded.json().revision.content,
            "# Preserved inline content\n"
          );
          const base = `/documents/${inline.document.id}/attachments`;
          for (const size of [23, 100 * 1024 * 1024 + 1]) {
            const created = await request("POST", `${base}/uploads`, {
              filename: `acceptance-${size}.bin`,
              content_type: "application/octet-stream",
              size_bytes: size
            });
            assert.equal(created.statusCode, 201, created.body);
            const { upload } = created.json();
            const parts: Array<{ part_number: number; etag: string }> = [];
            if (upload.mode === "single") {
              const response = await fetch(upload.upload_url, {
                method: "PUT",
                body: Buffer.alloc(size, 42)
              });
              assert.equal(response.status, 200, "Direct R2 PUT must succeed");
            } else {
              assert.equal(upload.mode, "multipart");
              const numbers = Array.from(
                { length: Math.ceil(size / upload.part_size_bytes) },
                (_, index) => index + 1
              );
              const signed = await request(
                "POST",
                `${base}/uploads/${upload.id}/parts`,
                { part_numbers: numbers }
              );
              assert.equal(signed.statusCode, 200, signed.body);
              for (const part of signed.json().parts) {
                const bytes = Math.min(
                  upload.part_size_bytes,
                  size - (part.part_number - 1) * upload.part_size_bytes
                );
                const response = await fetch(part.upload_url, {
                  method: "PUT",
                  body: Buffer.alloc(bytes, 42)
                });
                assert.equal(
                  response.status,
                  200,
                  "Multipart R2 PUT must succeed"
                );
                assert.ok(response.headers.get("etag"));
                parts.push({
                  part_number: part.part_number,
                  etag: response.headers.get("etag")!
                });
              }
            }
            const completions = await Promise.all(
              [1, 2].map(() =>
                request("POST", `${base}/uploads/${upload.id}/complete`, {
                  parts
                })
              )
            );
            for (const completed of completions)
              assert.equal(completed.statusCode, 200, completed.body);
            const attachment = completions[0].json().attachment;
            assert.equal(completions[1].json().attachment.id, attachment.id);
            const ticket = await request(
              "POST",
              `${base}/${attachment.id}/download`
            );
            const download = await app.inject({
              method: "GET",
              url: ticket.json().download_url
            });
            assert.equal(download.statusCode, 200);
            assert.equal(download.rawPayload.byteLength, size);
            assert.ok(
              download.rawPayload.equals(Buffer.alloc(size, 42)),
              "Downloaded bytes must match uploaded bytes"
            );
            assert.equal(
              (
                await app.inject({
                  method: "GET",
                  url: ticket.json().download_url
                })
              ).statusCode,
              401,
              "Download tickets are single use"
            );
            assert.equal(
              (await request("DELETE", `${base}/${attachment.id}`)).statusCode,
              200
            );
          }
          const cancelled = (
            await request("POST", `${base}/uploads`, {
              filename: "cancelled.bin",
              content_type: "application/octet-stream",
              size_bytes: 100 * 1024 * 1024 + 1
            })
          ).json().upload;
          assert.equal(
            (await request("DELETE", `${base}/uploads/${cancelled.id}`))
              .statusCode,
            200
          );
          assert.equal(
            (
              await request(
                "POST",
                `${base}/uploads/${cancelled.id}/complete`,
                { parts: [] }
              )
            ).statusCode,
            409
          );
        }
      );
    } finally {
      await app.close();
      if (storage && storageConfig) {
        // Restrict provider cleanup to this run's randomly generated projects.
        const projectIds = (
          await pool.query("SELECT id FROM projects")
        ).rows.map((row) => row.id);
        const pending = (
          await pool.query(
            "SELECT project_id,document_id,id,provider_upload_id FROM document_attachment_uploads WHERE provider_upload_id IS NOT NULL AND status='pending'"
          )
        ).rows;
        for (const row of pending)
          await storage.send(
            new AbortMultipartUploadCommand({
              Bucket: storageConfig.bucket,
              Key: `document-attachments/v1/${row.project_id}/${row.document_id}/${row.id}`,
              UploadId: row.provider_upload_id
            })
          );
        for (const id of projectIds)
          for (const root of ["document-revisions", "document-attachments"]) {
            const objects = await storage.send(
              new ListObjectsV2Command({
                Bucket: storageConfig.bucket,
                Prefix: `${root}/v1/${id}/`
              })
            );
            assert.ok(
              !objects.IsTruncated,
              "Acceptance cleanup must cover every test object"
            );
            for (const object of objects.Contents ?? [])
              await storage.send(
                new DeleteObjectCommand({
                  Bucket: storageConfig.bucket,
                  Key: object.Key!
                })
              );
          }
        storage.destroy();
      }
      await pool.end();
      await admin.pool.query(`DROP DATABASE "${name}"`);
      await admin.pool.end();
    }
  }
);
