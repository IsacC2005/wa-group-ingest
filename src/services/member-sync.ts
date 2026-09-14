import type { GroupMetadata } from 'baileys';
import type { Logger } from '../config/logger.js';
import type { ParticipantRecord, StorageService } from './storage.js';

export interface MemberSyncDeps {
  /** One IQ request that returns every group the account belongs to, participants included. */
  fetchAllGroups: () => Promise<Record<string, GroupMetadata>>;
  resolveParticipants: (group: GroupMetadata) => Promise<ParticipantRecord[]>;
  onGroupsFetched: (groups: GroupMetadata[]) => void;
  storage: StorageService;
  logger: Logger;
  intervalMs: number;
  minDelayMs: number;
  maxDelayMs: number;
}

const randomBetween = (min: number, max: number) => Math.floor(min + Math.random() * (max - min));

/**
 * Soft, rate-friendly member synchronization.
 *
 * - The last sync time lives in the DB, so crash/restart loops do NOT re-trigger it.
 * - Every run starts after a random delay, so a reconnect never fires an instant burst.
 * - Between runs, membership stays fresh through passive `group-participants.update` events.
 */
export class MemberSync {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(private readonly deps: MemberSyncDeps) {}

  /** Call on every `connection: open`. Schedules the next run based on the persisted last sync. */
  async schedule(): Promise<void> {
    this.cancel();
    this.stopped = false;

    const { storage, intervalMs, minDelayMs, maxDelayMs, logger } = this.deps;
    const last = await storage.getLastMembersSync();
    const elapsed = last ? Date.now() - last.getTime() : Number.POSITIVE_INFINITY;
    const wait = Math.max(0, intervalMs - elapsed) + randomBetween(minDelayMs, maxDelayMs);

    logger.info({ lastSync: last?.toISOString() ?? null, inMs: wait }, 'member sync scheduled');
    this.timer = setTimeout(() => void this.runAndReschedule(), wait);
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  stop(): void {
    this.stopped = true;
    this.cancel();
  }

  private async runAndReschedule(): Promise<void> {
    this.timer = null;
    try {
      await this.run();
    } catch (err) {
      this.deps.logger.error({ err }, 'member sync failed');
    } finally {
      if (!this.stopped) {
        const { intervalMs, minDelayMs, maxDelayMs } = this.deps;
        this.timer = setTimeout(() => void this.runAndReschedule(), intervalMs + randomBetween(minDelayMs, maxDelayMs));
      }
    }
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const { fetchAllGroups, resolveParticipants, onGroupsFetched, storage, logger } = this.deps;

    try {
      const started = Date.now();
      const all = Object.values(await fetchAllGroups());
      onGroupsFetched(all);

      // Everything below is local (DB + local LID store): no extra WhatsApp requests.
      for (const group of all) {
        if (this.stopped) return;
        const members = await resolveParticipants(group);
        await storage.syncGroupMembers({ id: group.id, name: group.subject || null }, members);
      }

      logger.info({ groups: all.length, ms: Date.now() - started }, 'member sync completed');
    } finally {
      this.running = false;
    }
  }
}
