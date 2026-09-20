import { attachmentDownloadQuerySchema } from "@orchestrat/protocol";
import type { FastifyInstance } from "fastify";
import type { AttachmentService } from "../services/attachment-service.js";

export async function attachmentDownloadRoutes(
  app: FastifyInstance,
  options: {
    attachments: AttachmentService;
  }
) {
  app.get(
    "/attachments/download",
    { logLevel: "silent" },
    async (request, reply) => {
      const { ticket } = attachmentDownloadQuerySchema.parse(request.query);
      const downloaded = await options.attachments.downloadByTicket(ticket);
      reply
        .header("Cache-Control", "private, no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Type", downloaded.contentType)
        .header("Content-Disposition", downloaded.contentDisposition);
      if (downloaded.contentLength !== undefined)
        reply.header("Content-Length", String(downloaded.contentLength));
      return reply.send(downloaded.body);
    }
  );
}
