// Local sample API for dashboard UI review; never use for production data.
// Run: node scripts/preview-api.mjs; check: add --self-check.
// Serves the sample dashboard on http://127.0.0.1:8825; resets on restart.
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = () => new Date().toISOString();
const org = {
  id: id(1),
  name: "Orchestrat",
  slug: "orchestrat",
  role: "owner",
  created_at: now(),
  updated_at: now()
};
const project = {
  id: id(4),
  organization_id: org.id,
  name: "Platform",
  slug: "platform",
  description: "Build the coordination layer for a team of AI agents.",
  status: "active",
  created_at: now(),
  updated_at: now(),
  archived_at: null
};
const profile = {
  id: id(6),
  user_id: id(6),
  provider: "github",
  username: "alex",
  full_name: "Alex Morgan",
  email: "alex@example.com",
  avatar_url: null
};
const tasks = [
  ["Add agent heartbeat recovery", "in_progress", "high"],
  ["Review permission boundaries", "review", "high"],
  ["Ship project activity feed", "done", "medium"],
  ["Document the onboarding flow", "ready", "medium"],
  ["Connect runtime event streams", "blocked", "urgent"],
  ["Improve task claim retries", "claimed", "high"],
  ["Add integration diagnostics", "backlog", "low"],
  ["Polish command palette", "done", "low"],
  ["Write API quickstart", "done", "medium"],
  ["Refresh agent session tokens", "in_progress", "medium"],
  ["Add project archive controls", "done", "low"],
  ["Test document conflict handling", "ready", "high"]
].map(([title, status, priority], i) => ({
  id: id(20 + i),
  project_id: project.id,
  key: `PLAT-${101 + i}`,
  title,
  description:
    "Coordinate this work with the team. Verify the happy path and the failure states before completing it.",
  priority,
  status,
  position: i,
  version: 1,
  created_by: { type: "human", id: profile.id },
  created_by_user_id: profile.id,
  created_at: now(),
  updated_at: now(),
  started_at: null,
  completed_at: null,
  cancelled_at: null,
  unresolved_blocker_count: status === "blocked" ? 1 : 0
}));
const agents = [
  "Codex · implementation",
  "Claude · review",
  "Codex · documentation",
  "Claude · research"
].map((name, i) => ({
  id: id(40 + i),
  project_id: project.id,
  name,
  status: "active",
  created_at: now(),
  updated_at: now(),
  revoked_at: null
}));
const humanAuthor = {
  type: "human",
  id: profile.id,
  user_id: profile.id,
  agent_id: null,
  username: profile.username,
  full_name: profile.full_name,
  avatar_url: profile.avatar_url
};
const taskComments = new Map(
  tasks.map((task, i) => [
    task.id,
    Array.from({ length: i % 3 }, (_, j) => ({
      id: id(200 + i * 3 + j),
      task_id: task.id,
      author:
        j === 0
          ? {
              type: "agent",
              id: agents[i % agents.length].id,
              user_id: null,
              agent_id: agents[i % agents.length].id,
              username: null,
              full_name: agents[i % agents.length].name,
              avatar_url: null
            }
          : humanAuthor,
      body_markdown:
        j === 0
          ? "Implementation context is ready. Please verify the happy path and failure states."
          : "Reviewed the scope. Keep the changes focused and include the verification results.",
      created_at: now()
    }))
  ])
);
const taskCard = (task) => ({
  ...task,
  comment_count: (taskComments.get(task.id) ?? []).length
});
const documents = [
  "README.md",
  "plans/platform-roadmap.md",
  "notes/architecture.md"
].map((path, i) => ({
  id: id(60 + i),
  project_id: project.id,
  path,
  current_revision: 1,
  archived_at: null,
  created_by: { type: "human", id: profile.id },
  created_at: now(),
  updated_at: now()
}));
let content =
  "# Platform workspace\n\nOne place to coordinate agents, decisions, and delivery.\n\n## This week\n\n- [x] Ship the shared project activity feed\n- [x] Add project archive controls\n- [ ] Connect runtime event streams\n- [ ] Review permission boundaries\n\n## Working agreements\n\nKeep tasks small. Share context in documents. Leave a clear handoff when work needs review.\n\n| Owner | Focus |\n| --- | --- |\n| Codex | Implementation and tests |\n| Claude | Review and architecture |";
const detail = (d) => ({
  document: d,
  revision: {
    id: id(80),
    document_id: d.id,
    revision_number: d.current_revision,
    content,
    author: { type: "human", id: profile.id },
    created_at: now()
  }
});
const events = [
  "task.created",
  "agent.connected",
  "document.updated",
  "task.completed",
  "task.review_requested"
].map((type, i) => ({
  id: i + 1,
  project_id: project.id,
  type,
  actor_agent_id: agents[i % 4].id,
  actor_user_id: null,
  entity_id: tasks[i].id,
  payload: {},
  occurred_at: new Date(Date.now() - (5 - i) * 180000).toISOString()
}));
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:8825");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "authorization,content-type,idempotency-key"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PATCH,DELETE,OPTIONS"
  );
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid JSON.",
          details: {},
          request_id: "preview"
        }
      })
    );
    return;
  }
  const path = new URL(req.url, "http://localhost").pathname;
  let data;
  if (path.endsWith("/organizations")) data = { organizations: [org] };
  else if (path.endsWith("/members"))
    data = { members: [{ ...profile, role: "owner", joined_at: now() }] };
  else if (path.endsWith("/projects")) data = { projects: [project] };
  else if (path === `/api/v1/projects/${project.id}`) {
    if (req.method === "PATCH") Object.assign(project, body);
    data = project;
  } else if (path.endsWith("/profile")) {
    if (req.method === "PATCH") Object.assign(profile, body);
    data = profile;
  } else if (path.endsWith("/agents")) data = { agents };
  else if (path.endsWith("/presence"))
    data = {
      agents: agents.map((a, i) => ({
        agent_id: a.id,
        project_id: project.id,
        session_id: id(90 + i),
        status: i === 3 ? "offline" : "online",
        last_heartbeat_at: now(),
        current_task_id: i < 3 ? tasks[[0, 5, 4][i]].id : null
      }))
    };
  else if (path.endsWith("/events")) data = { events, next_cursor: null };
  else if (path.endsWith("/tasks")) {
    if (req.method === "POST")
      tasks.push({
        ...tasks[0],
        ...body,
        id: id(100 + tasks.length),
        key: `PLAT-${101 + tasks.length}`
      });
    data =
      req.method === "POST"
        ? taskCard(tasks.at(-1))
        : {
            tasks: tasks.map(taskCard),
            total: tasks.length,
            next_cursor: null
          };
  } else if (/^\/api\/v1\/tasks\/[^/]+\/comments$/.test(path)) {
    const task = tasks.find((task) => task.id === path.split("/").at(-2));
    if (task) {
      const comments = taskComments.get(task.id) ?? [];
      if (req.method === "POST") {
        if (
          typeof body?.body_markdown !== "string" ||
          !body.body_markdown.trim()
        ) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                code: "VALIDATION_ERROR",
                message: "A comment is required.",
                details: {},
                request_id: "preview"
              }
            })
          );
          return;
        }
        data = {
          id: randomUUID(),
          task_id: task.id,
          author: humanAuthor,
          body_markdown: body.body_markdown.trim(),
          created_at: now()
        };
        comments.push(data);
        taskComments.set(task.id, comments);
        res.statusCode = 201;
      } else if (req.method === "GET") data = { comments, next_cursor: null };
    }
  } else if (path.endsWith("/dependencies"))
    data = { depends_on: [], blocks: [] };
  else if (path.includes("/tasks/")) {
    const t = tasks.find((t) => path.includes(t.id));
    if (t && req.method === "PATCH")
      Object.assign(t, body, { version: t.version + 1 });
    data = t ? taskCard(t) : undefined;
  } else if (path.endsWith("/documents"))
    data = { documents, next_cursor: null };
  else if (path.endsWith("/attachments")) data = { attachments: [] };
  else if (path.includes("/documents/")) {
    const d = documents.find((d) => path.includes(d.id));
    if (d) {
      if (req.method === "PATCH" && body.content !== undefined) {
        content = body.content;
        d.current_revision++;
      }
      data = path.endsWith("/revisions")
        ? {
            revisions: [
              {
                ...detail(d).revision,
                content_size_bytes: content.length,
                content_sha256: createHash("sha256")
                  .update(content)
                  .digest("hex")
              }
            ],
            next_cursor: null
          }
        : detail(d);
    }
  } else if (path.endsWith("/realtime/tickets"))
    data = {
      ticket: "preview-ticket-abcdefghijklmnopqrstuvwxyz",
      expires_at: now()
    };
  if (!data) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          code: "NOT_FOUND",
          message: "Unavailable in sample preview",
          details: {},
          request_id: "preview"
        }
      })
    );
    return;
  }
  res.writeHead(res.statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
});
if (process.argv.includes("--self-check")) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}/api/v1`;
  const get = async (path) => (await fetch(origin + path)).json();
  try {
    const initial = await get(`/projects/${project.id}/tasks`);
    for (const task of initial.tasks) {
      const result = await get(`/tasks/${task.id}/comments`);
      assert.equal(
        result.comments.length,
        task.comment_count,
        `${task.key}: badge and comments must match`
      );
    }
    const task = initial.tasks.find((task) => task.comment_count > 0);
    assert.ok(task, "Preview includes comments to exercise task detail");
    const response = await fetch(`${origin}/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body_markdown: "Preview comment regression check."
      })
    });
    assert.equal(response.status, 201);
    const created = await response.json();
    const comments = (await get(`/tasks/${task.id}/comments`)).comments;
    assert.equal(comments.length, task.comment_count + 1);
    assert.equal(comments.at(-1).id, created.id);
    assert.equal(
      comments.at(-1).body_markdown,
      "Preview comment regression check."
    );
    const updated = (await get(`/projects/${project.id}/tasks`)).tasks.find(
      (item) => item.id === task.id
    );
    assert.equal(updated.comment_count, comments.length);
    assert.equal(
      (await get(`/tasks/${task.id}`)).comment_count,
      comments.length
    );
    console.log(
      "Preview comments: seeded counts, reads, creates, and refreshed counts passed."
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
} else {
  server.listen(8826, "127.0.0.1", () =>
    console.log("Sample dashboard API on 127.0.0.1:8826")
  );
}
