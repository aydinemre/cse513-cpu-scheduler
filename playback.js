/** Find the first array position whose value is greater than target. */
function upperBound(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Prepare an immutable timeline view for playback. Ready processes are a pool
 * in original input order; this does not claim to reconstruct a FIFO queue.
 * Work is compiled once, then each frame uses binary searches over intervals.
 */
export function createPlayback(result) {
  const makespan = result.makespan;
  const algorithm = result.algorithm;
  const rows = result.metrics.map((row, index) => ({
    id: row.id,
    arrival: row.arrival,
    burst: row.burst,
    completion: row.completion,
    firstStart: row.firstStart,
    index,
  }));
  const rowsById = new Map(rows.map(row => [row.id, row]));
  const segments = result.segments.map(segment => ({ ...segment }));
  const segmentStarts = segments.map(segment => segment.start);
  const runs = new Map(rows.map(row => [row.id, { starts: [], ends: [], prefix: [0] }]));
  const arrivals = new Map();
  const eventTimes = new Set([0, makespan]);

  for (const row of rows) {
    eventTimes.add(row.arrival);
    if (!arrivals.has(row.arrival)) arrivals.set(row.arrival, []);
    arrivals.get(row.arrival).push(row.id);
  }
  for (const segment of segments) {
    eventTimes.add(segment.start);
    eventTimes.add(segment.end);
    if (segment.id === null) continue;
    const run = runs.get(segment.id);
    run.starts.push(segment.start);
    run.ends.push(segment.end);
    run.prefix.push(run.prefix[run.prefix.length - 1] + segment.end - segment.start);
  }
  const events = [...eventTimes].sort((a, b) => a - b);

  function executedAt(row, time) {
    const run = runs.get(row.id);
    const index = upperBound(run.starts, time) - 1;
    if (index < 0) return 0;
    const partial = Math.max(0, Math.min(time, run.ends[index]) - run.starts[index]);
    return run.prefix[index] + partial;
  }

  function describeEvent(time, segmentIndex, finished) {
    if (finished) return 'All processes completed';
    const segment = segments[segmentIndex];
    if (segment.id === null) return `CPU idle until t = ${segment.end}`;
    if (time === segment.start) {
      const previous = segments[segmentIndex - 1];
      if (previous && previous.id !== null && previous.end === time) {
        if (algorithm === 'RR' && previous.id === segment.id) {
          return `${segment.id} starts a new quantum`;
        }
        if (algorithm === 'SRTF' && previous.id !== segment.id
          && rowsById.get(previous.id).completion > time) {
          return `${segment.id} preempts ${previous.id}`;
        }
      }
      return `${segment.id} gets the CPU`;
    }
    const newlyArrived = arrivals.get(time);
    if (newlyArrived) return `${newlyArrived.join(', ')} arrived; ${segment.id} continues`;
    return `${segment.id} is running`;
  }

  function frameAt(requestedTime) {
    if (!Number.isFinite(requestedTime)) {
      throw new TypeError('Playback time must be a finite number.');
    }
    const time = Math.max(0, Math.min(makespan, requestedTime));
    const finished = time === makespan;
    const segmentIndex = finished ? -1 : upperBound(segmentStarts, time) - 1;
    const activeId = finished ? null : segments[segmentIndex].id;
    const ready = [];
    const future = [];
    const completed = [];
    let running = null;

    for (const row of rows) {
      const executed = executedAt(row, time);
      const state = { ...row, executed, remaining: Math.max(0, row.burst - executed) };
      if (row.completion <= time) completed.push(state);
      else if (row.arrival > time) future.push(state);
      else if (row.id === activeId) running = state;
      else ready.push(state);
    }
    return {
      time,
      running,
      ready,
      future,
      completed,
      finished,
      segmentIndex,
      eventLabel: describeEvent(time, segmentIndex, finished),
    };
  }

  return { events, frameAt };
}
