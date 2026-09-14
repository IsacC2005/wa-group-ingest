CREATE TABLE "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"members_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" text NOT NULL,
	"group_id" text NOT NULL,
	"lid" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "participants_group_id_id_pk" PRIMARY KEY("group_id","id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text NOT NULL,
	"group_id" text NOT NULL,
	"sender_id" text NOT NULL,
	"text_content" text,
	"has_media" boolean DEFAULT false NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"raw_payload" jsonb,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_group_id_id_pk" PRIMARY KEY("group_id","id")
);
--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "messages_group_ts_idx" ON "messages" USING btree ("group_id","timestamp");
--> statement-breakpoint
CREATE INDEX "messages_sender_idx" ON "messages" USING btree ("sender_id");
