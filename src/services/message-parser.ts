import { BufferJSON, getContentType, normalizeMessageContent, type proto, type WAMessage } from 'baileys';
import type { NewMessage } from '../db/schema.js';

const MEDIA_KEYS = [
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
] as const satisfies readonly (keyof proto.IMessage)[];

/** Content types that carry no analytical value on their own (edits/deletes/reactions). */
const SKIPPED_TYPES = new Set<keyof proto.IMessage>(['protocolMessage', 'reactionMessage']);

/**
 * Unwraps ephemeral / view-once / document-with-caption wrappers and returns
 * the inner content, or null when the message should not be ingested.
 */
export function getIngestableContent(msg: WAMessage): proto.IMessage | null {
  const content = normalizeMessageContent(msg.message);
  const type = getContentType(content);
  if (!content || !type || SKIPPED_TYPES.has(type)) return null;
  return content;
}

export function extractText(content: proto.IMessage): string | null {
  return (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    content.pollCreationMessage?.name ??
    null
  );
}

export function hasMedia(content: proto.IMessage): boolean {
  return MEDIA_KEYS.some((key) => content[key] != null);
}

/**
 * Baileys messages contain Buffers, Uint8Arrays and protobuf Longs.
 * BufferJSON turns binary into base64; we also strip NUL chars because
 * PostgreSQL JSONB rejects "\u0000" inside strings.
 */
export function toJsonPayload(msg: WAMessage): unknown {
  const json = JSON.stringify(msg, (key, value: unknown) => {
    const out: unknown = BufferJSON.replacer(key, value);
    return typeof out === 'string' ? out.replaceAll('\u0000', '') : out;
  });
  return JSON.parse(json);
}

export function toNewMessage(params: {
  msg: WAMessage;
  content: proto.IMessage;
  groupId: string;
  senderId: string;
  storeRawPayload: boolean;
}): NewMessage | null {
  const { msg, content, groupId, senderId, storeRawPayload } = params;
  if (!msg.key.id) return null;

  // messageTimestamp may be a number or a protobuf Long; Number() handles both.
  const seconds = Number(msg.messageTimestamp ?? 0) || Math.floor(Date.now() / 1000);

  return {
    id: msg.key.id,
    groupId,
    senderId,
    textContent: extractText(content),
    hasMedia: hasMedia(content),
    timestamp: new Date(seconds * 1000),
    rawPayload: storeRawPayload ? toJsonPayload(msg) : null,
  };
}
