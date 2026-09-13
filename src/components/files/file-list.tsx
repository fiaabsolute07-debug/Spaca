import { DownloadFileButton } from './download-file-button';
import { str, type Row } from '../ui';

const size = (value: unknown) => {
  const bytes = Number(value ?? 0);
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
};

export function FileList({ files, empty }: { files: Row[]; empty?: string }) {
  if (!files.length) return empty ? <p className="muted">{empty}</p> : null;
  return <ul className="file-list">
    {files.map((file) => <li key={str(file.id)} className="file-item">
      <span className="file-name">{str(file.filename)}</span>
      <span className="muted">{size(file.size_bytes)}</span>
      {file.lifecycle_state === 'READY'
        ? <DownloadFileButton assetId={str(file.id)} />
        : <span className="badge">Held for safety review</span>}
    </li>)}
  </ul>;
}
