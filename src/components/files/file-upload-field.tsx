'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

type Purpose = 'DELIVERY' | 'BRIEF' | 'DISPUTE' | 'SAMPLE' | 'DIGITAL' | 'AVATAR' | 'REQUEST_IMAGE';
type Item = { key: string; name: string; state: 'uploading' | 'ready' | 'failed'; id?: string; message?: string; preview?: string };

const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  zip: 'application/zip',
};
export const ACCEPTED_FILES = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.docx,.mp4,.m4v,.mov,.webm';
const ACCEPTED_IMAGES = '.png,.jpg,.jpeg,.gif,.webp';
/** Image-only uploads get the image picker and a local thumbnail while they upload. */
const IMAGE_ONLY = new Set<Purpose>(['AVATAR', 'REQUEST_IMAGE']);

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
  const ready = items.filter((item) => item.state === 'ready' && item.id).map((item) => item.id!);

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

  async function send(file: File, key: string) {
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    // Browsers label zips inconsistently (application/x-zip-compressed); the server checks the signature anyway.
    const mime = (extension === 'zip' ? EXTENSION_TYPES.zip : file.type) || EXTENSION_TYPES[extension] || 'application/octet-stream';
    try {
      const intent = await fetch('/api/assets/upload-intents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ purpose, filename: file.name, mime, size: file.size, order_id: orderId ?? '' }),
      });
      if (!intent.ok) return update(key, { state: 'failed', message: await errorOf(intent) });
      const created = (await intent.json()) as { id: string; upload: { url: string; method: string; headers: Record<string, string> } };
      const put = await fetch(created.upload.url, { method: created.upload.method, headers: created.upload.headers, body: file });
      if (!put.ok) return update(key, { state: 'failed', message: await errorOf(put) });
      const finalized = await fetch(`/api/assets/${created.id}/finalize`, { method: 'POST', headers: { accept: 'application/json' } });
      if (!finalized.ok) return update(key, { state: 'failed', message: await errorOf(finalized) });
      update(key, { state: 'ready', id: created.id });
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
