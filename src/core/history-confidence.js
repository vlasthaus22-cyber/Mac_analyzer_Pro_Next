export function historyConfidenceFromOccurrences(occurrences) {
  const count = Math.max(0, Number(occurrences) || 0);
  return Math.min(0.9, 0.5 + Math.min(count, 100) * 0.004);
}
