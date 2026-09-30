import {
  acknowledgeMessagesRequestSchema,
  allBranchesQuerySchema,
  chatMessagesQuerySchema,
  chatParamsSchema,
  createChatRequestSchema,
  manageChatMembersRequestSchema,
  projectChatParamsSchema,
  sendMessageRequestSchema
} from "@orchestrat/protocol";
import type { FastifyInstance } from "fastify";
import { humanBranchSelector } from "../services/branch-context.js";
import type { ChatService } from "../services/chat-service.js";

const key = (headers: Record<string, unknown>) =>
  headers["idempotency-key"] as string | undefined;

export async function humanChatRoutes(
  app: FastifyInstance,
  options: { chats: ChatService }
) {
  app.get("/projects/:projectId/message-candidates", (request) =>
    options.chats.listCandidatesHuman(
      request.userId,
      projectChatParamsSchema.parse(request.params).projectId
    )
  );
  app.get("/projects/:projectId/chats", (request) =>
    options.chats.listHuman(
      request.userId,
      projectChatParamsSchema.parse(request.params).projectId,
      humanBranchSelector(request.query)
    )
  );
  app.post("/projects/:projectId/chats", async (request, reply) => {
    const result = await options.chats.createHuman(
      request.userId,
      projectChatParamsSchema.parse(request.params).projectId,
      createChatRequestSchema.parse(request.body),
      key(request.headers),
      humanBranchSelector(request.query)
    );
    return reply.code(result.status).send(result.body);
  });
  app.get("/projects/:projectId/inbox", (request) =>
    options.chats.inboxHuman(
      request.userId,
      projectChatParamsSchema.parse(request.params).projectId,
      humanBranchSelector(request.query),
      allBranchesQuerySchema.parse(request.query).all_branches
    )
  );
  app.get("/chats/:id", (request) =>
    options.chats.getHuman(
      request.userId,
      chatParamsSchema.parse(request.params).id
    )
  );
  app.post("/chats/:id/members", (request) =>
    options.chats.manageHuman(
      request.userId,
      chatParamsSchema.parse(request.params).id,
      manageChatMembersRequestSchema.parse(request.body)
    )
  );
  app.post("/chats/:id/join", (request) =>
    options.chats.joinHuman(
      request.userId,
      chatParamsSchema.parse(request.params).id
    )
  );
  app.get("/chats/:id/messages", (request) =>
    options.chats.messagesHuman(
      request.userId,
      chatParamsSchema.parse(request.params).id,
      chatMessagesQuerySchema.parse(request.query)
    )
  );
  app.post("/chats/:id/messages", async (request, reply) => {
    const result = await options.chats.sendHuman(
      request.userId,
      chatParamsSchema.parse(request.params).id,
      sendMessageRequestSchema.parse(request.body),
      key(request.headers)
    );
    return reply.code(result.status).send(result.body);
  });
  app.post("/chats/:id/read", (request) =>
    options.chats.acknowledgeHuman(
      request.userId,
      chatParamsSchema.parse(request.params).id,
      acknowledgeMessagesRequestSchema.parse(request.body).through_message_id
    )
  );
}

export async function agentChatRoutes(
  app: FastifyInstance,
  options: { chats: ChatService }
) {
  app.get("/message-candidates", (request) =>
    options.chats.listCandidatesAgent(request.agentPrincipal!)
  );
  app.get("/chats", (request) =>
    options.chats.listAgent(request.agentPrincipal!)
  );
  app.post("/chats", async (request, reply) => {
    const result = await options.chats.createAgent(
      request.agentPrincipal!,
      createChatRequestSchema.parse(request.body),
      key(request.headers)
    );
    return reply.code(result.status).send(result.body);
  });
  app.get("/inbox", (request) =>
    options.chats.inboxAgent(request.agentPrincipal!)
  );
  app.get("/chats/:id", (request) =>
    options.chats.getAgent(
      request.agentPrincipal!,
      chatParamsSchema.parse(request.params).id
    )
  );
  app.post("/chats/:id/members", (request) =>
    options.chats.manageAgent(
      request.agentPrincipal!,
      chatParamsSchema.parse(request.params).id,
      manageChatMembersRequestSchema.parse(request.body)
    )
  );
  app.get("/chats/:id/messages", (request) =>
    options.chats.messagesAgent(
      request.agentPrincipal!,
      chatParamsSchema.parse(request.params).id,
      chatMessagesQuerySchema.parse(request.query)
    )
  );
  app.post("/chats/:id/messages", async (request, reply) => {
    const result = await options.chats.sendAgent(
      request.agentPrincipal!,
      chatParamsSchema.parse(request.params).id,
      sendMessageRequestSchema.parse(request.body),
      key(request.headers)
    );
    return reply.code(result.status).send(result.body);
  });
  app.post("/chats/:id/read", (request) =>
    options.chats.acknowledgeAgent(
      request.agentPrincipal!,
      chatParamsSchema.parse(request.params).id,
      acknowledgeMessagesRequestSchema.parse(request.body).through_message_id
    )
  );
}
