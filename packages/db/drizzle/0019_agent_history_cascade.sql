-- Agents are only ever deleted together with their project. Rows that name an
-- agent as author or actor used ON DELETE no action, which PostgreSQL checks
-- partway through the project cascade, while those rows still exist: deleting
-- any project or organization where an agent had written something failed.
-- They now cascade with the agent, as everything else in the project does.
ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_author_agent_project_fk";--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_author_agent_project_fk" FOREIGN KEY ("project_id","author_agent_id") REFERENCES "public"."agents"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" DROP CONSTRAINT "chats_creator_agent_project_fk";--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_creator_agent_project_fk" FOREIGN KEY ("project_id","creator_agent_id") REFERENCES "public"."agents"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_attachment_uploads" DROP CONSTRAINT "document_attachment_uploads_actor_agent_project_fk";--> statement-breakpoint
ALTER TABLE "document_attachment_uploads" ADD CONSTRAINT "document_attachment_uploads_actor_agent_project_fk" FOREIGN KEY ("project_id", "actor_agent_id") REFERENCES "public"."agents"("project_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_attachments" DROP CONSTRAINT "document_attachments_added_by_agent_project_fk";--> statement-breakpoint
ALTER TABLE "document_attachments" ADD CONSTRAINT "document_attachments_added_by_agent_project_fk" FOREIGN KEY ("project_id", "added_by_agent_id") REFERENCES "public"."agents"("project_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revisions" DROP CONSTRAINT "document_revisions_author_agent_project_fk";--> statement-breakpoint
ALTER TABLE "document_revisions" ADD CONSTRAINT "document_revisions_author_agent_project_fk" FOREIGN KEY ("project_id", "author_agent_id") REFERENCES "public"."agents"("project_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_created_by_agent_project_fk";--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_agent_project_fk" FOREIGN KEY ("project_id", "created_by_agent_id") REFERENCES "public"."agents"("project_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" DROP CONSTRAINT "handoffs_from_agent_project_fk";--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_from_agent_project_fk" FOREIGN KEY ("project_id","from_agent_id") REFERENCES "public"."agents"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" DROP CONSTRAINT "handoffs_to_agent_project_fk";--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_to_agent_project_fk" FOREIGN KEY ("project_id","to_agent_id") REFERENCES "public"."agents"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_branches" DROP CONSTRAINT "project_branches_created_by_agent_project_fk";--> statement-breakpoint
ALTER TABLE "project_branches" ADD CONSTRAINT "project_branches_created_by_agent_project_fk" FOREIGN KEY ("project_id","created_by_agent_id") REFERENCES "public"."agents"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_events" DROP CONSTRAINT "project_events_actor_agent_project_fk";--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_actor_agent_project_fk" FOREIGN KEY ("project_id", "actor_agent_id") REFERENCES "public"."agents"("project_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_blocks" DROP CONSTRAINT "task_blocks_blocked_on_agent_project_fk";--> statement-breakpoint
ALTER TABLE "task_blocks" ADD CONSTRAINT "task_blocks_blocked_on_agent_project_fk" FOREIGN KEY ("project_id","blocked_on_agent_id") REFERENCES "public"."agents"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_blocks" DROP CONSTRAINT "task_blocks_created_by_agent_project_fk";--> statement-breakpoint
ALTER TABLE "task_blocks" ADD CONSTRAINT "task_blocks_created_by_agent_project_fk" FOREIGN KEY ("project_id","created_by_agent_id") REFERENCES "public"."agents"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_blocks" DROP CONSTRAINT "task_blocks_resolved_by_agent_project_fk";--> statement-breakpoint
ALTER TABLE "task_blocks" ADD CONSTRAINT "task_blocks_resolved_by_agent_project_fk" FOREIGN KEY ("project_id","resolved_by_agent_id") REFERENCES "public"."agents"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" DROP CONSTRAINT "task_comments_author_agent_project_fk";--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_agent_project_fk" FOREIGN KEY ("project_id", "author_agent_id") REFERENCES "public"."agents"("project_id", "id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_created_by_agent_project_fk";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_agent_project_fk" FOREIGN KEY ("project_id", "created_by_agent_id") REFERENCES "public"."agents"("project_id", "id") ON DELETE cascade ON UPDATE no action;
