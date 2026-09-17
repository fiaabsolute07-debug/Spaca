'use client';

import { useState } from 'react';
import styles from './item-media.module.css';

/**
 * A listing's pictures: the chosen one large, the rest as small buttons underneath (their card copies). Pictures load
 * through /api/item-images, which serves them only while the listing is visible.
 */
export function ItemGallery({ title, images }: { title: string; images: { id: string; thumbId: string | null }[] }) {
  const [current, setCurrent] = useState(0);
  const shown = images[Math.min(current, images.length - 1)]!;
  return <div className={styles.gallery}>
    <div className={styles.galleryMain}>
      {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed redirect, not a static asset */}
      <img src={`/api/item-images/${shown.id}`} alt={`${title}, picture ${current + 1} of ${images.length}`} />
    </div>
    {images.length > 1 && <div className={styles.galleryThumbs} role="group" aria-label="Pictures">
      {images.map((image, index) => <button key={image.id} type="button" className={styles.galleryThumb} aria-pressed={index === current}
        aria-label={`Show picture ${index + 1}`} onClick={() => setCurrent(index)}>
        {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed redirect, not a static asset */}
        <img src={`/api/item-images/${image.thumbId ?? image.id}`} alt="" loading="lazy" />
      </button>)}
    </div>}
  </div>;
}
