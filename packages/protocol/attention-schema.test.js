import assert from "node:assert/strict";
import test from "node:test";
import {
  acknowledgeAttentionRequestSchema,
  apiErrorResponseSchema,
  apiErrorSchema,
  attentionSummarySchema,
  claimMutationRequestSchema,
  createHandoffRequestSchema,
  createTaskCommentRequestSchema,
  errorCodeSchema,
  setTaskStatusRequestSchema,
  taskCommentSchema,
  unreadCommentsErrorDetailsSchema,
  waitQuerySchema,
  waitResponseSchema
} from "./dist/index.js";

const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const timestamp = "2026-09-28T00:00:00.000Z";
const token = "x".repeat(32);
const actor = { type: "agent", id, name: "Codex" };

const summary = {
  cursor: "42",
  branch_id: null,
  unread_chats: [{ chat_id: id, unread_count: 2, mention_count: 1 }],
  tasks: [
    {
      task_id: id,
      key: "ORC-7",
      title: "Contracts",
      status: "in_progress",
      watching: true,
      claimed_by_you: true,
      unread_count: 1,
      mention_count: 1,
      blocking_unread_count: 1,
      last_read_sequence: 3,
      latest_sequence: 4,
      unread: [
        {
          sequence: 4,
          author: actor,
          excerpt: "Please rename the field.",
          created_at: timestamp,
          mentions_you: true
        }
      ]
    }
  ],
  handoffs: [
    {
      handoff_id: id,
      from: actor,
      chat_id: id,
      message_id: other,
      sequence: 9,
      task: { id, key: "ORC-7", title: "Contracts" },
      excerpt: "Your turn.",
      created_at: timestamp,
      hop: 1
    }
  ],
  blockers_resolved: [
    {
      block_id: id,
      task: { id, key: "ORC-7", title: "Contracts" },
      resolution: "blocking_task_done",
      resolved_at: timestamp
    }
  ],
  truncated: false
};

test("parses the attention summary and wait response", () => {
  assert.deepEqual(attentionSummarySchema.parse(summary), summary);
  assert.throws(() =>
    attentionSummarySchema.parse({
      ...summary,
      tasks: [
        {
          ...summary.tasks[0],
          unread: Array(6).fill(summary.tasks[0].unread[0])
        }
      ]
    })
  );
  assert.equal(
    waitResponseSchema.parse({
      status: "updates",
      events: [
        {
          kind: "handoff",
          event_id: 43,
          occurred_at: timestamp,
          actor,
          task: null,
          chat_id: id,
          handoff_id: id,
          branch_id: null
        }
      ],
      cursor: "43",
      attention: summary
    }).events[0].kind,
    "handoff"
  );
});

test("acknowledges task comments, handoffs and blockers by discriminated type", () => {
  const items = [
    { type: "task_comments", task_id: id, through_sequence: 0 },
    { type: "handoff", handoff_id: id },
    { type: "blocker", block_id: id }
  ];
  assert.deepEqual(
    acknowledgeAttentionRequestSchema.parse({ items }).items,
    items
  );
  assert.throws(() => acknowledgeAttentionRequestSchema.parse({ items: [] }));
  assert.throws(() =>
    acknowledgeAttentionRequestSchema.parse({
      items: Array(51).fill(items[1])
    })
  );
  assert.throws(() =>
    acknowledgeAttentionRequestSchema.parse({
      items: [{ type: "task_comments", task_id: id, through_sequence: -1 }]
    })
  );
  assert.throws(() =>
    acknowledgeAttentionRequestSchema.parse({
      items: [{ type: "handoff", block_id: id }]
    })
  );
  assert.throws(() =>
    acknowledgeAttentionRequestSchema.parse({
      items: [{ type: "chat", chat_id: id }]
    })
  );
});

test("set task status requires a reason for blocked and scopes blockers to it", () => {
  assert.equal(
    setTaskStatusRequestSchema.parse({
      claim_token: token,
      status: "blocked",
      reason: "  Waiting on the API contract  ",
      blocked_on: { type: "agent", id },
      blocking_task_id: other
    }).reason,
    "Waiting on the API contract"
  );
  assert.equal(
    setTaskStatusRequestSchema.parse({
      claim_token: token,
      status: "review",
      acknowledged_through: 4
    }).acknowledged_through,
    4
  );
  assert.throws(() =>
    setTaskStatusRequestSchema.parse({ claim_token: token, status: "blocked" })
  );
  assert.throws(() =>
    setTaskStatusRequestSchema.parse({
      claim_token: token,
      status: "blocked",
      reason: "   "
    })
  );
  assert.throws(() =>
    setTaskStatusRequestSchema.parse({
      claim_token: token,
      status: "blocked",
      reason: "x".repeat(501)
    })
  );
  assert.throws(() =>
    setTaskStatusRequestSchema.parse({
      claim_token: token,
      status: "in_progress",
      blocked_on: { type: "agent", id }
    })
  );
  assert.throws(() =>
    setTaskStatusRequestSchema.parse({
      claim_token: token,
      status: "review",
      blocking_task_id: id
    })
  );
  assert.throws(() =>
    setTaskStatusRequestSchema.parse({ claim_token: token, status: "done" })
  );
});

test("wait query coerces strings, booleans and comma-separated kinds", () => {
  assert.deepEqual(waitQuerySchema.parse({}), {
    timeout_ms: 25000,
    directed_only: false
  });
  assert.deepEqual(
    waitQuerySchema.parse({
      after: "120",
      timeout_ms: "5000",
      directed_only: "true",
      kinds: "mention, handoff",
      branch_id: id
    }),
    {
      after: "120",
      timeout_ms: 5000,
      directed_only: true,
      kinds: ["mention", "handoff"],
      branch_id: id
    }
  );
  assert.equal(
    waitQuerySchema.parse({ directed_only: true }).directed_only,
    true
  );
  assert.equal(
    waitQuerySchema.parse({ directed_only: "false" }).directed_only,
    false
  );
  assert.deepEqual(waitQuerySchema.parse({ kinds: ["task_comment"] }).kinds, [
    "task_comment"
  ]);
  assert.throws(() => waitQuerySchema.parse({ after: "12a" }));
  assert.throws(() => waitQuerySchema.parse({ after: "-1" }));
  assert.throws(() => waitQuerySchema.parse({ timeout_ms: "25001" }));
  assert.throws(() => waitQuerySchema.parse({ directed_only: "yes" }));
  assert.throws(() => waitQuerySchema.parse({ kinds: "mention,unknown" }));
  assert.throws(() => waitQuerySchema.parse({ kinds: "" }));
  assert.throws(() => waitQuerySchema.parse({ branch_id: "main" }));
});

test("error codes accept attention failures with unread comment details", () => {
  for (const code of [
    "TASK_COMMENTS_UNREAD",
    "WATCH_LIMIT",
    "INVALID_STATUS_TRANSITION",
    "BLOCKER_CYCLE",
    "WAIT_LIMIT",
    "HANDOFF_CHAIN_LIMIT",
    "HANDOFF_RATE_LIMITED",
    "WAKE_LIMIT"
  ])
    assert.equal(errorCodeSchema.parse(code), code);
  assert.throws(() => errorCodeSchema.parse("NOT_A_CODE"));

  const details = {
    task_id: id,
    latest_sequence: 4,
    total_unread: 1,
    unread: [
      {
        sequence: 4,
        author: actor,
        excerpt: "Rename it.",
        created_at: timestamp
      }
    ]
  };
  const error = {
    error: {
      code: "TASK_COMMENTS_UNREAD",
      message: "Read new comments first.",
      details,
      request_id: "req_unread"
    }
  };
  const parsed = apiErrorResponseSchema.parse(error);
  assert.equal(parsed.error.code, "TASK_COMMENTS_UNREAD");
  assert.deepEqual(
    unreadCommentsErrorDetailsSchema.parse(parsed.error.details),
    details
  );
  assert.equal(apiErrorSchema.parse(error).error.code, "INTERNAL_ERROR");
});

test("task comments carry sequence and bounded structured mentions", () => {
  assert.deepEqual(
    createTaskCommentRequestSchema.parse({ body_markdown: "hello" }),
    { body_markdown: "hello", mentions: [] }
  );
  assert.equal(
    createTaskCommentRequestSchema.parse({
      body_markdown: "hello",
      mentions: Array(20).fill({ type: "human", id })
    }).mentions.length,
    20
  );
  assert.throws(() =>
    createTaskCommentRequestSchema.parse({
      body_markdown: "hello",
      mentions: Array(21).fill({ type: "human", id })
    })
  );
  assert.throws(() =>
    createTaskCommentRequestSchema.parse({
      body_markdown: "hello",
      mentions: [{ type: "bot", id }]
    })
  );
  const comment = {
    id,
    task_id: id,
    author: {
      type: "agent",
      id,
      user_id: null,
      agent_id: id,
      username: null,
      full_name: "Codex",
      avatar_url: null
    },
    body_markdown: "hello",
    sequence: 1,
    mentions: [{ type: "human", id: other, name: "Arman" }],
    created_at: timestamp
  };
  assert.equal(taskCommentSchema.parse(comment).sequence, 1);
  assert.throws(() => taskCommentSchema.parse({ ...comment, sequence: 0 }));
  assert.equal(
    claimMutationRequestSchema.parse({
      claim_token: token,
      acknowledged_through: 0
    }).acknowledged_through,
    0
  );
  assert.throws(() =>
    claimMutationRequestSchema.parse({
      claim_token: token,
      acknowledged_through: -1
    })
  );
  assert.equal(
    createHandoffRequestSchema.parse({
      to: { type: "agent", id },
      body_markdown: "  Over to you  "
    }).body_markdown,
    "Over to you"
  );
  assert.throws(() =>
    createHandoffRequestSchema.parse({
      to: { type: "agent", id },
      body_markdown: "x".repeat(4001)
    })
  );
});
