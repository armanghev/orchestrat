CREATE TABLE "project_members" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "organization_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);--> statement-breakpoint
CREATE TABLE "project_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_invitations_token_hash_not_blank" CHECK (btrim("token_hash") <> ''),
	CONSTRAINT "project_invitations_acceptance_consistent" CHECK (("accepted_at" is null and "accepted_by" is null) or ("accepted_at" is not null and "accepted_by" is not null))
);--> statement-breakpoint
INSERT INTO "project_members" ("project_id", "user_id", "role", "created_at")
SELECT "projects"."id", "organization_members"."user_id", "organization_members"."role", "organization_members"."created_at"
FROM "projects"
INNER JOIN "organization_members" ON "organization_members"."organization_id" = "projects"."organization_id"
ON CONFLICT ("project_id", "user_id") DO NOTHING;--> statement-breakpoint
CREATE TABLE "chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"direct_key" text,
	"has_human" boolean DEFAULT false NOT NULL,
	"creator_type" "document_author_type" NOT NULL,
	"creator_user_id" uuid,
	"creator_agent_id" uuid,
	"last_sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chats_project_id_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "chats_kind_consistent" CHECK (("kind" = 'direct' and "direct_key" is not null and "name" is null) or ("kind" = 'group' and "direct_key" is null and "name" is not null and btrim("name") <> '')),
	CONSTRAINT "chats_creator_consistent" CHECK (("creator_type" = 'human' and "creator_user_id" is not null and "creator_agent_id" is null) or ("creator_type" = 'agent' and "creator_agent_id" is not null and "creator_user_id" is null)),
	CONSTRAINT "chats_last_sequence_nonnegative" CHECK ("last_sequence" >= 0)
);--> statement-breakpoint
CREATE TABLE "chat_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"user_id" uuid,
	"agent_id" uuid,
	"last_read_sequence" integer DEFAULT 0 NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_participants_user_unique" UNIQUE("chat_id","user_id"),
	CONSTRAINT "chat_participants_agent_unique" UNIQUE("chat_id","agent_id"),
	CONSTRAINT "chat_participants_actor_consistent" CHECK (("user_id" is not null and "agent_id" is null) or ("agent_id" is not null and "user_id" is null)),
	CONSTRAINT "chat_participants_read_nonnegative" CHECK ("last_read_sequence" >= 0)
);--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"chat_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"author_type" "document_author_type" NOT NULL,
	"author_user_id" uuid,
	"author_agent_id" uuid,
	"author_name" text NOT NULL,
	"body_markdown" text NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"document_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_sequence_unique" UNIQUE("chat_id","sequence"),
	CONSTRAINT "chat_messages_author_consistent" CHECK (("author_type" = 'human' and "author_user_id" is not null and "author_agent_id" is null) or ("author_type" = 'agent' and "author_agent_id" is not null and "author_user_id" is null)),
	CONSTRAINT "chat_messages_body_not_blank" CHECK (btrim("body_markdown") <> ''),
	CONSTRAINT "chat_messages_sequence_positive" CHECK ("sequence" > 0)
);--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_creator_user_id_users_id_fk" FOREIGN KEY ("creator_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_creator_agent_project_fk" FOREIGN KEY ("project_id","creator_agent_id") REFERENCES "public"."agents"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_chat_project_fk" FOREIGN KEY ("project_id","chat_id") REFERENCES "public"."chats"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_agent_project_fk" FOREIGN KEY ("project_id","agent_id") REFERENCES "public"."agents"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_user_project_fk" FOREIGN KEY ("project_id","user_id") REFERENCES "public"."project_members"("project_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_chat_project_fk" FOREIGN KEY ("project_id","chat_id") REFERENCES "public"."chats"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_author_agent_project_fk" FOREIGN KEY ("project_id","author_agent_id") REFERENCES "public"."agents"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_members_user_idx" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_invitations_token_unique" ON "project_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "project_invitations_project_idx" ON "project_invitations" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chats_direct_pair_unique" ON "chats" USING btree ("project_id","direct_key");--> statement-breakpoint
CREATE INDEX "chats_project_updated_idx" ON "chats" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE INDEX "chat_participants_project_chat_idx" ON "chat_participants" USING btree ("project_id","chat_id");--> statement-breakpoint
CREATE INDEX "chat_participants_user_idx" ON "chat_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_participants_agent_idx" ON "chat_participants" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "chat_messages_project_chat_sequence_idx" ON "chat_messages" USING btree ("project_id","chat_id","sequence");
