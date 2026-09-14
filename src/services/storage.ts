import { jidDecode } from 'baileys';
import { and, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { Logger } from '../config/logger.js';
import type { Database } from '../db/client.js';
import { groups, messages, participants, type NewMessage } from '../db/schema.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface GroupRecord {
  id: string;
  name: string | null;
}

export interface ParticipantRecord {
  /** Clean phone digits, or `lid:<digits>` when the number is hidden. */
  id: string;
  lid: string | null;
  isAdmin: boolean;
}

/**
 * Turns any WhatsApp JID into a clean identifier:
 *   "5491122334455:12@s.whatsapp.net" -> "5491122334455"
 *   "+54 9 11 2233-4455"               -> "5491122334455"
 * Device suffixes (":12") and server suffixes ("@s.whatsapp.net", "@lid") are dropped.
 */
export function normalizePhone(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const user = jidDecode(jid)?.user ?? jid.split('@')[0] ?? '';
  const digits = user.split(':')[0]?.replace(/\D/g, '') ?? '';
  return digits.length > 0 ? digits : null;
}

/** ON CONFLICT DO UPDATE fails if the same key appears twice in one statement, so dedupe first. */
function dedupeById<T extends { id: string }>(rows: T[], merge: (prev: T, next: T) => T = (_, n) => n): T[] {
  const byId = new Map<string, T>();
  for (const row of rows) {
    const prev = byId.get(row.id);
    byId.set(row.id, prev ? merge(prev, row) : row);
  }
  return [...byId.values()];
}

export class StorageService {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  async upsertGroups(records: GroupRecord[]): Promise<void> {
    const rows = dedupeById(records);
    if (rows.length === 0) return;

    await this.db
      .insert(groups)
      .values(rows)
      .onConflictDoUpdate({
        target: groups.id,
        set: { name: sql`coalesce(excluded.name, ${groups.name})`, updatedAt: sql`now()` },
      });
  }

  /**
   * Inserts a batch of messages. Unknown groups get a stub row first (FK), and
   * duplicates (reconnect replays, append + notify) are silently ignored.
   */
  async saveMessages(rows: NewMessage[], nameOf: (groupId: string) => string | null): Promise<number> {
    if (rows.length === 0) return 0;

    const inserted = await this.db.transaction(async (tx) => {
      const groupIds = [...new Set(rows.map((r) => r.groupId))];
      await tx
        .insert(groups)
        .values(groupIds.map((id) => ({ id, name: nameOf(id) })))
        .onConflictDoNothing();

      return tx.insert(messages).values(rows).onConflictDoNothing().returning({ id: messages.id });
    });

    this.logger.debug({ received: rows.length, inserted: inserted.length }, 'messages stored');
    return inserted.length;
  }

  /**
   * Full reconciliation of one group's member list:
   * upsert current members, mark missing ones as left, stamp the sync time.
   */
  async syncGroupMembers(group: GroupRecord, members: ParticipantRecord[]): Promise<void> {
    const current = dedupeById(members, (a, b) => ({ ...b, isAdmin: a.isAdmin || b.isAdmin, lid: b.lid ?? a.lid }));
    const now = new Date();

    await this.db.transaction(async (tx) => {
      await tx
        .insert(groups)
        .values({ ...group, membersSyncedAt: now })
        .onConflictDoUpdate({
          target: groups.id,
          set: {
            name: sql`coalesce(excluded.name, ${groups.name})`,
            membersSyncedAt: now,
            updatedAt: now,
          },
        });

      await this.upsertParticipants(tx, group.id, current);

      await tx
        .update(participants)
        .set({ leftAt: now })
        .where(
          and(
            eq(participants.groupId, group.id),
            isNull(participants.leftAt),
            current.length > 0 ? notInArray(participants.id, current.map((m) => m.id)) : undefined,
          ),
        );
    });

    this.logger.debug({ groupId: group.id, members: current.length }, 'group members synced');
  }

  /** Incremental add (from `group-participants.update`), no reconciliation. */
  async addParticipants(groupId: string, members: ParticipantRecord[]): Promise<void> {
    const rows = dedupeById(members);
    if (rows.length === 0) return;

    await this.db.transaction(async (tx) => {
      await tx.insert(groups).values({ id: groupId, name: null }).onConflictDoNothing();
      await this.upsertParticipants(tx, groupId, rows);
    });
  }

  async markParticipantsLeft(groupId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(participants)
      .set({ leftAt: new Date() })
      .where(and(eq(participants.groupId, groupId), inArray(participants.id, ids), isNull(participants.leftAt)));
  }

  async setAdmin(groupId: string, ids: string[], isAdmin: boolean): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(participants)
      .set({ isAdmin })
      .where(and(eq(participants.groupId, groupId), inArray(participants.id, ids)));
  }

  /** Most recent member sync across all groups, or null if never synced. */
  async getLastMembersSync(): Promise<Date | null> {
    const [row] = await this.db
      .select({ last: sql<string | null>`max(${groups.membersSyncedAt})` })
      .from(groups);
    return row?.last ? new Date(row.last) : null;
  }

  private async upsertParticipants(tx: Tx, groupId: string, members: ParticipantRecord[]): Promise<void> {
    if (members.length === 0) return;

    await tx
      .insert(participants)
      .values(members.map((m) => ({ groupId, id: m.id, lid: m.lid, isAdmin: m.isAdmin })))
      .onConflictDoUpdate({
        target: [participants.groupId, participants.id],
        set: {
          isAdmin: sql`excluded.is_admin`,
          lid: sql`coalesce(excluded.lid, ${participants.lid})`,
          // A member who left and came back gets a fresh joined_at.
          joinedAt: sql`case when ${participants.leftAt} is not null then now() else ${participants.joinedAt} end`,
          leftAt: null,
        },
      });
  }
}
