import { describe, it, expect } from 'vitest';
import { validateJoin, MAX_NAME_LEN } from '../src/validate.js';

describe('validateJoin', () => {
  it('accepts a normal room id and Riot ID', () => {
    const result = validateJoin('k3f9zq', 'Faker#KR1');
    expect(result).toEqual({ ok: true, room: 'k3f9zq', name: 'Faker#KR1' });
  });

  it('accepts the room ids the integration tests and generateRoomId produce', () => {
    // generateRoomId emits base36; the e2e suite uses hyphenated ids.
    for (const room of ['r-tiered', 'solo-room', '1z9x8c', 'r.camera', 'a:b_c']) {
      expect(validateJoin(room, 'Alice').ok).toBe(true);
    }
  });

  it('accepts unicode names verbatim', () => {
    // Riot IDs are unicode; the server must not restrict the charset.
    const result = validateJoin('room1', 'Ярость#EUW');
    expect(result).toEqual({ ok: true, room: 'room1', name: 'Ярость#EUW' });
  });

  it('never trims or normalises the name', () => {
    // The raw string IS the client's identity: it is what `signal` messages
    // are addressed to and what the initiator election compares. Storing a
    // normalised variant would make findInRoom miss for this player and break
    // their signaling entirely.
    const padded = ' Alice ';
    const result = validateJoin('room1', padded);
    expect(result.ok).toBe(true);
    expect((result as { name: string }).name).toBe(padded);
  });

  it('rejects a non-string name (the JSON.parse type hole)', () => {
    // `{"type":"join","room":"r","name":{}}` passes a truthiness check and
    // puts a non-string into room state, breaking name-keyed routing.
    expect(validateJoin('room1', {}).ok).toBe(false);
    expect(validateJoin('room1', 42).ok).toBe(false);
    expect(validateJoin('room1', null).ok).toBe(false);
    expect(validateJoin('room1', undefined).ok).toBe(false);
    expect(validateJoin('room1', ['Alice']).ok).toBe(false);
  });

  it('rejects a non-string room', () => {
    expect(validateJoin(123, 'Alice').ok).toBe(false);
    expect(validateJoin({}, 'Alice').ok).toBe(false);
  });

  it('rejects an empty name', () => {
    // orchestrator.ts falls back to summonerName when riotId is absent; an
    // empty identity would collide with every other empty one.
    expect(validateJoin('room1', '').ok).toBe(false);
  });

  it('rejects an empty room id', () => {
    expect(validateJoin('', 'Alice').ok).toBe(false);
  });

  it('accepts a name at the length cap and rejects one past it', () => {
    expect(validateJoin('room1', 'a'.repeat(MAX_NAME_LEN)).ok).toBe(true);
    expect(validateJoin('room1', 'a'.repeat(MAX_NAME_LEN + 1)).ok).toBe(false);
  });

  it('rejects control characters in a name', () => {
    expect(validateJoin('room1', 'Ali\x00ce').ok).toBe(false);
    expect(validateJoin('room1', 'Ali\nce').ok).toBe(false);
    expect(validateJoin('room1', 'Ali\x1bce').ok).toBe(false);
    expect(validateJoin('room1', 'Ali\x7fce').ok).toBe(false);
    expect(validateJoin('room1', 'Ali\x9fce').ok).toBe(false);
  });

  it('accepts a hyphen in a name', () => {
    // The control-character class ends in `\x7F-\x9F`; spelling it `\x7F-`
    // instead makes the hyphen a literal member and silently refuses every
    // hyphenated Riot ID.
    expect(validateJoin('room1', 'Ali-ce').ok).toBe(true);
  });

  it('rejects room ids outside the accepted charset', () => {
    expect(validateJoin('room 1', 'Alice').ok).toBe(false);
    expect(validateJoin('room/1', 'Alice').ok).toBe(false);
    expect(validateJoin('r'.repeat(65), 'Alice').ok).toBe(false);
  });

  it('explains why it rejected', () => {
    // Join errors reach the client as a message; a bare "invalid" would be
    // undiagnosable from a bug report.
    const result = validateJoin('room1', '');
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/name/);
  });
});
