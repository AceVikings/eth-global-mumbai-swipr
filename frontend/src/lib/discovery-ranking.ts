import type { Trader } from '../contracts/types';

export type SwipeFeedback = { trader: Trader; direction: 'left' | 'right' };
const stopWords = new Set('a an and are as at be bot by for from in is it of on or our the this to trader trading with your'.split(' '));

/** Content-based preferences, not a prediction of returns or trading quality. */
function features(trader: Trader): Map<string, number> {
  const result = new Map<string, number>([[`style:${trader.style}`, 1.5], [`kind:${trader.kind}`, 0.25]]);
  const words = [...new Set(trader.bio.toLowerCase().match(/[a-z]{3,24}/g) ?? [])]
    .filter(word => !stopWords.has(word)).slice(0, 32);
  for (const word of words) result.set(`strategy:${word}`, 1 / Math.sqrt(words.length));
  return result;
}

export function rankTraders(traders: readonly Trader[], feedback: readonly SwipeFeedback[], savedTraders: readonly Trader[] = []): Trader[] {
  // Wallet-owned Arkiv ghosts restore positive preferences across visits. Skips
  // stay in memory for this visit; a repeated swipe replaces its earlier vote.
  const votes = new Map<string, SwipeFeedback>(savedTraders.map(trader => [trader.id, { trader, direction: 'right' }]));
  for (const vote of feedback) votes.set(vote.trader.id, vote);
  if (!votes.size) return [...traders];
  const weights = new Map<string, number>();
  for (const { trader, direction } of votes.values()) {
    for (const [feature, value] of features(trader)) {
      weights.set(feature, (weights.get(feature) ?? 0) + value * (direction === 'right' ? 1 : -1));
    }
  }
  const score = (trader: Trader) => {
    const vector = features(trader);
    let dot = 0, magnitude = 0;
    for (const [feature, value] of vector) {
      dot += value * (weights.get(feature) ?? 0);
      magnitude += value * value;
    }
    return dot / Math.sqrt(magnitude);
  };
  return traders.map((trader, index) => ({ trader, index, score: score(trader) }))
    .sort((a, b) => b.score - a.score || a.index - b.index).map(row => row.trader);
}

export function discoveryDeck(traders: readonly Trader[], reviewedIds: readonly string[], feedback: readonly SwipeFeedback[], savedTraders: readonly Trader[], restoredId: string | null = null): Trader[] {
  const reviewed = new Set(reviewedIds);
  const ranked = rankTraders(traders.filter(trader => !reviewed.has(trader.id)), feedback, savedTraders);
  const restored = ranked.find(trader => trader.id === restoredId);
  return restored ? [restored, ...ranked.filter(trader => trader.id !== restoredId)] : ranked;
}
