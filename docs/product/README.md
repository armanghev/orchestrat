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
the API. The dashboard currently provides an empty project overview. Task,
agent, document, message, MCP, hook, and realtime behavior remains deferred.
