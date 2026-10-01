import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import {
  agentSessions,
  branchItemBaselines,
  branchMergeRuns,
  createDatabase,
  projectBranches,
  taskClaims,
  tasks
} from "@orchestrat/db";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { AgentService } from "../services/agent-service.js";
import { BranchService } from "../services/branch-service.js";
import { MergeEngine } from "../services/merges/engine.js";
import { workspaceOn } from "../test/workspace.js";

// Branch concurrency needs real row locks (docs/project-branches.md §13.2).
// Opt in like postgres-acceptance: every run creates and drops its database.
const postgresUrl = process.env.ORCHESTRAT_TEST_POSTGRES_URL;

test(
  "PostgreSQL branch isolation under concurrency",
  { skip: !postgresUrl },
  async (t) => {
    const admin = createDatabase({ connectionString: postgresUrl, max: 1 });
    const name = `orchestrat_test_${randomUUID().replaceAll("-", "")}`;
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    const url = new URL(postgresUrl!);
    url.pathname = `/${name}`;
    const { db, pool } = createDatabase({
      connectionString: url.toString(),
      max: 12
    });
    const app = buildApp({
      allowedOrigins: [],
      db,
      auth: {
        async authenticate(request) {
          const token = [...(request.headers as Iterable<[string, string]>)]
            .find(([key]) => key.toLowerCase() === "authorization")?.[1]
            ?.replace(/^Bearer\s+/, "");
          if (token !== "alice" && token !== "bob") return null;
          return {
            authSubject: `postgres-${token}`,
            avatarUrl: null,
            email: `${token}@example.com`,
            name: token === "alice" ? "Alice" : "Bob",
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
      for (const file of (await readdir(migrations))
        .filter((value) => value.endsWith(".sql"))
        .sort())
        await pool.query(await readFile(new URL(file, migrations), "utf8"));

      const space = async () => {
        const s = await workspaceOn(app, db);
        const feature = (
          await s.alice("POST", `/projects/${s.project.id}/branches`, {
            name: `feat/${randomUUID().slice(0, 8)}`
          })
        ).json().branch;
        return {
          ...s,
          main: s.project.default_branch_id as string,
          feature: feature.id as string
        };
      };
      const key = () => ({ "idempotency-key": randomUUID() });

      await t.test("same-name branch creation has one winner", async () => {
        const s = await space();
        const results = await Promise.all(
          Array.from({ length: 4 }, () =>
            s.bob("POST", `/projects/${s.project.id}/branches`, {
              name: "feat/race"
            })
          )
        );
        const codes = results.map((result) => result.statusCode).sort();
        assert.deepEqual(codes, [201, 409, 409, 409]);
        for (const result of results.filter(
          (value) => value.statusCode === 409
        ))
          assert.equal(result.json().error.code, "BRANCH_NAME_TAKEN");
      });

      await t.test(
        "concurrent registration converges on one branch",
        async () => {
          const s = await space();
          const agents = await Promise.all([
            s.createAgent("codex"),
            s.createAgent("claude")
          ]);
          const results = await Promise.all(
            agents.map(({ call }) =>
              call("POST", "/branches/register", { name: "feat/shared" })
            )
          );
          for (const result of results)
            assert.equal(result.statusCode, 200, result.body);
          const ids = new Set(results.map((result) => result.json().branch.id));
          assert.equal(ids.size, 1);
          assert.deepEqual(
            results.map((result) => result.json().created).sort(),
            [false, true]
          );
        }
      );

      await t.test("claims race per branch", async () => {
        const s = await space();
        const ready = async (branchId: string) =>
          (
            await s.alice(
              "POST",
              `/projects/${s.project.id}/tasks?branch_id=${branchId}`,
              { title: "Race", status: "ready" },
              key()
            )
          ).json();
        const session = async (
          call: Awaited<ReturnType<typeof s.createAgent>>["call"],
          branchId: string
        ) =>
          (
            await call("POST", "/sessions", {
              runtime: "codex",
              integration: "codex",
              branch_id: branchId
            })
          ).json().session;
        const first = await s.createAgent("first");
        const second = await s.createAgent("second");

        // Different branches: independent work, both win.
        const [mainTask, featureTask] = await Promise.all([
          ready(s.main),
          ready(s.feature)
        ]);
        const [onMain, onFeature] = await Promise.all([
          session(first.call, s.main),
          session(second.call, s.feature)
        ]);
        const independent = await Promise.all([
          first.call("POST", `/tasks/${mainTask.id}/claim`, {
            session_id: onMain.id
          }),
          second.call("POST", `/tasks/${featureTask.id}/claim`, {
            session_id: onFeature.id
          })
        ]);
        assert.deepEqual(
          independent.map((result) => result.statusCode),
          [200, 200]
        );

        // One task, two sessions on its branch: exactly one claim.
        const contested = await ready(s.feature);
        const [a, b] = await Promise.all([
          session(first.call, s.feature),
          session(second.call, s.feature)
        ]);
        const race = await Promise.all([
          first.call("POST", `/tasks/${contested.id}/claim`, {
            session_id: a.id
          }),
          second.call("POST", `/tasks/${contested.id}/claim`, {
            session_id: b.id
          })
        ]);
        assert.deepEqual(
          race.map((result) => result.statusCode).sort(),
          [200, 409]
        );
        const active = await db
          .select()
          .from(taskClaims)
          .where(
            and(
              eq(taskClaims.taskId, contested.id),
              eq(taskClaims.status, "active")
            )
          );
        assert.equal(active.length, 1);
      });

      await t.test("archive never leaves live sessions or claims", async () => {
        const s = await space();
        const { call } = await s.createAgent("codex");
        const task = (
          await s.alice(
            "POST",
            `/projects/${s.project.id}/tasks?branch_id=${s.feature}`,
            { title: "Work", status: "ready" },
            key()
          )
        ).json();
        const session = (
          await call("POST", "/sessions", {
            runtime: "codex",
            integration: "codex",
            branch_id: s.feature
          })
        ).json().session;
        const [archive, opened, claimed] = await Promise.all([
          s.alice(
            "POST",
            `/projects/${s.project.id}/branches/${s.feature}/archive`,
            {}
          ),
          call("POST", "/sessions", {
            runtime: "codex",
            integration: "codex",
            branch_id: s.feature
          }),
          call("POST", `/tasks/${task.id}/claim`, { session_id: session.id })
        ]);
        assert.equal(archive.statusCode, 200, archive.body);
        assert.ok(
          opened.statusCode === 201 ||
            opened.json().error.code === "BRANCH_ARCHIVED",
          opened.body
        );
        assert.ok(claimed.statusCode === 200 || claimed.statusCode === 409);
        const [branch] = await db
          .select()
          .from(projectBranches)
          .where(eq(projectBranches.id, s.feature));
        assert.ok(branch!.archivedAt);
        const liveSessions = await db
          .select()
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.branchId, s.feature),
              eq(agentSessions.status, "active")
            )
          );
        assert.equal(liveSessions.length, 0);
        const liveClaims = await db
          .select()
          .from(taskClaims)
          .where(
            and(
              eq(taskClaims.branchId, s.feature),
              eq(taskClaims.status, "active")
            )
          );
        assert.equal(liveClaims.length, 0);
      });

      await t.test(
        "interleaved branch writes keep one event order",
        async () => {
          const s = await space();
          const created = await Promise.all(
            Array.from({ length: 16 }, (_, index) =>
              s.alice(
                "POST",
                `/projects/${s.project.id}/tasks${index % 2 ? `?branch_id=${s.feature}` : ""}`,
                { title: `Task ${index}` },
                key()
              )
            )
          );
          for (const result of created) assert.equal(result.statusCode, 201);
          const feed = async (query: string) => {
            const events: Array<{
              id: number;
              type: string;
              entity_id: string;
            }> = [];
            let after = "0";
            for (;;) {
              const page = (
                await s.alice(
                  "GET",
                  `/projects/${s.project.id}/events?limit=5&after=${after}${query}`
                )
              ).json();
              events.push(...page.events);
              if (!page.next_cursor) break;
              after = page.next_cursor;
            }
            return events;
          };
          const all = await feed("&all_branches=true");
          const ids = all.map((event) => event.id);
          assert.deepEqual(
            ids,
            [...ids].sort((left, right) => left - right),
            "the cursor is monotonic"
          );
          const taskEvents = (events: typeof all) =>
            events
              .filter((event) => event.type === "task.created")
              .map((event) => event.entity_id)
              .sort();
          assert.equal(taskEvents(all).length, 16, "catch-up misses nothing");
          const byBranch = (branchId: string) =>
            created
              .map((result) => result.json())
              .filter((value) => value.branch_id === branchId)
              .map((value) => value.id)
              .sort();
          assert.deepEqual(taskEvents(await feed("")), byBranch(s.main));
          assert.deepEqual(
            taskEvents(await feed(`&branch_id=${s.feature}`)),
            byBranch(s.feature)
          );
        }
      );

      await t.test(
        "attention waits wake only for the pinned branch",
        async () => {
          const s = await space();
          const { agent, call } = await s.createAgent("codex");
          const session = (
            await call("POST", "/sessions", {
              runtime: "codex",
              integration: "codex",
              branch_id: s.feature
            })
          ).json().session;
          const pinned = { "x-orchestrat-session-id": session.id };
          const dm = async (branchId?: string) =>
            (
              await s.alice(
                "POST",
                `/projects/${s.project.id}/chats${branchId ? `?branch_id=${branchId}` : ""}`,
                {
                  kind: "direct",
                  participants: [{ type: "agent", id: agent.id }]
                },
                key()
              )
            ).json();
          const mainChat = await dm();
          const featureChat = await dm(s.feature);
          const cursor = (
            await call("GET", "/attention", undefined, pinned)
          ).json().cursor;
          const waiting = call(
            "GET",
            `/attention/wait?after=${cursor}&timeout_ms=10000`,
            undefined,
            pinned
          );
          const pause = () =>
            new Promise((resolve) => setTimeout(resolve, 300));
          await pause();
          // Main-branch news must not end a wait pinned to the feature branch.
          await s.alice(
            "POST",
            `/chats/${mainChat.id}/messages`,
            { body_markdown: "main news" },
            key()
          );
          await pause();
          await s.alice(
            "POST",
            `/chats/${featureChat.id}/messages`,
            { body_markdown: "feature news" },
            key()
          );
          const woke = (await waiting).json();
          assert.equal(woke.status, "updates", JSON.stringify(woke));
          assert.ok(woke.events.length > 0);
          for (const event of woke.events) {
            assert.notEqual(event.chat_id, mainChat.id);
            assert.ok(
              event.branch_id === s.feature || event.branch_id === null
            );
          }
          assert.ok(
            woke.events.some(
              (event: { chat_id?: string }) => event.chat_id === featureChat.id
            )
          );
          assert.equal(woke.attention.branch_id, s.feature);
        }
      );

      const engine = new MergeEngine(
        db,
        new BranchService(db, new AgentService(db))
      );
      const createTasks = async (
        s: Awaited<ReturnType<typeof space>>,
        titles: string[]
      ) => {
        const created = [];
        for (const title of titles)
          created.push(
            (
              await s.alice(
                "POST",
                `/projects/${s.project.id}/tasks`,
                { title },
                key()
              )
            ).json()
          );
        return created;
      };
      const featureRows = (branchId: string) =>
        db.select().from(tasks).where(eq(tasks.branchId, branchId));

      await t.test("a failing apply leaves nothing behind", async () => {
        const s = await space();
        const [first, second] = await createTasks(s, ["First", "Second"]);
        // A row that steals the second task's number on the target makes the
        // second copy fail after the first one was written.
        await db.insert(tasks).values({
          projectId: s.project.id,
          branchId: s.feature,
          taskKey: "BLOCKER-1",
          taskNumber: Number(second.key.split("-").at(-1)),
          title: "Number thief",
          createdByType: "human",
          createdByUserId: s.aliceUser.id
        });
        await assert.rejects(
          engine.apply(s.project.id, {
            sourceBranchId: s.main,
            targetBranchId: s.feature,
            kind: "merge",
            trigger: "dashboard",
            userId: s.aliceUser.id
          })
        );
        const rows = await featureRows(s.feature);
        assert.deepEqual(
          rows.map((row) => row.title),
          ["Number thief"],
          `no partial copy of ${first.key}`
        );
        const runs = await db
          .select()
          .from(branchMergeRuns)
          .where(eq(branchMergeRuns.targetBranchId, s.feature));
        assert.equal(runs.length, 0);
        const baselines = await db
          .select()
          .from(branchItemBaselines)
          .where(eq(branchItemBaselines.projectId, s.project.id));
        assert.equal(baselines.length, 0);
      });

      await t.test("concurrent applies with one key make one run", async () => {
        const s = await space();
        await createTasks(s, ["Once"]);
        const request = {
          sourceBranchId: s.main,
          targetBranchId: s.feature,
          kind: "merge" as const,
          trigger: "dashboard" as const,
          userId: s.aliceUser.id,
          idempotencyKey: "same-key"
        };
        const results = await Promise.all([
          engine.apply(s.project.id, request),
          engine.apply(s.project.id, request),
          engine.apply(s.project.id, request)
        ]);
        assert.equal(
          new Set(results.map((result) => result.body.run.id)).size,
          1
        );
        assert.equal((await featureRows(s.feature)).length, 1);
      });

      await t.test(
        "an apply racing a target edit never loses an update",
        async () => {
          const s = await space();
          const [item] = await createTasks(s, ["Racing"]);
          await engine.apply(s.project.id, {
            sourceBranchId: s.main,
            targetBranchId: s.feature,
            kind: "merge",
            trigger: "dashboard",
            userId: s.aliceUser.id
          });
          const [copy] = await featureRows(s.feature);
          await s.alice("PATCH", `/tasks/${item.id}`, {
            title: "Changed on main",
            expected_version: 1
          });
          const preview = await engine.preview(s.project.id, {
            sourceBranchId: s.main,
            targetBranchId: s.feature,
            kind: "merge"
          });
          const [applied, edited] = await Promise.allSettled([
            engine.apply(s.project.id, {
              sourceBranchId: s.main,
              targetBranchId: s.feature,
              kind: "merge",
              trigger: "dashboard",
              userId: s.aliceUser.id,
              previewFingerprint: preview.fingerprint
            }),
            s.alice("PATCH", `/tasks/${copy!.id}`, {
              title: "Changed on the feature",
              expected_version: copy!.version
            })
          ]);
          const editOk =
            edited.status === "fulfilled" && edited.value.statusCode === 200;
          const applyOk = applied.status === "fulfilled";
          assert.notEqual(editOk, applyOk, "exactly one of them wins");
          if (!applyOk)
            assert.equal(
              (applied as PromiseRejectedResult).reason.code,
              "BRANCH_PREVIEW_STALE"
            );
          else
            assert.equal(
              (edited as PromiseFulfilledResult<any>).value.json().error.code,
              "TASK_VERSION_CONFLICT"
            );
          const [final] = await featureRows(s.feature);
          assert.equal(
            final!.title,
            applyOk ? "Changed on main" : "Changed on the feature"
          );
        }
      );
    } finally {
      await app.close();
      await pool.end();
      // Not FORCE: pool.end() resolves before its sockets close, and a plain
      // DROP waits for those sessions instead of killing them mid-close.
      await admin.pool.query(`DROP DATABASE "${name}"`);
      await admin.pool.end();
    }
  }
);
