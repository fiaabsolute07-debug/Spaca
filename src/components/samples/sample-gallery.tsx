import { str } from '../ui';

type Sample = Record<string, unknown>;

/** What a sample actually is, so a page can show the work itself instead of a link pointing at it. */
export function sampleMedia(sample: Sample): { assetId: string; mime: string; kind: 'image' | 'video' | 'file' } | null {
  const assetId = sample.storage_asset_id ? String(sample.storage_asset_id) : null;
  if (!assetId) return null;
  const mime = str(sample.asset_mime);
  return { assetId, mime, kind: mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file' };
}

function SampleTile({ sample }: { sample: Sample }) {
  const media = sampleMedia(sample);
  const title = str(sample.title, 'Work sample');
  const description = str(sample.description);
  const link = str(sample.url);
  return <figure className="sample-tile">
    <div className="sample-frame">
      {media?.kind === 'image'
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed redirect, not a static asset
        ? <img src={`/api/samples/${media.assetId}`} alt={title} loading="lazy" />
        : media?.kind === 'video'
          ? <video src={`/api/samples/${media.assetId}`} controls preload="metadata" playsInline aria-label={title} />
          : <a className="sample-placeholder" href={media ? `/api/samples/${media.assetId}` : link} target="_blank" rel="noreferrer nofollow">
            {media ? 'Open the file' : 'Open the post'} ›
          </a>}
    </div>
    <figcaption>
      <strong>{title}</strong>
      {description && <span className="muted">{description}</span>}
      {media && link ? <a className="text-link" href={link} target="_blank" rel="noreferrer nofollow">Where it ran ›</a> : null}
    </figcaption>
  </figure>;
}

/** Work samples as the work: images and video play in place, files and posts keep a link. */
export function SampleGallery({ samples, label }: { samples: Sample[]; label?: string }) {
  if (!samples.length) return null;
  return <div className="sample-gallery" aria-label={label}>
    {samples.map((sample) => <SampleTile key={str(sample.id, str(sample.url))} sample={sample} />)}
  </div>;
}
