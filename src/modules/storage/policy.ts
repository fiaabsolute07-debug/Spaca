/**
 * Upload policy (master §4.4): MIME allowlist tied to extensions and file signatures, per-kind size limits,
 * and server-generated object keys. Markup (HTML/SVG/XML) is never accepted, whatever it claims to be.
 */
export type AssetPurpose = 'DELIVERY' | 'BRIEF' | 'DISPUTE' | 'SAMPLE' | 'DIGITAL' | 'AVATAR';
export type StorageBucket = 'public-portfolio' | 'private-briefs' | 'private-deliverables' | 'private-disputes' | 'private-products' | 'public-avatars' | 'private-quarantine';
type AssetKind = 'image' | 'document' | 'video' | 'archive';
type Signature = 'png' | 'jpeg' | 'gif' | 'webp' | 'pdf' | 'zip' | 'isobmff' | 'ebml' | 'markup' | 'unknown';

export const ASSET_PURPOSES: readonly AssetPurpose[] = ['DELIVERY', 'BRIEF', 'DISPUTE', 'SAMPLE', 'DIGITAL', 'AVATAR'];
export const BUCKET_FOR_PURPOSE: Readonly<Record<AssetPurpose, StorageBucket>> = {
  DELIVERY: 'private-deliverables',
  BRIEF: 'private-briefs',
  DISPUTE: 'private-disputes',
  SAMPLE: 'public-portfolio',
  // XPL-06: product files are private; buyers reach them only through an active entitlement.
  DIGITAL: 'private-products',
  // Profile photos are shown publicly through /api/avatars/[id] while a profile uses them.
  AVATAR: 'public-avatars',
};
export const QUARANTINE_BUCKET: StorageBucket = 'private-quarantine';
export const MAX_ASSETS_PER_DELIVERY = 10;
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;
/** Finalize must follow the upload; after this grace the intent is abandoned and its object removed. */
export const FINALIZE_GRACE_SECONDS = 60 * 60;
export const MAX_OPEN_INTENTS_PER_HOUR = 30;
export const SCAN_ENGINE = 'local-signature-v1';

type TypeRule = { extensions: readonly string[]; kind: AssetKind; signature: Signature };
const TYPES: Readonly<Record<string, TypeRule>> = {
  'image/png': { extensions: ['png'], kind: 'image', signature: 'png' },
  'image/jpeg': { extensions: ['jpg', 'jpeg'], kind: 'image', signature: 'jpeg' },
  'image/gif': { extensions: ['gif'], kind: 'image', signature: 'gif' },
  'image/webp': { extensions: ['webp'], kind: 'image', signature: 'webp' },
  'application/pdf': { extensions: ['pdf'], kind: 'document', signature: 'pdf' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { extensions: ['docx'], kind: 'document', signature: 'zip' },
  'video/mp4': { extensions: ['mp4', 'm4v'], kind: 'video', signature: 'isobmff' },
  'video/quicktime': { extensions: ['mov'], kind: 'video', signature: 'isobmff' },
  'video/webm': { extensions: ['webm'], kind: 'video', signature: 'ebml' },
  'application/zip': { extensions: ['zip'], kind: 'archive', signature: 'zip' },
};

const PURPOSE_KINDS: Readonly<Record<AssetPurpose, readonly AssetKind[]>> = {
  DELIVERY: ['image', 'document', 'video'],
  BRIEF: ['image', 'document'],
  DISPUTE: ['image', 'document', 'video'],
  SAMPLE: ['image', 'document', 'video'],
  // Templates, code and presets usually ship as a zip; archives are accepted only as product files.
  DIGITAL: ['image', 'document', 'video', 'archive'],
  AVATAR: ['image'],
};

const MB = 1024 * 1024;
function limitFor(kind: AssetKind): number {
  const defaults: Record<AssetKind, number> = { image: 10 * MB, document: 25 * MB, video: 250 * MB, archive: 100 * MB };
  const configured = Number(process.env[`STORAGE_MAX_${kind.toUpperCase()}_BYTES`] ?? '');
  return Number.isSafeInteger(configured) && configured > 0 ? Math.min(configured, defaults[kind]) : defaults[kind];
}

export class UploadPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadPolicyError';
  }
}

/** Strips directories, control characters and anything outside a conservative set; never trusted for the key. */
export function sanitizeFilename(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? '';
  const cleaned = [...base.normalize('NFC')].filter((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f).join('')
    .replace(/[^\p{L}\p{N} ._()-]/gu, '_').replace(/^[.\s]+/, '').trim();
  return cleaned.slice(-180);
}

export type ValidatedUpload = { purpose: AssetPurpose; mime: string; extension: string; size: number; filename: string; maxBytes: number; bucket: StorageBucket };

export function validateDeclaredUpload(input: { purpose: string; filename: string; mime: string; size: number }): ValidatedUpload {
  if (!ASSET_PURPOSES.includes(input.purpose as AssetPurpose)) throw new UploadPolicyError('Unsupported upload purpose');
  const purpose = input.purpose as AssetPurpose;
  const mime = input.mime.trim().toLowerCase();
  const rule = TYPES[mime];
  if (!rule || !PURPOSE_KINDS[purpose].includes(rule.kind)) throw new UploadPolicyError('This file type is not accepted here');
  const filename = sanitizeFilename(input.filename);
  const extension = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  if (!filename || !rule.extensions.includes(extension)) throw new UploadPolicyError(`The file extension must match ${mime}`);
  const maxBytes = limitFor(rule.kind);
  if (!Number.isSafeInteger(input.size) || input.size <= 0) throw new UploadPolicyError('File size is required');
  if (input.size > maxBytes) throw new UploadPolicyError(`Files of this type are limited to ${Math.floor(maxBytes / MB)} MB`);
  return { purpose, mime, extension: rule.extensions[0]!, size: input.size, filename, maxBytes, bucket: BUCKET_FOR_PURPOSE[purpose] };
}

export function objectKeyFor(purpose: AssetPurpose, ownerId: string, intentId: string, extension: string): string {
  return `${purpose.toLowerCase()}/${ownerId}/${intentId}.${extension}`;
}

const ascii = (bytes: Uint8Array, start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));

export function detectSignature(head: Uint8Array): Signature {
  const startsWith = (...values: number[]) => values.every((value, index) => head[index] === value);
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (startsWith(0xff, 0xd8, 0xff)) return 'jpeg';
  if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') return 'gif';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return 'webp';
  if (ascii(head, 0, 5) === '%PDF-') return 'pdf';
  if (startsWith(0x50, 0x4b, 0x03, 0x04)) return 'zip';
  if (ascii(head, 4, 4) === 'ftyp') return 'isobmff';
  if (startsWith(0x1a, 0x45, 0xdf, 0xa3)) return 'ebml';
  // Markup, with or without a UTF-8/UTF-16 BOM and leading whitespace.
  const text = new TextDecoder('utf-8', { fatal: false }).decode(head.subarray(0, 512)).replace(/^[﻿￾\s\0]+/, '').toLowerCase();
  if (/^<(?:!doctype|html|svg|\?xml|script|body|head|iframe|!--)/.test(text)) return 'markup';
  return 'unknown';
}

export type SignatureVerdict = { ok: true } | { ok: false; detail: string };

/** Signature must match the declared type; mismatches and markup are quarantined, never served. */
export function verifySignature(mime: string, head: Uint8Array): SignatureVerdict {
  const rule = TYPES[mime];
  const detected = detectSignature(head);
  if (!rule) return { ok: false, detail: `type ${mime} not allowed` };
  if (detected === rule.signature) return { ok: true };
  return { ok: false, detail: `declared ${mime}, content looks like ${detected}` };
}
