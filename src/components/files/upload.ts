export type UploadPurpose = 'DELIVERY' | 'BRIEF' | 'DISPUTE' | 'SAMPLE' | 'DIGITAL' | 'AVATAR' | 'REQUEST_IMAGE';

const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  zip: 'application/zip',
};

async function errorOf(response: Response) {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Upload failed (${response.status})`;
}

/** Upload intent → direct PUT to the signed URL → finalize. Returns the stored asset id, or an error message to show. */
export async function uploadFile(purpose: UploadPurpose, file: File, orderId?: string): Promise<{ id: string } | { error: string }> {
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
