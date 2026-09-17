import { describe, expect, it } from 'vitest';
import { CommandError, instant, instantField } from '../../src/lib/commands';
import { checkPublicationProof, type PublishTerms } from '../../src/modules/publish';

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe('datetime-local fields keep the time the person picked', () => {
  it('reads the wall clock as UTC when the browser sent no offset', () => {
    expect(instantField(form({ starts_at: '2026-09-16T14:00' }), 'starts_at').toISOString()).toBe('2026-09-16T14:00:00.000Z');
  });

  it('shifts the wall clock by the offset the browser was on', () => {
    // +07:00: a creator in Bangkok who picks 14:00 means 07:00 UTC, not 14:00 UTC.
    expect(instantField(form({ starts_at: '2026-09-16T14:00', starts_at_offset: '420' }), 'starts_at').toISOString()).toBe('2026-09-16T07:00:00.000Z');
    // -04:00: the same clock face on the other side of the Atlantic is a later instant.
    expect(instantField(form({ starts_at: '2026-09-16T14:00', starts_at_offset: '-240' }), 'starts_at').toISOString()).toBe('2026-09-16T18:00:00.000Z');
    // A half-hour zone and a zero offset both survive the trip.
    expect(instantField(form({ starts_at: '2026-09-16T14:00', starts_at_offset: '330' }), 'starts_at').toISOString()).toBe('2026-09-16T08:30:00.000Z');
    expect(instantField(form({ starts_at: '2026-09-16T14:00', starts_at_offset: '0' }), 'starts_at').toISOString()).toBe('2026-09-16T14:00:00.000Z');
  });

  it('refuses an offset that is not a real one, so a forged form cannot move an instant anywhere', () => {
    for (const bad of ['1441', '-1441', '7.5', 'UTC+7', '+07:00']) {
      expect(() => instantField(form({ starts_at: '2026-09-16T14:00', starts_at_offset: bad }), 'starts_at')).toThrow(CommandError);
    }
  });

  it('still refuses a missing or unparseable date', () => {
    expect(() => instantField(form({}), 'starts_at')).toThrow(/required/);
    expect(() => instant('not-a-date', 'starts_at')).toThrow(/valid date/);
  });
});

describe('XPL-02 publication time follows the creator clock too', () => {
  const terms: PublishTerms = {
    account_id: 'a', platform: 'X', handle: 'arimakes', channel_url: 'https://x.com/arimakes',
    format: 'POST', min_live_hours: 72, disclosure_text: '#ad', editorial_policy_version: 'publish-v1',
  };
  const fields = (extra: Record<string, string>) => form({
    post_url: 'https://x.com/arimakes/status/1834567890123', disclosure_attested: 'on', ...extra,
  });
  const now = new Date('2026-09-16T12:00:00.000Z');

  it('reads the posted time in the creator zone', () => {
    const proof = checkPublicationProof(terms, fields({ published_at: '2026-09-16T18:00', published_at_offset: '420' }), null, null, now);
    expect(proof.publishedAt.toISOString()).toBe('2026-09-16T11:00:00.000Z');
  });

  it('a zone offset cannot smuggle a post from the future past the check', () => {
    // 18:00 in Bangkok is already past; the same 18:00 read as UTC would be six hours ahead of now.
    expect(() => checkPublicationProof(terms, fields({ published_at: '2026-09-16T18:00' }), null, null, now)).toThrow(/future/);
  });
});
