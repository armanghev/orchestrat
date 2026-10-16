import { http, HttpResponse, type RequestHandler } from "msw";
import { vi } from "vitest";
import type { Branch, Chat } from "@orchestrat/protocol";
import { FakeAuthClient } from "@/test/fake-auth-client";
import { branch, project, taskCard } from "@/test/factories";
import { handlers } from "@/test/handlers";
import { renderDashboardRoute } from "@/test/render";

// Shared fixtures for the dashboard's branch route tests.

export const apiUrl = "http://localhost:8801/api/v1";
export const expectedProject = project();
export const projectId = expectedProject.id;
export const selfId = "00000000-0000-4000-8000-000000000004";
export const main = branch();
export const feature = branch({
  id: "00000000-0000-4000-8000-000000000051",
  name: "feat/checkout",
  is_default: false,
  name_source: "user",
  created_via: "dashboard",
  updated_at: "2026-09-29T00:00:00.000Z"
});
export const old = branch({
  id: "00000000-0000-4000-8000-000000000052",
  name: "feat/old",
  is_default: false,
  name_source: "provider",
  created_via: "provider",
  archived_at: "2026-09-27T12:00:00.000Z",
  archived_reason: "provider_deleted",
  provider: { provider: "github", state: "missing", head_sha: null }
});

export class Auth extends FakeAuthClient {}

export function platform() {
  return {
    kind: "web" as const,
    preferences: {
      load: vi.fn(async () => null),
      save: vi.fn(async () => undefined)
    },
    openExternal: vi.fn(async () => undefined),
    onAuthCallback: vi.fn(async () => () => undefined)
  };
}

export const branchOf = (request: Request) =>
  new URL(request.url).searchParams.get("branch_id") ?? main.id;

export function chat(overrides: Partial<Chat> = {}): Chat {
  const timestamp = "2026-09-24T00:00:00.000Z";
  return {
    id: "00000000-0000-4000-8000-000000000061",
    project_id: projectId,
    kind: "direct",
    name: null,
    has_human: true,
    creator: { type: "human", id: selfId },
    participants: [
      { type: "human", id: selfId, name: "Test User", avatar_url: null },
      {
        type: "agent",
        id: "00000000-0000-4000-8000-000000000020",
        name: "codex",
        avatar_url: null
      }
    ],
    is_participant: true,
    can_manage: false,
    can_join: false,
    last_sequence: 0,
    last_read_sequence: 0,
    unread_count: 0,
    mention_count: 0,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides
  };
}

/** Branch-aware API mocks. `seen` records `<collection>:<branch id>`. */
export function branchHandlers({
  branches = [main, feature, old],
  seen = [],
  chats = () => []
}: {
  branches?: Branch[];
  seen?: string[];
  chats?: (branchId: string) => Chat[];
} = {}): RequestHandler[] {
  const record = (collection: string, request: Request) => {
    seen.push(`${collection}:${branchOf(request)}`);
    return branchOf(request);
  };
  return [
    http.get(`${apiUrl}/profile`, () =>
      HttpResponse.json({
        user_id: selfId,
        provider: "github",
        username: "tester",
        full_name: "Test User",
        email: "test@example.com",
        avatar_url: null
      })
    ),
    http.get(`${apiUrl}/projects/:projectId/branches`, () =>
      HttpResponse.json({ branches })
    ),
    http.get(`${apiUrl}/projects/:projectId/tasks`, ({ request }) => {
      const branchId = record("tasks", request);
      return HttpResponse.json({
        tasks: [
          taskCard({
            branch_id: branchId,
            title: branchId === main.id ? "Main roadmap" : "Checkout flow"
          })
        ],
        total: 1,
        next_cursor: null
      });
    }),
    http.get(`${apiUrl}/projects/:projectId/documents`, ({ request }) => {
      record("documents", request);
      return HttpResponse.json({
        documents: [],
        folders: [],
        next_cursor: null
      });
    }),
    http.get(`${apiUrl}/projects/:projectId/chats`, ({ request }) =>
      HttpResponse.json({ chats: chats(record("chats", request)) })
    ),
    http.get(`${apiUrl}/projects/:projectId/inbox`, ({ request }) => {
      if (new URL(request.url).searchParams.get("all_branches") === "true")
        return HttpResponse.json({
          unread_chats: [
            {
              chat_id: "00000000-0000-4000-8000-000000000062",
              branch_id: feature.id,
              unread_count: 2,
              mention_count: 0
            }
          ]
        });
      record("inbox", request);
      return HttpResponse.json({ unread_chats: [] });
    }),
    http.get(`${apiUrl}/projects/:projectId/events`, ({ request }) => {
      record(
        new URL(request.url).searchParams.get("all_branches") === "true"
          ? "events-all"
          : "events",
        request
      );
      return HttpResponse.json({ events: [], next_cursor: null });
    }),
    ...handlers
  ];
}

export function render(path: string, extra: RequestHandler[]) {
  return renderDashboardRoute({
    path,
    auth: new Auth({ status: "signedIn", identityKey: "user" }),
    platform: platform(),
    handlers: extra
  });
}
