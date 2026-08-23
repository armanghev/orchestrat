import type { FastifyInstance } from "fastify";
import {
  cliSetupIntegrationSchema,
  projectTaskParamsSchema
} from "@orchestrat/protocol";
import type { CliSetupService } from "../services/cli-setup-service.js";
export async function cliSetupRoutes(
  app: FastifyInstance,
  options: { setup: CliSetupService }
) {
  app.get("/cli/setup/project", async (request) => {
    const token =
      typeof request.headers.authorization === "string"
        ? (/^Bearer\s+(.+)$/.exec(request.headers.authorization)?.[1] ?? "")
        : "";
    return options.setup.project(token);
  });
  app.post("/cli/setup", async (request) => {
    const auth = request.headers.authorization;
    const token =
      typeof auth === "string" ? (/^Bearer\s+(.+)$/.exec(auth)?.[1] ?? "") : "";
    const body = request.body as {
      project_id?: unknown;
      integration?: unknown;
    };
    const projectId = projectTaskParamsSchema.shape.projectId.parse(
      body?.project_id
    );
    const integration = cliSetupIntegrationSchema.parse(body?.integration);
    return options.setup.setup(token ?? "", projectId, integration);
  });
}
