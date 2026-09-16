'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Purpose = 'DELIVERY' | 'BRIEF' | 'DISPUTE' | 'SAMPLE' | 'DIGITAL' | 'AVATAR' | 'REQUEST_IMAGE';
type Item = { key: string; name: string; state: 'uploading' | 'ready' | 'failed'; id?: string; thumbId?: string; message?: string; preview?: string };

const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  zip: 'application/zip',
};
export const ACCEPTED_FILES = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.docx,.mp4,.m4v,.mov,.webm';
const ACCEPTED_IMAGES = '.png,.jpg,.jpeg,.gif,.webp';
/** Image-only uploads get the image picker and a local thumbnail while they upload. */
const IMAGE_ONLY = new Set<Purpose>(['AVATAR', 'REQUEST_IMAGE']);
/** Campaign cards are a few hundred pixels wide, so a card never needs the buyer's full-size upload. */
const THUMB_MAX_PX = 640;
const THUMB_SKIP_BYTES = 120_000;

/**
 * A small JPEG copy of an image, made in the browser. There is no image library on the server, so this is where a
 * campaign thumbnail can come from at all; if the browser cannot do it, the campaign simply shows the original.
 */
async function thumbnailOf(file: File): Promise<File | null> {
  if (!file.type.startsWith('image/')) return null;
  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, THUMB_MAX_PX / longest);
    if (scale === 1 && file.size <= THUMB_SKIP_BYTES) return (bitmap.close(), null);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) return (bitmap.close(), null);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
    if (!blob || blob.size >= file.size) return null;
    return new File([blob], `thumb-${file.name.replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' });
  } catch {
    return null;
  }
}

async function errorOf(response: Response) {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Upload failed (${response.status})`;
}

/**
 * Upload intent → direct PUT to the signed URL → finalize. Ready file ids go into a hidden `name` input for the
 * surrounding command form; with `refreshOnReady` the page reloads its server data instead (brief/dispute files).
 */
export function FileUploadField({ purpose, orderId, name = 'asset_ids', label, help, maxFiles = 10, refreshOnReady = false }: {
  purpose: Purpose;
  orderId?: string;
  name?: string;
  label: string;
  help?: string;
  maxFiles?: number;
  refreshOnReady?: boolean;
}) {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);
  const wrapper = useRef<HTMLDivElement>(null);
  const busy = items.some((item) => item.state === 'uploading');
  const readyItems = items.filter((item) => item.state === 'ready' && item.id);
  const ready = readyItems.map((item) => item.id!);
  // Campaign cards load the small copy; everything else keeps a single file per upload.
  const withThumbnails = purpose === 'REQUEST_IMAGE';

  useEffect(() => {
    const form = wrapper.current?.closest('form');
    if (!form) return;
    const guard = (event: SubmitEvent) => {
      if (busy) {
        event.preventDefault();
        window.alert('Wait for the files to finish uploading.');
      }
    };
    form.addEventListener('submit', guard);
    return () => form.removeEventListener('submit', guard);
  }, [busy]);

  const update = (key: string, patch: Partial<Item>) => setItems((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));

  /** Upload intent → direct PUT → finalize. Returns the stored asset id, or an error message to show on the row. */
  async function upload(file: File): Promise<{ id: string } | { error: string }> {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    // Browsers label zips inconsistently (application/x-zip-compressed); the server checks the signature anyway.
    const mime = (extension === 'zip' ? EXTENSION_TYPES.zip : file.type) || EXTENSION_TYPES[extension] || 'application/octet-stream';
    const intent = await fetch('/api/assets/upload-intents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ purpose, filename: file.name, mime, size: file.size, order_id: orderId ?? '' }),
    });
    if (!intent.ok) return { error: await errorOf(intent) };
    const created = (await intent.json()) as { id: string; upload: { url: string; method: string; headers: Record<string, string> } };
    const put = await fetch(created.upload.url, { method: created.upload.method, headers: created.upload.headers, body: file });
    if (!put.ok) return { error: await errorOf(put) };
    const finalized = await fetch(`/api/assets/${created.id}/finalize`, { method: 'POST', headers: { accept: 'application/json' } });
    if (!finalized.ok) return { error: await errorOf(finalized) };
    return { id: created.id };
  }

  async function send(file: File, key: string) {
    try {
      const result = await upload(file);
      if ('error' in result) return update(key, { state: 'failed', message: result.error });
      // The thumbnail is an optimization, never a reason to fail an upload the buyer already made.
      let thumbId: string | undefined;
      if (withThumbnails) {
        const small = await thumbnailOf(file);
        const stored = small ? await upload(small) : null;
        if (stored && 'id' in stored) thumbId = stored.id;
      }
      update(key, { state: 'ready', id: result.id, thumbId });
      if (refreshOnReady) router.refresh();
    } catch {
      update(key, { state: 'failed', message: 'Network error while uploading' });
    }
  }

  function choose(files: FileList | null) {
    const room = Math.max(0, maxFiles - items.filter((item) => item.state !== 'failed').length);
    const picked = [...(files ?? [])].slice(0, room);
    const added = picked.map((file) => ({ key: crypto.randomUUID(), name: file.name, state: 'uploading' as const, preview: IMAGE_ONLY.has(purpose) ? URL.createObjectURL(file) : undefined }));
    setItems((current) => [...current, ...added]);
    picked.forEach((file, index) => void send(file, added[index]!.key));
  }

  return <div className="field file-field" ref={wrapper}>
    <span>{label}</span>
    {!refreshOnReady && <input type="hidden" name={name} value={ready.join(',')} />}
    {!refreshOnReady && withThumbnails && <input type="hidden" name="thumb_ids" value={readyItems.map((item) => item.thumbId ?? '').join(',')} />}
    <input type="file" multiple={maxFiles > 1} accept={IMAGE_ONLY.has(purpose) ? ACCEPTED_IMAGES : purpose === 'DIGITAL' ? `${ACCEPTED_FILES},.zip` : ACCEPTED_FILES} onChange={(event) => { choose(event.target.files); event.target.value = ''; }} />
    {help && <small>{help}</small>}
    {items.length > 0 && <ul className="file-list" aria-live="polite">
      {items.map((item) => <li key={item.key} className={`file-item file-${item.state}`}>
        {item.preview && <img className="file-thumb" src={item.preview} alt="" width={44} height={44} />}
        <span className="file-name">{item.name}</span>
        <span className="muted">{item.state === 'uploading' ? 'Uploading…' : item.state === 'ready' ? 'Ready' : item.message}</span>
        {item.state !== 'uploading' && !refreshOnReady && <button type="button" className="plain-button" onClick={() => setItems((current) => current.filter((other) => other.key !== item.key))}>Remove</button>}
      </li>)}
    </ul>}
  </div>;
}
