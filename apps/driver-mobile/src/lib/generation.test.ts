import { describe, expect, it } from 'vitest';
import { createGeneration } from './generation';

describe('oturum nesli', () => {
  it('uçuştaki işin nesli çıkıştan sonra geçersizdir', () => {
    const g = createGeneration();
    const inFlight = g.current();
    expect(g.isCurrent(inFlight)).toBe(true);
    g.bump(); // çıkış / oturum sonu
    expect(g.isCurrent(inFlight)).toBe(false);
    expect(g.isCurrent(g.current())).toBe(true);
  });
});
