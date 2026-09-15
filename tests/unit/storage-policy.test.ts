import { describe, expect, it } from 'vitest';
import { detectSignature, sanitizeFilename, validateDeclaredUpload, verifySignature } from '@/modules/storage/policy';

const bytes = (...values: (number | string)[]) =>
  new Uint8Array(values.flatMap((value) => (typeof value === 'string' ? [...new TextEncoder().encode(value)] : [value])));

describe('storage upload policy', () => {
  it('detects file signatures and markup regardless of BOM or whitespace', () => {
    expect(detectSignature(bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))).toBe('png');
    expect(detectSignature(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
    expect(detectSignature(bytes('RIFF', 0, 0, 0, 0, 'WEBP'))).toBe('webp');
    expect(detectSignature(bytes('%PDF-1.4'))).toBe('pdf');
    expect(detectSignature(bytes(0, 0, 0, 0x20, 'ftypisom'))).toBe('isobmff');
    expect(detectSignature(bytes(0xef, 0xbb, 0xbf, '  \n<svg xmlns="http://www.w3.org/2000/svg">'))).toBe('markup');
    expect(detectSignature(bytes('<!DOCTYPE html><html>'))).toBe('markup');
    expect(detectSignature(bytes('plain words'))).toBe('unknown');
  });

  it('requires the signature to match the declared type', () => {
    expect(verifySignature('image/png', bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))).toEqual({ ok: true });
    expect(verifySignature('image/png', bytes('<html>'))).toMatchObject({ ok: false });
    expect(verifySignature('application/pdf', bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a))).toMatchObject({ ok: false });
    expect(verifySignature('image/svg+xml', bytes('<svg>'))).toMatchObject({ ok: false });
  });

  it('sanitizes filenames and validates declared type, extension, purpose and size', () => {
    expect(sanitizeFilename('../../etc/passwd.png')).toBe('passwd.png');
    expect(sanitizeFilename('C:\\Users\\x\\bad<name>.pdf')).toBe('bad_name_.pdf');
    expect(sanitizeFilename('.hidden\u0000.png')).toBe('hidden.png');
    expect(validateDeclaredUpload({ purpose: 'DELIVERY', filename: 'Cut.MP4', mime: 'video/mp4', size: 1000 })).toMatchObject({ bucket: 'private-deliverables', extension: 'mp4' });
    expect(() => validateDeclaredUpload({ purpose: 'BRIEF', filename: 'a.mp4', mime: 'video/mp4', size: 10 })).toThrow(/not accepted/);
    expect(() => validateDeclaredUpload({ purpose: 'DELIVERY', filename: 'a.jpg', mime: 'image/png', size: 10 })).toThrow(/extension/);
    expect(() => validateDeclaredUpload({ purpose: 'DELIVERY', filename: 'a.pdf', mime: 'application/pdf', size: 25 * 1024 * 1024 + 1 })).toThrow(/25 MB/);
    expect(() => validateDeclaredUpload({ purpose: 'DELIVERY', filename: 'a.pdf', mime: 'application/pdf', size: 0 })).toThrow(/size/);
    expect(() => validateDeclaredUpload({ purpose: 'INVOICE', filename: 'a.png', mime: 'image/png', size: 10 })).toThrow(/purpose/);
    // Profile photos: images only, in their own bucket.
    expect(validateDeclaredUpload({ purpose: 'AVATAR', filename: 'me.png', mime: 'image/png', size: 10 })).toMatchObject({ bucket: 'public-avatars' });
    expect(() => validateDeclaredUpload({ purpose: 'AVATAR', filename: 'cv.pdf', mime: 'application/pdf', size: 10 })).toThrow(/not accepted/);
  });
});
