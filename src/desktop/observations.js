// Legacy browser receipts remain on disk; only their display category changes.
function observationKind(record) {
  if (['life', 'execution'].includes(record.kind)) return record.kind;
  if (record.evidence !== 'user' && /\bcb_(?:browser|maintenance)\b/i.test(String(record.source || ''))) return 'execution';
  return 'life';
}

function observationViews(records) {
  const life = [], execution = [];
  for (const record of records) {
    const kind = observationKind(record);
    (kind === 'execution' ? execution : life).push({ ...record, kind });
  }
  return { observations: life.slice(-200), executionObservations: execution.slice(-200) };
}

module.exports = { observationKind, observationViews };
