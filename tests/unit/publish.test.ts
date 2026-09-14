import { describe, expect, it } from 'vitest';
import { canonicalizeSocialAccount, checkPostLink, checkPublicationProof, type PublishTerms } from '../../src/modules/publish';
import { screenContent } from '../../src/modules/moderation/policy';

const xTerms: PublishTerms = { account_id: 'a', platform: 'X', handle: 'arimakes', channel_url: 'https://x.com/arimakes', format: 'POST', min_live_hours: 72, disclosure_text: '#ad', editorial_policy_version: 'publish-v1' };
const form = (fields: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return f; };

describe('XPL-01 social account canonicalization', () => {
  it('normalizes X handles and profile links to one https URL', () => {
    for (const input of ['@AriMakes', 'arimakes', 'https://twitter.com/AriMakes', 'x.com/arimakes/', 'https://mobile.twitter.com/arimakes?s=20']) {
      expect(canonicalizeSocialAccount('X', input)).toEqual({ handle: 'arimakes', canonicalUrl: 'https://x.com/arimakes' });
    }
    expect(canonicalizeSocialAccount('TIKTOK', 'https://www.tiktok.com/@Ari.Makes')).toEqual({ handle: 'ari.makes', canonicalUrl: 'https://www.tiktok.com/@ari.makes' });
    expect(canonicalizeSocialAccount('YOUTUBE', 'https://youtube.com/@AriMakes/videos')).toEqual({ handle: 'arimakes', canonicalUrl: 'https://www.youtube.com/@arimakes' });
    expect(canonicalizeSocialAccount('NEWSLETTER', 'http://Ari.Substack.com/?utm=x#top')).toEqual({ handle: null, canonicalUrl: 'https://ari.substack.com' });
  });

  it('rejects links to another platform, X system pages and invalid handles', () => {
    expect(() => canonicalizeSocialAccount('X', 'https://instagram.com/arimakes')).toThrow(/not a X link/);
    expect(() => canonicalizeSocialAccount('X', 'https://x.com/home')).toThrow(/profile/);
    expect(() => canonicalizeSocialAccount('X', '@this_handle_is_too_long_for_x')).toThrow(/not valid/);
    expect(() => canonicalizeSocialAccount('WEBSITE', 'https://user:pass@example.com')).toThrow(/credentials/);
    expect(() => canonicalizeSocialAccount('YOUTUBE', 'https://youtu.be/dQw4w9WgXcQ')).toThrow(/channel/);
  });
});

describe('XPL-02 post link and proof checks', () => {
  it('accepts a post on the sold X handle and canonicalizes it', () => {
    expect(checkPostLink(xTerms, 'https://twitter.com/AriMakes/status/1834567890123?s=46')).toEqual({ postUrl: 'https://x.com/arimakes/status/1834567890123', postId: '1834567890123', linkCheck: 'MATCHES_CHANNEL' });
  });

  it('refuses another handle, a profile link or another platform', () => {
    expect(() => checkPostLink(xTerms, 'https://x.com/someoneelse/status/1834567890123')).toThrow(/channel sold in this order \(@arimakes\)/);
    expect(() => checkPostLink(xTerms, 'https://x.com/arimakes')).toThrow(/link to the post itself/);
    expect(() => checkPostLink(xTerms, 'https://www.instagram.com/p/Cabcdef123')).toThrow(/channel sold/);
  });

  it('labels platforms whose post links do not include the account as SAME_PLATFORM', () => {
    expect(checkPostLink({ ...xTerms, platform: 'YOUTUBE', handle: 'arimakes', channel_url: 'https://www.youtube.com/@arimakes' }, 'https://youtu.be/dQw4w9WgXcQ').linkCheck).toBe('SAME_PLATFORM');
    expect(checkPostLink({ ...xTerms, platform: 'NEWSLETTER', handle: null, channel_url: 'https://ari.substack.com' }, 'https://ari.substack.com/p/launch').linkCheck).toBe('MATCHES_CHANNEL');
    expect(() => checkPostLink({ ...xTerms, platform: 'NEWSLETTER', handle: null, channel_url: 'https://ari.substack.com' }, 'https://evil.example/p/launch')).toThrow(/channel sold/);
  });

  it('requires a publication time inside the order and the disclosure attestation', () => {
    const now = new Date('2026-09-15T12:00:00Z');
    const start = new Date('2026-09-15T08:00:00Z');
    const due = new Date('2026-09-15T11:00:00Z');
    const base = { post_url: 'https://x.com/arimakes/status/1834567890123', published_at: '2026-09-15T11:30', disclosure_attested: 'on' };
    expect(checkPublicationProof(xTerms, form(base), start, due, now)).toMatchObject({ late: true, linkCheck: 'MATCHES_CHANNEL' });
    expect(() => checkPublicationProof(xTerms, form({ ...base, published_at: '2026-09-15T13:00' }), start, due, now)).toThrow(/future/);
    expect(() => checkPublicationProof(xTerms, form({ ...base, published_at: '2026-09-14T13:00' }), start, due, now)).toThrow(/before this order started/);
    expect(() => checkPublicationProof(xTerms, form({ ...base, disclosure_attested: '' }), start, due, now)).toThrow(/disclosure "#ad"/);
    expect(() => checkPublicationProof(xTerms, form({ ...base, post_url: '' }), start, due, now)).toThrow(/link to the published post/);
  });
});

describe('MOD-01 content policy screen', () => {
  it('flags explicit undisclosed promotion, fake engagement, guaranteed returns and verbatim scripts', () => {
    const reasons = (text: string) => screenContent(text).map((v) => v.reason);
    expect(reasons("Please don't mention it's sponsored, make it look organic")).toEqual(['UNDISCLOSED_PROMOTION']);
    expect(reasons('We will also buy likes and retweets for the thread')).toEqual(['FAKE_ENGAGEMENT']);
    expect(reasons('Tell followers this token has guaranteed 100x returns')).toEqual(['GUARANTEED_RETURNS']);
    expect(reasons('Post this word for word from our script')).toEqual(['DECEPTIVE_SCRIPT']);
  });

  it('does not flag an ordinary disclosed campaign brief', () => {
    expect(screenContent('Explain our testnet in your own words, add #ad, link the docs and mention the airdrop has no guaranteed value.')).toEqual([]);
  });
});
