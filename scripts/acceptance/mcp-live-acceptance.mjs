#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const cli = process.env.ORCHESTRAT_CLI ?? "orchestrat";
const cwd = required("ORCHESTRAT_ACCEPTANCE_CWD");
const projectId = required("ORCHESTRAT_ACCEPTANCE_PROJECT_ID");
const apiUrl = required("ORCHESTRAT_API_URL");
const useGlobalMcp = process.env.ORCHESTRAT_ACCEPTANCE_MCP_GLOBAL === "1";
const timeoutMs = 15_000;
const children = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const note = (name, value) => console.log(`${name}: ${value}`);

function validateInputs() {
  assert.ok(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      projectId
    ),
    "ORCHESTRAT_ACCEPTANCE_PROJECT_ID must be a UUID"
  );
  const url = new URL(apiUrl);
  assert.ok(
    !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash,
    "ORCHESTRAT_API_URL must be an origin without credentials, paths, or query parameters"
  );
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  assert.ok(
    url.protocol === "https:" ||
      (url.protocol === "http:" && loopback.has(url.hostname)),
    "ORCHESTRAT_API_URL must be HTTPS or loopback HTTP"
  );
  assert.equal(
    statSync(cwd).isDirectory(),
    true,
    "acceptance cwd must be a directory"
  );
}

function spawnMcp(integration) {
  const args = ["mcp", "--integration", integration];
  if (useGlobalMcp) args.push("--global");
  else args.push("--cwd", cwd);
  const child = spawn(
    cli,
    args,
    // Deliberately inherit HOME and CODEX_HOME: the disposable mapping and
    // existing Keychain credentials are the acceptance boundary under test.
    {
      env: { ...process.env, ORCHESTRAT_API_URL: apiUrl },
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  let buffer = "";
  let nextId = 0;
  let exited = false;
  let exitResolve;
  let spawnError;
  const exit = new Promise((resolve) => (exitResolve = resolve));
  const pending = new Map();
  let toolNames = new Set();
  child.stdout.setEncoding("utf8");
  child.stdin.on("error", () => {
    // The exit handler or request deadline reports a redacted failure.
  });
  child.stderr.resume();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id !== undefined) {
        const resolver = pending.get(message.id);
        if (resolver) {
          pending.delete(message.id);
          resolver.resolve(message);
        }
      }
    }
  });
  const settleExit = (result) => {
    if (exited) return;
    exited = true;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(
        new Error(
          `${integration} MCP exited (${result.code ?? result.signal ?? "error"})`
        )
      );
    }
    pending.clear();
    exitResolve(result);
    children.delete(child);
  };
  child.on("error", (error) => {
    spawnError = error;
    settleExit({ error });
  });
  child.on("exit", (code, signal) => {
    settleExit({ code, signal });
  });

  const request = (method, params) => {
    if (exited) throw new Error(`${integration} MCP is not running`);
    if (spawnError) throw spawnError;
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${integration} MCP timed out on ${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
        reject,
        timer
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`
      );
    });
  };
  const notify = (method, params) =>
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })}\n`
    );
  const call = async (name, args = {}) => {
    const response = await request("tools/call", { name, arguments: args });
    if (response.error) throw new Error(`${name}: JSON-RPC error`);
    const result = response.result;
    const text = result?.content?.find((item) => item.type === "text")?.text;
    if (typeof text !== "string")
      throw new Error(`${name}: missing MCP result`);
    return { result, payload: JSON.parse(text) };
  };
  const success = async (name, args = {}) => {
    const response = await call(name, args);
    assert.notEqual(
      response.result.isError,
      true,
      `${integration} ${name} failed`
    );
    return response.payload;
  };
  const expectedError = async (name, args, code) => {
    const response = await call(name, args);
    assert.equal(
      response.result.isError,
      true,
      `${integration} ${name} unexpectedly succeeded`
    );
    assert.equal(response.payload.error?.code, code);
    return response.payload.error;
  };
  const stop = async (signal = "SIGTERM") => {
    if (exited) return;
    try {
      child.kill(signal);
    } catch {
      settleExit({ signal });
      return;
    }
    await Promise.race([exit, sleep(5_000)]);
    if (!exited) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may have exited between the timeout and kill attempt.
      }
      await Promise.race([exit, sleep(1_000)]);
    }
    if (!exited) settleExit({ signal: "SIGKILL" });
  };
  const initialize = async () => {
    const response = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "orchestrat-live-acceptance", version: "1" }
    });
    assert.equal(response.result?.serverInfo?.name, "orchestrat");
    notify("notifications/initialized");
    const listed = await request("tools/list");
    toolNames = new Set((listed.result?.tools ?? []).map((tool) => tool.name));
    assert.ok(listed.result?.tools?.some((tool) => tool.name === "heartbeat"));
  };
  children.set(child, stop);
  return {
    integration,
    call,
    success,
    expectedError,
    initialize,
    request,
    hasTool: (name) => toolNames.has(name),
    stop
  };
}

async function findAgentId(client, sessionId) {
  const presence = await client.success("list_agents");
  const match = presence.agents.find((agent) => agent.session_id === sessionId);
  assert.ok(match, `${client.integration} session is not present`);
  return match.agent_id;
}

function unreadNotice(response) {
  return response.result?.content
    ?.filter((item) => item.type === "text")
    .map((item) => {
      try {
        return JSON.parse(item.text);
      } catch {
        return undefined;
      }
    })
    .find((item) => item?.notice?.type === "unread_chats")?.notice;
}

async function main() {
  validateInputs();
  const codex = spawnMcp("codex");
  const claude = spawnMcp("claude-code");
  let reconnect;
  try {
    await Promise.all([codex.initialize(), claude.initialize()]);
    if (useGlobalMcp) {
      assert.ok(codex.hasTool("select_project"));
      assert.ok(claude.hasTool("select_project"));
      await Promise.all([
        codex.success("select_project", { project_id: projectId }),
        claude.success("select_project", { project_id: projectId })
      ]);
    }
    const [codexProject, claudeProject] = await Promise.all([
      codex.success("get_project"),
      claude.success("get_project")
    ]);
    assert.equal(codexProject.id, projectId);
    assert.equal(claudeProject.id, projectId);
    const [codexHeartbeat, claudeHeartbeat] = await Promise.all([
      codex.success("heartbeat"),
      claude.success("heartbeat")
    ]);
    const codexSessionId = codexHeartbeat.session.id;
    const claudeSessionId = claudeHeartbeat.session.id;
    const [codexAgentId, claudeAgentId] = await Promise.all([
      findAgentId(codex, codexSessionId),
      findAgentId(claude, claudeSessionId)
    ]);
    assert.notEqual(codexAgentId, claudeAgentId);
    note("project", projectId);
    note("MCP scope", useGlobalMcp ? "global (selected project)" : "project");
    note("live sessions", `${codexSessionId}, ${claudeSessionId}`);
    note("agent identities", `${codexAgentId}, ${claudeAgentId}`);

    const existingGroupId = process.env.ORCHESTRAT_ACCEPTANCE_EXISTING_GROUP_ID;
    if (existingGroupId) {
      assert.match(
        existingGroupId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        "ORCHESTRAT_ACCEPTANCE_EXISTING_GROUP_ID must be a UUID"
      );
      const existingChats = await claude.success("list_chats");
      const existingGroup = existingChats.chats.find(
        (chat) => chat.id === existingGroupId
      );
      assert.ok(existingGroup, "Claude cannot see the existing human group");
      assert.ok(
        existingGroup.mention_count >= 1,
        "Claude inbox has no unread mention for the existing human group"
      );
      const existingMessages = await claude.success("check_messages", {
        chat_id: existingGroupId,
        unread_only: true,
        limit: 20
      });
      const humanMention = existingMessages.messages.find(
        (message) =>
          message.author.type === "human" &&
          message.mentions.some(
            (mention) =>
              mention.type === "agent" && mention.id === claudeAgentId
          )
      );
      assert.ok(
        humanMention,
        "Claude did not receive a human-authored message with a typed mention"
      );
      note(
        "existing human group",
        existingGroupId + " (unread mention " + humanMention.id + ")"
      );
    }

    // Exercise the complete seven-tool messaging contract between the two
    // disposable agents. The human candidate proves that the project also
    // exposes the dashboard member needed for the manual human evidence.
    const candidates = await codex.success("list_message_candidates");
    const requestedHumanId = process.env.ORCHESTRAT_ACCEPTANCE_HUMAN_ID;
    const humanCandidate = candidates.candidates.find(
      (candidate) =>
        candidate.type === "human" &&
        (!requestedHumanId || candidate.id === requestedHumanId)
    );
    assert.ok(humanCandidate, "project has no human messaging candidate");
    assert.ok(
      candidates.candidates.some(
        (candidate) =>
          candidate.type === "agent" && candidate.id === claudeAgentId
      )
    );
    assert.equal(
      candidates.candidates.some(
        (candidate) =>
          candidate.type === "agent" && candidate.id === codexAgentId
      ),
      false,
      "message candidates must exclude the authenticated agent"
    );
    note("human messaging candidate", humanCandidate.id);

    const directInput = {
      kind: "direct",
      participants: [{ type: "agent", id: claudeAgentId }]
    };
    const directKey = `mcp-live-direct-${Date.now()}`;
    const directChat = await codex.success("create_chat", {
      ...directInput,
      idempotency_key: directKey
    });
    const directReplay = await codex.success("create_chat", {
      ...directInput,
      idempotency_key: directKey
    });
    assert.equal(directReplay.id, directChat.id);
    assert.equal(directChat.kind, "direct");
    assert.ok(
      directChat.participants.some(
        (participant) =>
          participant.type === "agent" && participant.id === codexAgentId
      )
    );
    assert.ok(
      directChat.participants.some(
        (participant) =>
          participant.type === "agent" && participant.id === claudeAgentId
      )
    );
    const directChatId = directChat.id;

    const listedChats = await claude.call("list_chats");
    assert.ok(
      listedChats.payload.chats.some((chat) => chat.id === directChatId),
      "direct chat is not visible to the second agent"
    );

    const groupChat = await codex.success("create_chat", {
      kind: "group",
      name: `MCP acceptance group ${Date.now()}`,
      participants: [{ type: "agent", id: claudeAgentId }],
      idempotency_key: `mcp-live-group-${Date.now()}`
    });
    assert.equal(groupChat.kind, "group");
    await codex.success("manage_chat_members", {
      chat_id: groupChat.id,
      action: "add",
      participant: { type: "human", id: humanCandidate.id }
    });
    const removedHumanGroup = await codex.success("manage_chat_members", {
      chat_id: groupChat.id,
      action: "remove",
      participant: { type: "human", id: humanCandidate.id }
    });
    assert.equal(removedHumanGroup.has_human, true);
    assert.equal(
      removedHumanGroup.participants.some(
        (participant) =>
          participant.type === "human" && participant.id === humanCandidate.id
      ),
      false
    );
    note("sticky-private group", groupChat.id + " (human removed)");

    const agentOnlyGroup = await codex.success("create_chat", {
      kind: "group",
      name: "MCP agent-only acceptance " + Date.now(),
      participants: [{ type: "agent", id: claudeAgentId }],
      idempotency_key: "mcp-live-agent-only-group-" + Date.now()
    });
    assert.equal(agentOnlyGroup.kind, "group");
    assert.equal(agentOnlyGroup.has_human, false);
    const agentOnlyGroupMessage = await codex.success("send_message", {
      chat_id: agentOnlyGroup.id,
      body_markdown: "MCP agent-only group acceptance message.",
      idempotency_key: "mcp-live-agent-only-message-" + Date.now()
    });
    assert.equal(agentOnlyGroupMessage.chat_id, agentOnlyGroup.id);
    note(
      "agent-only group",
      agentOnlyGroup.id + " (human-observable/joinable)"
    );

    const humanChat = await codex.success("create_chat", {
      kind: "direct",
      participants: [{ type: "human", id: humanCandidate.id }],
      idempotency_key: "mcp-live-human-chat-" + Date.now()
    });
    assert.equal(humanChat.kind, "direct");
    assert.equal(humanChat.has_human, true);
    const humanGreeting = await codex.success("send_message", {
      chat_id: humanChat.id,
      body_markdown:
        "MCP human acceptance greeting — please reply from the dashboard if available.",
      idempotency_key: "mcp-live-human-greeting-" + Date.now()
    });
    assert.equal(humanGreeting.chat_id, humanChat.id);
    note(
      "human evidence chat",
      humanChat.id + " (message " + humanGreeting.id + ")"
    );
    if (process.env.ORCHESTRAT_ACCEPTANCE_WAIT_FOR_HUMAN_REPLY === "1") {
      const expectedHumanReply = `Dashboard reply to ${humanGreeting.id}`;
      note("human reply expected", expectedHumanReply);
      const deadline = Date.now() + 120_000;
      let humanReply;
      while (!humanReply && Date.now() < deadline) {
        const pending = await codex.success("check_messages", {
          chat_id: humanChat.id,
          limit: 20
        });
        humanReply = pending.messages.find(
          (message) =>
            message.author.type === "human" &&
            message.author.id === humanCandidate.id &&
            message.sequence > humanGreeting.sequence &&
            message.body_markdown === expectedHumanReply
        );
        if (!humanReply) await sleep(2_000);
      }
      assert.ok(humanReply, "human reply checkpoint expired after 120 seconds");
      await codex.success("acknowledge_messages", {
        chat_id: humanChat.id,
        through_message_id: humanReply.id
      });
      note("human reply", humanReply.id);
    }

    const messageInput = {
      chat_id: directChatId,
      body_markdown: "MCP messaging acceptance."
    };
    const messageKey = `mcp-live-message-${Date.now()}`;
    const sentMessage = await codex.success("send_message", {
      ...messageInput,
      idempotency_key: messageKey
    });
    const replayedMessage = await codex.success("send_message", {
      ...messageInput,
      idempotency_key: messageKey
    });
    assert.equal(replayedMessage.id, sentMessage.id);
    assert.equal(sentMessage.chat_id, directChatId);
    assert.equal(sentMessage.author.id, codexAgentId);

    const receivedMessages = await claude.success("check_messages", {
      chat_id: directChatId,
      limit: 20
    });
    const receivedMessage = receivedMessages.messages.find(
      (message) => message.id === sentMessage.id
    );
    assert.ok(receivedMessage, "second agent did not receive the sent message");
    assert.equal(receivedMessage.author.id, codexAgentId);

    const inboxListed = await claude.call("list_chats");
    assert.ok(
      inboxListed.payload.chats.some((chat) => chat.id === directChatId),
      "list_chats omitted the direct chat after delivery"
    );
    const inboxProject = await claude.call("get_project");
    assert.equal(inboxProject.payload.id, projectId);
    const notice = unreadNotice(inboxProject);
    assert.ok(notice, "get_project did not return an unread chat notice");
    const unreadChat = notice.unread_chats.find(
      (chat) => chat.chat_id === directChatId
    );
    assert.ok(unreadChat, "unread notice omitted the direct chat");
    assert.ok(unreadChat.unread_count >= 1);

    await claude.success("acknowledge_messages", {
      chat_id: directChatId,
      through_message_id: sentMessage.id
    });
    const afterAcknowledge = await claude.success("check_messages", {
      chat_id: directChatId,
      limit: 20
    });
    assert.equal(
      afterAcknowledge.messages.some(
        (message) => message.id === sentMessage.id
      ),
      false
    );

    const reply = await claude.success("send_message", {
      chat_id: directChatId,
      body_markdown: "MCP reverse agent reply acceptance.",
      idempotency_key: "mcp-live-reply-" + Date.now()
    });
    assert.equal(reply.author.id, claudeAgentId);
    const replyNotice = unreadNotice(await codex.call("list_chats"));
    const replyUnreadChat = replyNotice?.unread_chats.find(
      (chat) => chat.chat_id === directChatId
    );
    assert.ok(
      replyUnreadChat,
      "reverse agent reply did not create an unread notice"
    );
    const codexMessages = await codex.success("check_messages", {
      chat_id: directChatId,
      limit: 20
    });
    const receivedReply = codexMessages.messages.find(
      (message) => message.id === reply.id
    );
    assert.ok(receivedReply, "first agent did not receive the reverse reply");
    assert.equal(receivedReply.author.id, claudeAgentId);
    await codex.success("acknowledge_messages", {
      chat_id: directChatId,
      through_message_id: reply.id
    });
    const afterReplyAcknowledge = await codex.success("check_messages", {
      chat_id: directChatId,
      limit: 20
    });
    assert.equal(
      afterReplyAcknowledge.messages.some((message) => message.id === reply.id),
      false
    );
    note(
      "messaging",
      `PASS: seven tools, two agents, direct idempotency, group member management, inbox notice, and acknowledgement (chat ${directChatId})`
    );
    note(
      "messaging evidence",
      "reverse reply, human chat " +
        humanChat.id +
        ", agent-only group " +
        agentOnlyGroup.id +
        ", sticky-private group " +
        groupChat.id
    );

    const task = await codex.success("create_task", {
      title: `MCP live acceptance ${Date.now()}`,
      description: "Disposable two-agent MCP acceptance task.",
      status: "ready",
      idempotency_key: `mcp-live-task-${Date.now()}`
    });
    assert.equal(task.project_id, projectId);
    assert.equal(task.status, "ready");
    assert.equal(task.created_by?.type, "agent");
    assert.equal(task.created_by?.id, codexAgentId);
    const taskId = task.id;
    note("task", taskId);

    const commentKey = `mcp-live-comment-${Date.now()}`;
    const commentInput = {
      task_id: taskId,
      body_markdown: "MCP acceptance comment."
    };
    const firstComment = await codex.success("add_task_comment", {
      ...commentInput,
      idempotency_key: commentKey
    });
    const secondComment = await codex.success("add_task_comment", {
      ...commentInput,
      idempotency_key: commentKey
    });
    assert.equal(firstComment.id, secondComment.id);
    assert.equal(firstComment.author.type, "agent");
    assert.equal(firstComment.author.agent_id, codexAgentId);
    note("idempotent comment", firstComment.id);

    const document = await codex.success("create_document", {
      path: `acceptance/mcp-live-${Date.now()}.md`,
      content: "base content"
    });
    const documentId = document.document.id;
    assert.equal(document.document.project_id, projectId);
    assert.equal(document.revision.revision_number, 1);
    const readBase = await claude.success("read_document", {
      document_id: documentId
    });
    assert.equal(readBase.revision.content, "base content");
    const winnerDocument = await codex.success("update_document", {
      document_id: documentId,
      content: "winner content",
      base_revision: 1
    });
    assert.equal(winnerDocument.revision.revision_number, 2);
    const documentConflict = await claude.expectedError(
      "update_document",
      { document_id: documentId, content: "stale content", base_revision: 1 },
      "DOCUMENT_CONFLICT"
    );
    assert.match(documentConflict.request_id, /^[A-Za-z0-9_-]{8,128}$/);
    const preservedDocument = await claude.success("read_document", {
      document_id: documentId
    });
    assert.equal(preservedDocument.revision.content, "winner content");
    note("document", documentId);
    note(
      "document conflict",
      `DOCUMENT_CONFLICT preserved winner content (request ${documentConflict.request_id})`
    );

    const claims = await Promise.all([
      codex.call("claim_task", { task_id: taskId, lease_seconds: 30 }),
      claude.call("claim_task", { task_id: taskId, lease_seconds: 30 })
    ]);
    const winners = claims.filter(
      (response) => response.result.isError !== true
    );
    const losers = claims.filter(
      (response) => response.result.isError === true
    );
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].payload.error?.code, "TASK_ALREADY_CLAIMED");
    assert.match(losers[0].payload.error?.request_id, /^[A-Za-z0-9_-]{8,128}$/);
    const winner = claims[0].result.isError !== true ? codex : claude;
    const loser = winner === codex ? claude : codex;
    const winnerIntegration = winner.integration;
    note(
      "concurrent claim",
      `${winnerIntegration} won; loser received TASK_ALREADY_CLAIMED (409 contract code, request ${losers[0].payload.error.request_id})`
    );

    await winner.stop("SIGKILL");
    note(
      "winner crash",
      `${winnerIntegration} MCP transport killed after claim`
    );

    let takeover;
    const waitStarted = Date.now();
    while (!takeover && Date.now() - waitStarted < 55_000) {
      await sleep(5_000);
      const response = await loser.call("claim_task", {
        task_id: taskId,
        lease_seconds: 30
      });
      if (response.result.isError !== true) takeover = response.payload;
      else assert.equal(response.payload.error?.code, "TASK_ALREADY_CLAIMED");
    }
    assert.ok(
      takeover,
      "loser did not take over after the 30-second lease expired"
    );
    await loser.success("complete_task", { task_id: taskId });
    note(
      "crash recovery",
      `loser took over after ${Math.round((Date.now() - waitStarted) / 1000)}s and completed task`
    );

    await loser.stop();
    reconnect = spawnMcp(winnerIntegration);
    await reconnect.initialize();
    if (useGlobalMcp) {
      assert.ok(reconnect.hasTool("select_project"));
      await reconnect.success("select_project", { project_id: projectId });
    }
    const reconnectedProject = await reconnect.success("get_project");
    assert.equal(reconnectedProject.id, projectId);
    const durableTask = await reconnect.success("get_task", {
      task_id: taskId
    });
    assert.equal(durableTask.status, "done");
    const durableComments = await reconnect.success("list_task_comments", {
      task_id: taskId
    });
    assert.ok(
      durableComments.comments.some((comment) => comment.id === firstComment.id)
    );
    const durableDocument = await reconnect.success("read_document", {
      document_id: documentId
    });
    assert.equal(durableDocument.revision.content, "winner content");
    const activity = await reconnect.success("get_recent_activity", {
      limit: 100
    });
    assert.ok(activity.events.length > 0);
    const eventIds = activity.events
      .map((event) => event.id)
      .filter(Number.isInteger);
    assert.ok(eventIds.length > 0);
    note(
      "reconnect durability",
      `task done, comment ${firstComment.id}, document winner content, event IDs ${Math.min(...eventIds)}..${Math.max(...eventIds)}`
    );
    note(
      "result",
      "PASS: two live MCP sessions, concurrency, idempotency, document conflict, crash lease recovery, and reconnect durability"
    );
  } finally {
    await Promise.all([...children.values()].map((stop) => stop()));
  }
}

main().catch((error) => {
  console.error(
    `FAIL: ${error instanceof Error ? error.message : "acceptance failed"}`
  );
  process.exitCode = 1;
});
