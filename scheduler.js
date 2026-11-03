/**
 * Deterministic CPU scheduling under the Assignment 1 model.
 * All intervals are half open: [start, end). No input object is mutated.
 */
const ALGORITHMS = new Set(['FCFS', 'SJF', 'SRTF', 'RR']);
const MAX_PROCESSES = 100;
const MAX_TIME_VALUE = 1_000_000;
const MAX_SEGMENTS = 20_000;

function isIntegerInRange(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

/** Returns true for valid input; otherwise throws an explanatory Error. */
export function validateInput(processes, algorithm, quantum = 2) {
  if (!ALGORITHMS.has(algorithm)) {
    throw new Error('Choose FCFS, SJF, SRTF, or RR as the scheduling algorithm.');
  }
  if (!Array.isArray(processes) || processes.length < 1 || processes.length > MAX_PROCESSES) {
    throw new Error('Enter between 1 and 100 processes.');
  }
  const seenIds = new Set();
  processes.forEach((process, index) => {
    const label = `Process ${index + 1}`;
    if (!process || typeof process !== 'object' || Array.isArray(process)) {
      throw new Error(`${label} must contain an ID, arrival time, and CPU burst.`);
    }
    if (typeof process.id !== 'string' || !process.id.trim()) {
      throw new Error(`${label}: enter a nonempty process ID.`);
    }
    const id = process.id.trim();
    if (id.length > 24) {
      throw new Error(`${label}: process IDs may contain at most 24 characters.`);
    }
    if (seenIds.has(id)) {
      throw new Error(`${label}: process ID "${id}" is duplicated. IDs must be unique.`);
    }
    seenIds.add(id);
    if (!isIntegerInRange(process.arrival, 0, MAX_TIME_VALUE)) {
      throw new Error(`${label}: arrival time must be an integer from 0 to 1,000,000.`);
    }
    if (!isIntegerInRange(process.burst, 1, MAX_TIME_VALUE)) {
      throw new Error(`${label}: CPU burst must be an integer from 1 to 1,000,000.`);
    }
  });
  if (algorithm === 'RR' && !isIntegerInRange(quantum, 1, MAX_TIME_VALUE)) {
    throw new Error('Round-robin quantum must be an integer from 1 to 1,000,000.');
  }
  return true;
}

/**
 * Event-driven simulation: jumps between dispatches, arrivals (SRTF), and
 * completions. RR preserves each individual dispatch/quantum boundary.
 */
export function simulate(processes, algorithm, quantum = 2) {
  validateInput(processes, algorithm, quantum);
  const jobs = processes.map((process, index) => ({
    id: process.id.trim(),
    arrival: process.arrival,
    burst: process.burst,
    remaining: process.burst,
    index,
    firstStart: null,
    completion: null,
  }));
  const pending = [...jobs].sort((a, b) => a.arrival - b.arrival || a.index - b.index);
  const ready = [];
  const segments = [];
  let nextArrival = 0;
  let time = 0;
  let completed = 0;
  let current = null;

  function enqueueArrivals() {
    while (nextArrival < pending.length && pending[nextArrival].arrival <= time) {
      ready.push(pending[nextArrival++]);
    }
  }

  function appendSegment(id, start, end) {
    if (end <= start) return;
    const previous = segments[segments.length - 1];
    if (algorithm !== 'RR' && previous && previous.id === id && previous.end === start) {
      previous.end = end;
      return;
    }
    if (segments.length >= MAX_SEGMENTS) {
      throw new Error('The simulation exceeds 20,000 timeline segments. Increase the round-robin time quantum or reduce the workload.');
    }
    segments.push({ id, start, end });
  }

  function compareJobs(a, b) {
    const durationDifference = algorithm === 'SJF'
      ? a.burst - b.burst
      : algorithm === 'SRTF' ? a.remaining - b.remaining : 0;
    return durationDifference || a.arrival - b.arrival || a.index - b.index;
  }

  function takeNextJob() {
    if (algorithm === 'RR') return ready.shift();
    let best = 0;
    for (let index = 1; index < ready.length; index += 1) {
      if (compareJobs(ready[index], ready[best]) < 0) best = index;
    }
    return ready.splice(best, 1)[0];
  }

  while (completed < jobs.length) {
    enqueueArrivals();
    if (current === null && ready.length === 0) {
      const arrival = pending[nextArrival].arrival;
      appendSegment(null, time, arrival);
      time = arrival;
      enqueueArrivals();
    }
    if (current === null) current = takeNextJob();
    if (current.firstStart === null) current.firstStart = time;

    let duration = current.remaining;
    if (algorithm === 'RR') duration = Math.min(duration, quantum);
    if (algorithm === 'SRTF' && nextArrival < pending.length) {
      duration = Math.min(duration, pending[nextArrival].arrival - time);
    }
    appendSegment(current.id, time, time + duration);
    current.remaining -= duration;
    time += duration;

    // Includes arrivals exactly at a quantum boundary, before RR re-enqueue.
    enqueueArrivals();
    if (current.remaining === 0) {
      current.completion = time;
      completed += 1;
      current = null;
    } else if (algorithm === 'RR') {
      ready.push(current);
      current = null;
    } else if (algorithm === 'SRTF') {
      // Equal remaining times never preempt the currently running process.
      let best = -1;
      for (let index = 0; index < ready.length; index += 1) {
        if (best === -1 || compareJobs(ready[index], ready[best]) < 0) best = index;
      }
      if (best !== -1 && ready[best].remaining < current.remaining) {
        const replacement = ready.splice(best, 1)[0];
        ready.push(current);
        current = replacement;
      }
    }
  }

  const metrics = jobs.map((job) => {
    const turnaround = job.completion - job.arrival;
    return {
      id: job.id,
      arrival: job.arrival,
      burst: job.burst,
      firstStart: job.firstStart,
      completion: job.completion,
      turnaround,
      waiting: turnaround - job.burst,
      response: job.firstStart - job.arrival,
    };
  });
  const averages = {};
  for (const name of ['turnaround', 'waiting', 'response']) {
    averages[name] = metrics.reduce((sum, row) => sum + row[name], 0) / jobs.length;
  }
  return {
    algorithm,
    quantum: algorithm === 'RR' ? quantum : null,
    segments,
    metrics,
    averages,
    makespan: time,
    busyTime: jobs.reduce((sum, job) => sum + job.burst, 0),
  };
}
