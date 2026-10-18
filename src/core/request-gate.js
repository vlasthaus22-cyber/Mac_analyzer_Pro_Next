export function createRequestGate() {
  let revision = 0;
  return Object.freeze({
    begin: () => ++revision,
    invalidate: () => { revision += 1; },
    isCurrent: (requestRevision) => requestRevision === revision,
  });
}
