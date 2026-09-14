import { boolean, index, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

const tstz = (name: string) => timestamp(name, { withTimezone: true });

export const groups = pgTable('groups', {
  /** Group JID, e.g. 120363012345678901@g.us */
  id: text('id').primaryKey(),
  name: text('name'),
  /** Last successful member sync; drives the "once a day" policy across restarts. */
  membersSyncedAt: tstz('members_synced_at'),
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});

export const participants = pgTable(
  'participants',
  {
    /** Clean phone number (digits only) or `lid:<digits>` when WhatsApp hides the number. */
    id: text('id').notNull(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    /** LID (privacy identifier) digits, when known. */
    lid: text('lid'),
    isAdmin: boolean('is_admin').notNull().default(false),
    /** First time this daemon saw the member (WhatsApp does not expose the real join date). */
    joinedAt: tstz('joined_at').notNull().defaultNow(),
    /** Set when the member disappears from the group; cleared if they come back. */
    leftAt: tstz('left_at'),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.id] })],
);

export const messages = pgTable(
  'messages',
  {
    /** WhatsApp message ID (unique per chat, not globally). */
    id: text('id').notNull(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    senderId: text('sender_id').notNull(),
    textContent: text('text_content'),
    hasMedia: boolean('has_media').notNull().default(false),
    timestamp: tstz('timestamp').notNull(),
    rawPayload: jsonb('raw_payload'),
    ingestedAt: tstz('ingested_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.id] }),
    index('messages_group_ts_idx').on(t.groupId, t.timestamp),
    index('messages_sender_idx').on(t.senderId),
  ],
);

export type NewMessage = typeof messages.$inferInsert;
export type NewParticipant = typeof participants.$inferInsert;
