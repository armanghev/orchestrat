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
          if (
            [...(request.headers as Iterable<[string, string]>)].find(
              ([key]) => key.toLowerCase() === "authorization"
            )?.[1] !== "Bearer alice"
          )
            return null;
          return {
            authSubject: "postgres-alice",
            avatarUrl: null,
            email: "alice@example.com",
            name: "Alice",
            provider: "supabase",
            username: "alice"
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
        org: randomUUID(),
        project: randomUUID(),
        task: randomUUID()
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
        await pool.query(await readFile(new URL(file, migrations), "utf8"));
      }
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
