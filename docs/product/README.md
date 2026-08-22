# Product

orchestrat is a shared coordination layer for humans and autonomous agents.
It is not an agent runtime.

The current foundation gives humans an authenticated dashboard and the durable
hierarchy:

```text
Organization -> Project
```

A signed-in user can create organizations and projects, switch projects, edit
their profile, and manage an organization's name, membership, and projects via
the API. The API also exposes human task editing, Kanban moves, comments, and
project-local blockers with optimistic version checks. The dashboard is not yet
wired to those task routes. Agent claiming, task deletion, documents, messages,
MCP, hooks, and realtime behavior remain deferred.
