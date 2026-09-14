import { mkdir, rename } from 'node:fs/promises';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  isLidUser,
  isPnUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type BaileysEventMap,
  type ConnectionState,
  type GroupMetadata,
  type GroupParticipant,
  type WAMessage,
} from 'baileys';
import qrcode from 'qrcode-terminal';
import { baileysLogger, type Logger } from '../config/logger.js';
import type { NewMessage } from '../db/schema.js';
import { MemberSync } from './member-sync.js';
import { getIngestableContent, toNewMessage } from './message-parser.js';
import { normalizePhone, type ParticipantRecord, type StorageService } from './storage.js';

type Socket = ReturnType<typeof makeWASocket>;
type Identity = Omit<ParticipantRecord, 'isAdmin'>;

export interface WhatsAppServiceOptions {
  authDir: string;
  storage: StorageService;
  logger: Logger;
  storeRawPayload: boolean;
  reconnect: { baseDelayMs: number; maxDelayMs: number };
  memberSync: { intervalMs: number; minDelayMs: number; maxDelayMs: number };
}

function statusCodeOf(error: unknown): number | undefined {
  // Baileys wraps disconnects in @hapi/boom errors: error.output.statusCode
  const code = (error as { output?: { statusCode?: unknown } } | undefined)?.output?.statusCode;
  return typeof code === 'number' ? code : undefined;
}

export class WhatsAppService {
  private sock: Socket | null = null;
  private unsubscribe: (() => void) | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private stopping = false;

  private readonly groupCache = new Map<string, GroupMetadata>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly memberSync: MemberSync;
  private readonly log: Logger;

  constructor(private readonly opts: WhatsAppServiceOptions) {
    this.log = opts.logger.child({ module: 'whatsapp' });
    this.memberSync = new MemberSync({
      ...opts.memberSync,
      storage: opts.storage,
      logger: opts.logger.child({ module: 'member-sync' }),
      fetchAllGroups: () => this.requireSocket().groupFetchAllParticipating(),
      resolveParticipants: (group) => this.resolveParticipants(this.requireSocket(), group.participants),
      onGroupsFetched: (list) => list.forEach((g) => this.groupCache.set(g.id, g)),
    });
  }

  async start(): Promise<void> {
    await mkdir(this.opts.authDir, { recursive: true, mode: 0o700 });
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.memberSync.stop();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.teardownSocket();
    // Let pending DB writes finish before the pool closes.
    await Promise.allSettled([...this.inflight]);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    this.teardownSocket();

    // Reuses the SAME auth folder on every reconnect: no re-pairing needed.
    const { state, saveCreds } = await useMultiFileAuthState(this.opts.authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    const sock = makeWASocket({
      ...(version && { version }),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      logger: baileysLogger,
      browser: Browsers.ubuntu('Chrome'),
      // Passive profile: don't show "online", don't pull FULL history, don't render previews.
      // Do NOT override shouldSyncHistoryMessage: the initial sync carries the
      // LID -> phone number mappings, and disabling it destabilizes the session.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      // Serve group metadata from memory instead of letting Baileys query WhatsApp.
      cachedGroupMetadata: async (jid) => this.groupCache.get(jid),
    });

    this.sock = sock;
    this.unsubscribe = sock.ev.process(async (events) => {
      if (sock !== this.sock) return; // stale socket from a previous connection

      if (events['creds.update']) await saveCreds();
      if (events['connection.update']) await this.onConnectionUpdate(events['connection.update']);
      if (events['messages.upsert']) this.track(this.onMessages(sock, events['messages.upsert'].messages));
      if (events['groups.upsert']) this.track(this.onGroupsUpsert(sock, events['groups.upsert']));
      if (events['groups.update']) this.track(this.onGroupsUpdate(events['groups.update']));
      if (events['group-participants.update']) {
        this.track(this.onParticipantsUpdate(sock, events['group-participants.update']));
      }
    });
  }

  private teardownSocket(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        // already closed
      }
    }
    this.sock = null;
  }

  private async onConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.log.info('scan this QR with WhatsApp > Linked devices');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      this.attempt = 0;
      this.log.info({ user: this.sock?.user?.id }, 'connected to WhatsApp');
      await this.memberSync.schedule().catch((err) => this.log.error({ err }, 'could not schedule member sync'));
      return;
    }

    if (connection !== 'close' || this.stopping) return;

    this.memberSync.cancel();
    const code = statusCodeOf(lastDisconnect?.error);
    this.log.warn({ code, err: lastDisconnect?.error?.message }, 'connection closed');

    switch (code) {
      case DisconnectReason.restartRequired:
        // Expected right after pairing: WhatsApp asks for a fresh socket.
        return this.scheduleReconnect(0);

      case DisconnectReason.loggedOut:
        // Credentials were revoked server-side (device unlinked). Retrying with
        // them loops forever, so archive them and start a clean pairing (new QR).
        this.log.error('session logged out; archiving auth state and requesting a new QR');
        await this.archiveAuthDir();
        return this.scheduleReconnect(0);

      case DisconnectReason.connectionReplaced:
        // Another process is using the same session. Fighting it gets both kicked.
        this.log.error('session opened elsewhere; backing off to the maximum delay');
        return this.scheduleReconnect(this.opts.reconnect.maxDelayMs);

      case DisconnectReason.forbidden:
        this.log.fatal('WhatsApp returned 403 (account restricted?); backing off to the maximum delay');
        return this.scheduleReconnect(this.opts.reconnect.maxDelayMs);

      default:
        return this.scheduleReconnect(this.nextBackoff());
    }
  }

  /** Exponential backoff with "equal jitter": [exp/2, exp). */
  private nextBackoff(): number {
    const { baseDelayMs, maxDelayMs } = this.opts.reconnect;
    const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** this.attempt);
    this.attempt += 1;
    return Math.floor(exp / 2 + Math.random() * (exp / 2));
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.stopping) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    this.log.info({ delayMs, attempt: this.attempt }, 'reconnect scheduled');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        this.log.error({ err }, 'reconnect attempt failed');
        this.scheduleReconnect(this.nextBackoff());
      });
    }, delayMs);
  }

  private async archiveAuthDir(): Promise<void> {
    const target = `${this.opts.authDir}.loggedout-${Date.now()}`;
    try {
      this.teardownSocket();
      await rename(this.opts.authDir, target);
      await mkdir(this.opts.authDir, { recursive: true, mode: 0o700 });
      this.log.warn({ archivedTo: target }, 'old auth state archived');
    } catch (err) {
      this.log.error({ err }, 'could not archive auth state');
    }
  }

  // ── Event handlers (DB writes only, never extra WhatsApp requests) ─────

  private async onMessages(sock: Socket, batch: WAMessage[]): Promise<void> {
    const rows: NewMessage[] = [];

    for (const msg of batch) {
      const groupId = msg.key.remoteJid;
      if (!groupId || !isJidGroup(groupId)) continue;

      const content = getIngestableContent(msg);
      if (!content) continue;

      const sender = msg.key.fromMe
        ? await this.resolveIdentity(sock, sock.user?.id, sock.user?.lid)
        : await this.resolveIdentity(sock, msg.key.participant, msg.key.participantAlt);

      const row = toNewMessage({
        msg,
        content,
        groupId,
        senderId: sender?.id ?? 'unknown',
        storeRawPayload: this.opts.storeRawPayload,
      });
      if (row) rows.push(row);
    }

    await this.opts.storage.saveMessages(rows, (id) => this.groupCache.get(id)?.subject || null);
  }

  private async onGroupsUpsert(sock: Socket, list: GroupMetadata[]): Promise<void> {
    // Fired when the account joins/is added to a group; metadata already includes members.
    for (const group of list) {
      this.groupCache.set(group.id, group);
      const members = await this.resolveParticipants(sock, group.participants);
      await this.opts.storage.syncGroupMembers({ id: group.id, name: group.subject || null }, members);
    }
  }

  private async onGroupsUpdate(list: Partial<GroupMetadata>[]): Promise<void> {
    const renamed = list.filter((g): g is Partial<GroupMetadata> & { id: string; subject: string } =>
      Boolean(g.id && g.subject),
    );
    for (const g of renamed) {
      const cached = this.groupCache.get(g.id);
      if (cached) this.groupCache.set(g.id, { ...cached, subject: g.subject });
    }
    await this.opts.storage.upsertGroups(renamed.map((g) => ({ id: g.id, name: g.subject })));
  }

  private async onParticipantsUpdate(
    sock: Socket,
    { id: groupId, participants, action }: BaileysEventMap['group-participants.update'],
  ): Promise<void> {
    const members = await this.resolveParticipants(sock, participants);
    const ids = members.map((m) => m.id);
    const { storage } = this.opts;

    switch (action) {
      case 'add':
        return storage.addParticipants(groupId, members);
      case 'remove':
        return storage.markParticipantsLeft(groupId, ids);
      case 'promote':
        return storage.setAdmin(groupId, ids, true);
      case 'demote':
        return storage.setAdmin(groupId, ids, false);
      default:
        return;
    }
  }

  // ── Identity resolution (LID ↔ phone number) ─────────────────────────────

  private async resolveParticipants(sock: Socket, list: GroupParticipant[]): Promise<ParticipantRecord[]> {
    const out: ParticipantRecord[] = [];
    for (const p of list) {
      const identity = await this.resolveIdentity(sock, p.id, p.phoneNumber, p.lid);
      if (identity) out.push({ ...identity, isAdmin: p.admin === 'admin' || p.admin === 'superadmin' });
    }
    return out;
  }

  /**
   * WhatsApp increasingly addresses users by LID (@lid) instead of phone number.
   * Prefer a PN JID when present; otherwise ask Baileys' LOCAL lid-mapping store
   * (no network call). Fall back to `lid:<digits>` when the number is hidden.
   */
  private async resolveIdentity(sock: Socket, ...jids: (string | null | undefined)[]): Promise<Identity | null> {
    const candidates = jids.filter((j): j is string => Boolean(j));
    const lidJid = candidates.find((j) => isLidUser(j));
    let pnJid = candidates.find((j) => isPnUser(j));

    if (!pnJid && lidJid) {
      pnJid = (await sock.signalRepository.lidMapping.getPNForLID(lidJid).catch(() => null)) ?? undefined;
    }

    const pn = normalizePhone(pnJid);
    const lid = normalizePhone(lidJid);
    if (pn) return { id: pn, lid };
    if (lid) return { id: `lid:${lid}`, lid };
    return null;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private requireSocket(): Socket {
    if (!this.sock) throw new Error('WhatsApp socket not connected');
    return this.sock;
  }

  /** Fire-and-forget with error logging, tracked so shutdown can await it. */
  private track(task: Promise<unknown>): void {
    const tracked = task
      .catch((err) => this.log.error({ err }, 'event handler failed'))
      .finally(() => this.inflight.delete(tracked));
    this.inflight.add(tracked);
  }
}
