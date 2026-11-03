/** Independent consistency checks over a completed timeline, not policy proofs. */
export function verifyResult(result) {
  const rows = result.metrics;
  const segments = result.segments;
  const totals = new Map(rows.map(row => [row.id, 0]));
  const first = new Map();
  const last = new Map();
  let arrivalSafe = true;
  let continuousSingleCPU = true;
  let noAvoidableIdle = true;
  let previousEnd = 0;
  for (const segment of segments) {
    if (segment.start !== previousEnd || segment.end <= segment.start) continuousSingleCPU = false;
    previousEnd = segment.end;
    if (segment.id === null) {
      if (rows.some(row => row.arrival < segment.end && totals.get(row.id) < row.burst)) noAvoidableIdle = false;
      continue;
    }
    const row = rows.find(item => item.id === segment.id);
    if (!row || segment.start < row.arrival) arrivalSafe = false;
    totals.set(segment.id, (totals.get(segment.id) ?? 0) + segment.end - segment.start);
    if (!first.has(segment.id)) first.set(segment.id, segment.start);
    last.set(segment.id, segment.end);
  }
  const burstConserved = rows.every(row => totals.get(row.id) === row.burst);
  const nonnegative = rows.every(row => row.waiting >= 0 && row.response >= 0);
  const averagesConsistent = ['turnaround', 'waiting', 'response'].every(key =>
    Number.isFinite(result.averages?.[key])
    && Math.abs(result.averages[key] - rows.reduce((sum, row) => sum + row[key], 0) / rows.length) < 1e-9);
  const metricsConsistent = rows.length > 0 && segments.length > 0
    && new Set(rows.map(row => row.id)).size === rows.length
    && result.makespan === previousEnd
    && result.busyTime === rows.reduce((sum, row) => sum + row.burst, 0)
    && result.busyTime === segments.reduce((sum, segment) => sum + (segment.id === null ? 0 : segment.end - segment.start), 0)
    && averagesConsistent
    && rows.every(row => row.firstStart === first.get(row.id)
    && row.completion === last.get(row.id)
    && row.turnaround === row.completion - row.arrival
    && row.waiting === row.turnaround - row.burst
    && row.response === row.firstStart - row.arrival);
  const checks = [
    { name: 'Exact CPU burst totals', passed: burstConserved },
    { name: 'No execution before arrival', passed: arrivalSafe },
    { name: 'Single CPU, no overlaps or gaps', passed: continuousSingleCPU },
    { name: 'Nonnegative waiting and response', passed: nonnegative },
    { name: 'No idle time while a process is ready', passed: noAvoidableIdle },
    { name: 'Metrics agree with the timeline', passed: metricsConsistent },
  ];
  return { passed: checks.every(check => check.passed), checks };
}
