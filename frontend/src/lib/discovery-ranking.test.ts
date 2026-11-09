import { describe, expect, it } from 'vitest';
import type { Trader } from '../contracts/types';
import { discoveryDeck, rankTraders, type SwipeFeedback } from './discovery-ranking';
const trader = (id: string, style: Trader['style'], bio = ''): Trader => ({ id, style, bio, name: id, ens: '', avatar: '', kind: 'agent' });
const steady = trader('steady', 'Steady', 'Long term momentum strategy');
const spicy = trader('spicy', 'Spicy', 'Fast breakout scalping');
const steadyNext = trader('steady-next', 'Steady', 'Long term momentum strategy');
const spicyNext = trader('spicy-next', 'Spicy', 'Fast breakout scalping');
const right = (t: Trader): SwipeFeedback => ({ trader: t, direction: 'right' });
const left = (t: Trader): SwipeFeedback => ({ trader: t, direction: 'left' });

describe('personalized trader discovery', () => {
  it('keeps directory order without feedback and does not mutate inputs', () => {
    const original = [spicy, steady];
    expect(rankTraders(original, [])).toEqual(original);
    expect(rankTraders(original, [])).not.toBe(original);
    rankTraders(original, [right(steady)]);
    expect(original).toEqual([spicy, steady]);
  });
  it('promotes similar strategies after a save and demotes them after a skip', () => {
    expect(rankTraders([spicyNext, steadyNext], [right(steady)])[0]).toEqual(steadyNext);
    expect(rankTraders([steadyNext, spicyNext], [left(steady)])[0]).toEqual(spicyNext);
  });
  it('learns from strategy descriptions within a selected style', () => {
    const breakout = trader('breakout', 'Balanced', 'Breakout scalping');
    const longTerm = trader('longterm', 'Balanced', 'Long term momentum strategy');
    expect(rankTraders([breakout, longTerm], [right(steady)])[0]).toEqual(longTerm);
  });
  it('restores positive feedback from saved wallet ghosts without duplicate votes', () => {
    expect(rankTraders([spicyNext, steadyNext], [], [steady])[0]).toEqual(steadyNext);
    expect(rankTraders([spicyNext, steadyNext], [right(steady)], [steady, steady]))
      .toEqual(rankTraders([spicyNext, steadyNext], [right(steady)]));
  });
  it('replaces a repeated vote rather than amplifying one trader', () => {
    expect(rankTraders([steadyNext, spicyNext], [right(steady), left(steady)]))
      .toEqual(rankTraders([steadyNext, spicyNext], [left(steady)]));
  });
  it('reranks the next card immediately without repeating reviewed cards', () => {
    const all = [steady, spicy, steadyNext, spicyNext];
    expect(discoveryDeck(all, [steady.id], [right(steady)], []).map(t => t.id))
      .toEqual(['steady-next', 'spicy', 'spicy-next']);
    expect(discoveryDeck(all, all.map(t => t.id), [right(steady)], [])).toEqual([]);
  });
  it('undo restores the skipped card and the prior preference model', () => {
    const all = [steady, spicy, steadyNext, spicyNext];
    const previous = [right(spicy)];
    expect(discoveryDeck(all, [spicy.id], previous, [], steady.id)[0]).toEqual(steady);
    expect(discoveryDeck(all, [spicy.id], previous, []).map(t => t.id))
      .toEqual(['spicy-next', 'steady', 'steady-next']);
  });
  it('handles empty descriptions and stable ties', () => {
    const first = trader('one', 'Balanced'), second = trader('two', 'Balanced');
    expect(rankTraders([first, second], [right(first)])).toEqual([first, second]);
  });
});
