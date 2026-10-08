import { describe, expect, it } from 'vitest';
import { afterRefresh } from './session-policy';

describe('afterRefresh', () => {
  it('ok -> bağlan', () => expect(afterRefresh('ok', 1)).toEqual({ kind: 'connect' }));
  it('network -> geri çekilmeyle yeniden dene', () => {
    expect(afterRefresh('network', 1)).toEqual({ kind: 'retry', delayMs: 1000 });
    expect(afterRefresh('network', 9)).toEqual({ kind: 'retry', delayMs: 5000 });
  });
  it('rejected -> dur', () => expect(afterRefresh('rejected', 1)).toEqual({ kind: 'stop' }));
});
