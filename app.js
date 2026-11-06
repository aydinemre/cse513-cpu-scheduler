import { simulate } from './scheduler.js';
import { verifyResult } from './checks.js';
import { createPlayback } from './playback.js';

const $ = id => document.getElementById(id);
// Order validated for colour-vision-deficiency separation between neighbours. The light fills are fine on the paper
// surface because every block also has a 2.5px ink border and a text label.
const palette = ['#5AB8FF', '#FFC23D', '#FF7FAE', '#A78BFA', '#B8E83A', '#FF5A5A', '#34D399', '#FF8A3D'];
const LANE = 68; // width of the label column; mirrored as --lane in styles.css
const PAD_UNITS = 3; // empty time after the last completion, so a process can be dropped past the end
const MAX_VALUE = 1_000_000;
const NEW_BURST = 2;
const policies = {
  FCFS: { title: 'FCFS · First-Come, First-Served', description: 'The process that arrived first runs until it finishes.', preemptive: false,
    mode: 'Once a process gets the CPU it keeps it until its burst is done, so every process is one unbroken block.' },
  SJF: { title: 'SJF · Shortest Job First', description: 'Whenever the CPU becomes free, the waiting process with the shortest burst runs until it finishes.', preemptive: false,
    mode: 'A shorter arrival still waits for the running process to finish, so every process is one unbroken block.' },
  SRTF: { title: 'SRTF · Shortest Remaining Time First', description: 'The process with the least work left runs. A new arrival interrupts it only if it needs strictly less time.', preemptive: true,
    mode: 'A strictly shorter arrival takes the CPU away; the interrupted process resumes later, so it can appear in pieces.' },
  RR: { title: 'RR · Round Robin', description: 'Processes take turns of at most one quantum each, in arrival order. An unfinished process goes to the back of the queue.', preemptive: true,
    mode: 'The quantum timer takes the CPU away; the unfinished process waits its next turn, so it can appear in pieces.' },
};
const workloads = {
  A: [{ id: 'P1', arrival: 0, burst: 8 }, { id: 'P2', arrival: 1, burst: 4 }, { id: 'P3', arrival: 2, burst: 2 }, { id: 'P4', arrival: 4, burst: 1 }],
  B: [{ id: 'P1', arrival: 2, burst: 3 }, { id: 'P2', arrival: 2, burst: 1 }, { id: 'P3', arrival: 8, burst: 2 }, { id: 'P4', arrival: 9, burst: 1 }],
  boundary: [{ id: 'P1', arrival: 0, burst: 4 }, { id: 'P2', arrival: 2, burst: 1 }],
};

// The workload is the list of processes on the chart, top to bottom; list order breaks ties.
let processes = [];
let colorCounter = 0;
let currentResult = null;
let playback = null;
let currentTime = 0;
let playing = false;
let animationId = null;
let previousTimestamp = null;
let axis = [];
let axisEnd = 0;
let pixelsPerUnit = 48;
let ganttBlocks = [];
let laneBlocks = [];
let lastSegment = -2;
let editing = null;
let drag = null;
const algorithm = () => document.querySelector('input[name="algorithm"]:checked').value;
const format = value => value.toFixed(2);
const compact = value => Number.isInteger(value) ? String(value) : value.toFixed(1);
const units = value => `${compact(value)} ${Math.abs(value - 1) < 1e-9 ? 'unit' : 'units'}`;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const plain = list => list.map(({ id, arrival, burst }) => ({ id, arrival, burst }));
const byId = id => processes.find(process => process.id === id);

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

function makeProcess({ id, arrival, burst }) {
  return { id, arrival, burst, color: palette[colorCounter++ % palette.length] };
}

function nextId() {
  let count = 1;
  while (byId(`P${count}`)) count++;
  return `P${count}`;
}

function markCustomWorkload() {
  for (const key of ['load-a', 'load-b', 'load-boundary']) { $(key).classList.remove('is-selected'); $(key).setAttribute('aria-pressed', 'false'); }
}

function setWorkload(name) {
  colorCounter = 0;
  processes = workloads[name].map(makeProcess);
  if (name === 'boundary') {
    document.querySelector('input[name="algorithm"][value="RR"]').checked = true;
    $('quantum').value = 2;
  }
  for (const key of ['A', 'B', 'boundary']) {
    const selected = name === key;
    $(`load-${key.toLowerCase()}`).classList.toggle('is-selected', selected);
    $(`load-${key.toLowerCase()}`).setAttribute('aria-pressed', String(selected));
  }
  run();
}

// Engine messages number processes from 1 ("Process 2: …"); on the chart they are named instead.
function friendly(message, list = processes) {
  return message.replace(/^Process (\d+):/, (_, n) => `${list[n - 1]?.id?.trim() || `Process ${n}`}:`);
}

function syncTransport() {
  const finished = currentResult && currentTime >= currentResult.makespan;
  $('play-label').textContent = playing ? 'Pause' : finished ? 'Replay' : 'Play';
  $('play-icon').querySelector('path').setAttribute('d', playing ? 'M5 3h4v14H5zM12 3h4v14h-4z' : 'm6 3 11 7-11 7z');
  $('play-playback').setAttribute('aria-label', playing ? 'Pause playback' : finished ? 'Replay schedule' : 'Play schedule');
  for (const id of ['play-playback', 'time-scrubber']) $(id).disabled = !currentResult;
  $('next-event').disabled = !currentResult || finished;
  $('reset-playback').disabled = !currentResult || currentTime === 0;
}

function pausePlayback() {
  playing = false;
  if (animationId !== null) cancelAnimationFrame(animationId);
  animationId = null;
  previousTimestamp = null;
  syncTransport();
}

function run() {
  pausePlayback();
  const selected = algorithm();
  $('result-title').textContent = policies[selected].title;
  $('policy-description').textContent = policies[selected].description;
  const preemptive = policies[selected].preemptive;
  $('policy-mode').textContent = preemptive ? 'Preemptive' : 'Non-preemptive';
  $('policy-mode').classList.toggle('is-preemptive', preemptive);
  $('policy-mode').dataset.modeHelp = preemptive ? 'pre' : 'non';
  $('policy-mode').title = preemptive ? 'What does preemptive mean?' : 'What does non-preemptive mean?';
  if (openMode === 'pre' || openMode === 'non') showModeHelp(preemptive ? 'pre' : 'non');
  $('policy-mode-text').textContent = policies[selected].mode;
  $('quantum').disabled = selected !== 'RR';
  $('quantum').removeAttribute('aria-invalid');
  $('result-error').hidden = true;
  if (!processes.length) { renderEmpty(); return; }
  try {
    const rawQuantum = $('quantum').value;
    const result = simulate(plain(processes), selected, rawQuantum.trim() === '' ? NaN : Number(rawQuantum));
    renderResult(result);
  } catch (error) {
    // The chart only ever holds valid processes, so what can fail here is the quantum or a size limit.
    $('result-error').textContent = `${friendly(error.message)} The chart shows the last valid schedule.`;
    $('result-error').hidden = false;
    if (/quantum/i.test(error.message)) $('quantum').setAttribute('aria-invalid', 'true');
  }
}

function timeToX(time) {
  if (!axis.length) return time * pixelsPerUnit;
  if (time >= axis[axis.length - 1].end) return axisEnd + (time - axis[axis.length - 1].end) * pixelsPerUnit;
  let low = 0;
  let high = axis.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (axis[middle].end <= time) low = middle + 1;
    else high = middle;
  }
  const part = axis[low];
  return part.x + Math.max(0, Math.min(1, (time - part.start) / (part.end - part.start))) * part.width;
}

function xToTime(x) {
  if (!axis.length || x >= axisEnd) return (axis.at(-1)?.end ?? 0) + (x - axisEnd) / pixelsPerUnit;
  const part = axis.find(segment => x < segment.x + segment.width) || axis.at(-1);
  return part.start + (x - part.x) / part.width * (part.end - part.start);
}

function sizeCanvas(width) {
  $('timeline-canvas').style.width = `${width + LANE + 2}px`;
  requestAnimationFrame(updateScrollHint);
}

function drawRuler(end) {
  $('timeline-ruler').replaceChildren();
  const step = Math.max(1, Math.ceil(end / 10));
  let previousX = -100;
  for (let time = 0; time <= end; time += step) {
    const pos = timeToX(time);
    if (pos - previousX < 36) continue;
    const tick = element('span', 'ruler-tick', time);
    tick.style.left = `${pos}px`;
    $('timeline-ruler').append(tick);
    previousX = pos;
  }
  if (end % step !== 0 && timeToX(end) - previousX >= 28) {
    const tick = element('span', 'ruler-tick', end);
    tick.style.left = `${timeToX(end)}px`;
    $('timeline-ruler').append(tick);
  }
}

function renderEmpty() {
  currentResult = null;
  playback = null;
  axis = [];
  axisEnd = 0;
  const available = Math.max(320, $('timeline-viewport').clientWidth - LANE - 12);
  pixelsPerUnit = available / 10;
  sizeCanvas(available);
  $('gantt').replaceChildren();
  $('gantt').style.width = '0px';
  $('process-lanes').replaceChildren();
  $('interval-list').replaceChildren();
  $('interval-count').textContent = '';
  $('process-legend').replaceChildren();
  drawRuler(10);
  $('timeline-meta').textContent = 'No processes yet';
  $('playback-total').textContent = '';
  $('timeline-canvas').classList.add('is-empty', 'at-start');
  $('decision-text').textContent = 'Drop a process on the chart to start.';
  $('metrics-rows').replaceChildren();
  for (const id of ['avg-waiting', 'avg-response', 'avg-turnaround']) $(id).textContent = '–';
  $('invariant-status').replaceChildren();
  syncTransport();
}

// A draggable value handle: pointer drag plus arrow keys.
function makeHandle(node, kind, id, value) {
  node.dataset.kind = kind;
  node.dataset.id = id;
  node.tabIndex = 0;
  node.setAttribute('role', 'slider');
  node.setAttribute('aria-label', kind === 'arrival' ? `${id} arrival time` : `${id} CPU burst`);
  node.setAttribute('aria-valuemin', kind === 'arrival' ? '0' : '1');
  node.setAttribute('aria-valuemax', String(MAX_VALUE));
  node.setAttribute('aria-valuenow', String(value));
  node.addEventListener('pointerdown', event => startValueDrag(event, kind, id));
  node.addEventListener('keydown', event => {
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const process = byId(id);
    const next = clamp(process[kind] + step, kind === 'arrival' ? 0 : 1, MAX_VALUE);
    if (next === process[kind]) return;
    process[kind] = next;
    markCustomWorkload();
    run();
    document.querySelector(`[data-kind="${kind}"][data-id="${CSS.escape(id)}"]`)?.focus();
  });
}

function renderTimeline(result) {
  const viewport = $('timeline-viewport');
  const previousScroll = viewport.scrollLeft;
  const minimumDuration = Math.min(...result.segments.map(segment => segment.end - segment.start));
  const availableWidth = Math.max(320, viewport.clientWidth - LANE - 12);
  // Short slices keep a readable minimum width; otherwise the chart (plus drop room) fits the available width.
  const minimumSlice = viewport.clientWidth < 600 ? 36 : 40;
  pixelsPerUnit = Math.max(minimumSlice / minimumDuration, availableWidth / (result.makespan + PAD_UNITS));
  const compressed = pixelsPerUnit * result.makespan > 2_000_000;
  let x = 0;
  axis = result.segments.map(segment => {
    const width = compressed ? Math.max(48, Math.min(2000, (segment.end - segment.start) * 16)) : (segment.end - segment.start) * pixelsPerUnit;
    const point = { ...segment, x, width };
    x += width;
    return point;
  });
  if (compressed) pixelsPerUnit = 16;
  axisEnd = x;
  sizeCanvas(x + PAD_UNITS * pixelsPerUnit);
  $('timeline-canvas').classList.remove('is-empty');
  $('gantt').style.width = `${x + 2}px`;
  $('gantt').replaceChildren();
  $('interval-list').replaceChildren();
  $('process-lanes').replaceChildren();
  ganttBlocks = [];
  laneBlocks = [];
  const rails = new Map();
  const runs = new Map(result.metrics.map(row => [row.id, []]));
  result.segments.forEach((segment, index) => { if (segment.id !== null) runs.get(segment.id).push(index); });
  result.metrics.forEach((row, position) => {
    const process = byId(row.id);
    const lane = element('div', 'process-lane');
    lane.style.setProperty('--process-color', process.color);
    lane.dataset.id = row.id;
    const name = element('button', 'lane-name lane-button');
    name.type = 'button';
    name.title = `${row.id}: click to edit, drag up or down to reorder`;
    name.setAttribute('aria-label', `${row.id}, arrival ${row.arrival}, burst ${row.burst}. Edit, reorder or delete.`);
    name.append(element('span', 'legend-dot'), element('span', '', row.id));
    name.addEventListener('pointerdown', event => startLaneDrag(event, row.id, position));
    // Pointer presses open the editor from the drag handler; this covers Enter/Space (a click with detail 0).
    name.addEventListener('click', event => { if (event.detail === 0) openEditor(row.id); });
    const rail = element('div', 'lane-rail');
    rail.style.width = `${x}px`;
    // Waiting = from arrival to completion, minus the time actually spent running.
    const wait = element('span', 'lane-wait');
    wait.style.left = `${timeToX(row.arrival)}px`;
    wait.style.width = `${Math.max(0, timeToX(row.completion) - timeToX(row.arrival))}px`;
    rail.append(wait);
    const arrival = element('span', 'arrival-marker');
    arrival.style.left = `${timeToX(row.arrival)}px`;
    arrival.title = `${row.id} arrives at ${row.arrival}. Drag sideways to change.`;
    makeHandle(arrival, 'arrival', row.id, row.arrival);
    rail.append(arrival);
    lane.append(name, rail);
    $('process-lanes').append(lane);
    rails.set(row.id, rail);
  });
  result.segments.forEach((segment, index) => {
    const name = segment.id === null ? 'Idle' : segment.id;
    const label = `${name}: ${segment.start}–${segment.end} (${units(segment.end - segment.start)})`;
    const block = element('div', `gantt-block${segment.id === null ? ' idle' : ''}`);
    block.style.flex = `0 0 ${axis[index].width}px`;
    if (segment.id !== null) block.style.setProperty('--process-color', byId(segment.id).color);
    block.title = label;
    block.append(element('strong', '', name), element('small', '', `${segment.start}–${segment.end}`));
    $('gantt').append(block);
    ganttBlocks[index] = block;
    $('interval-list').append(element('li', '', label));
    if (segment.id !== null) {
      const bar = element('div', 'lane-bar', `${segment.start}–${segment.end}`);
      bar.style.left = `${axis[index].x}px`;
      bar.style.width = `${axis[index].width}px`;
      bar.title = `${label}. Drag sideways to move ${segment.id}'s arrival.`;
      bar.addEventListener('pointerdown', event => startValueDrag(event, 'arrival', segment.id));
      rails.get(segment.id).append(bar);
      laneBlocks[index] = bar;
    }
  });
  for (const row of result.metrics) {
    const last = axis[runs.get(row.id).at(-1)];
    const grip = element('span', 'burst-handle');
    grip.style.left = `${last.x + last.width}px`;
    grip.title = `${row.id} needs ${units(row.burst)} of CPU. Drag sideways to change.`;
    makeHandle(grip, 'burst', row.id, row.burst);
    rails.get(row.id).append(grip);
  }
  $('gantt').setAttribute('aria-label', `${result.algorithm} CPU timeline, ${result.segments.length} exact intervals. Full textual intervals below the chart.`);
  $('interval-count').textContent = `(${result.segments.length})`;
  drawRuler(result.makespan);
  $('process-legend').replaceChildren();
  const first = result.segments.find(segment => segment.id !== null);
  const example = element('span', 'legend-item');
  example.append(element('code', 'legend-code', `${first.id} ${first.start}–${first.end}`), document.createTextNode(` = ${first.id} ran from time ${first.start} to ${first.end}`));
  $('process-legend').append(example);
  const marker = element('span', 'legend-item');
  marker.append(element('span', 'arrival-dot'), document.createTextNode('= arrives'));
  $('process-legend').append(marker);
  if (result.busyTime < result.makespan) {
    const idle = element('span', 'legend-item');
    idle.append(element('span', 'idle-swatch'), document.createTextNode('= CPU idle'));
    $('process-legend').append(idle);
  }
  if (result.algorithm === 'RR') $('process-legend').append(element('span', 'legend-item', `Quantum ${result.quantum}: each block is one turn, so back-to-back turns of one process are separate blocks.`));
  if (compressed) $('process-legend').append(element('span', 'legend-item', 'Long intervals are compressed; read the labels for exact times.'));
  viewport.scrollLeft = previousScroll;
  lastSegment = -2;
}

function updateScrollHint() {
  const viewport = $('timeline-viewport');
  const overflow = viewport.scrollWidth > viewport.clientWidth + 4;
  const more = viewport.scrollWidth - viewport.clientWidth - viewport.scrollLeft > 4;
  $('scroll-hint').hidden = !overflow;
  $('scroll-hint').textContent = more ? 'The chart continues to the right. Scroll sideways →' : '← Scroll back to the start';
}

function renderMetrics(result) {
  $('avg-waiting').textContent = format(result.averages.waiting);
  $('avg-response').textContent = format(result.averages.response);
  $('avg-turnaround').textContent = format(result.averages.turnaround);
  $('metrics-rows').replaceChildren();
  for (const row of result.metrics) {
    const tr = document.createElement('tr');
    const idCell = document.createElement('td');
    const content = element('span', 'process-cell');
    const dot = element('span', 'legend-dot');
    dot.style.backgroundColor = byId(row.id).color;
    content.append(dot, document.createTextNode(row.id));
    idCell.append(content);
    tr.append(idCell);
    for (const key of ['arrival', 'burst', 'firstStart', 'completion', 'turnaround', 'waiting', 'response']) tr.append(element('td', '', row[key]));
    $('metrics-rows').append(tr);
  }
  const verification = verifyResult(result);
  $('invariant-status').classList.toggle('failed', !verification.passed);
  $('invariant-status').replaceChildren(element('span', 'check-symbol', verification.passed ? '✓' : '!'), element('span', '', verification.passed
    ? 'Self-check passed: every process got exactly its burst, none ran before arriving, nothing overlapped, and the CPU never sat idle while a process was waiting.'
    : `Self-check failed: ${verification.checks.filter(check => !check.passed).map(check => check.name).join(', ')}`));
}

function renderFrame(time, follow = false) {
  if (!playback || !currentResult) return;
  const frame = playback.frameAt(time);
  currentTime = frame.time;
  $('timeline-canvas').classList.toggle('at-start', currentTime === 0 && !playing);
  $('playback-position').textContent = currentTime.toFixed(1);
  $('time-scrubber').value = currentTime;
  $('time-scrubber').setAttribute('aria-valuetext', `${compact(currentTime)} of ${currentResult.makespan} time units`);
  let low = 0;
  let high = playback.events.length;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (playback.events[middle] <= currentTime) low = middle + 1; else high = middle; }
  const eventTime = playback.events[Math.max(0, low - 1)];
  const waiting = frame.ready.map(row => `${row.id} (${units(row.remaining)} left)`).join(', ');
  $('decision-text').textContent = currentTime === 0 && !playing
    ? 'Press Play or Next event to step through the schedule.'
    : `At time ${compact(eventTime)}: ${playback.frameAt(eventTime).eventLabel}${frame.finished ? '' : ` Waiting: ${waiting || 'nobody'}.`}`;
  if (lastSegment !== frame.segmentIndex) {
    currentResult.segments.forEach((segment, index) => {
      for (const block of [ganttBlocks[index], laneBlocks[index]]) {
        if (!block) continue;
        block.classList.toggle('is-current', index === frame.segmentIndex);
        block.classList.toggle('is-future', segment.start > currentTime);
      }
    });
    lastSegment = frame.segmentIndex;
  }
  const position = LANE + timeToX(currentTime);
  $('lane-playhead').style.transform = `translateX(${position}px)`;
  $('playhead-tag').textContent = compact(currentTime);
  const viewport = $('timeline-viewport');
  if (follow && (position > viewport.scrollLeft + viewport.clientWidth - 55 || position < viewport.scrollLeft + 70)) viewport.scrollLeft = Math.max(0, position - viewport.clientWidth / 2);
  if (frame.finished && playing) pausePlayback();
  syncTransport();
}

function renderResult(result) {
  currentResult = result;
  playback = createPlayback(result);
  currentTime = 0;
  const idle = result.makespan - result.busyTime;
  $('timeline-meta').textContent = `${result.metrics.length} processes · ends at ${result.makespan} · CPU idle ${units(idle)}`;
  $('time-scrubber').max = result.makespan;
  $('playback-total').textContent = `ends at ${result.makespan}`;
  renderTimeline(result);
  renderMetrics(result);
  renderFrame(0);
  if (policies[result.algorithm]?.preemptive) {
    $('policy-mode-text').textContent = `${policies[result.algorithm].mode} ${interruptionSummary(result)}`;
  }
}

// A process is interrupted when its slice ends before its burst is done and a different process takes the CPU.
// Back-to-back RR slices of the same process are quantum boundaries, not interruptions.
function interruptionSummary(result) {
  const completion = new Map(result.metrics.map(row => [row.id, row.completion]));
  const counts = new Map();
  result.segments.forEach((segment, index) => {
    const next = result.segments[index + 1];
    if (completion.has(segment.id) && segment.end < completion.get(segment.id) && next && next.id !== segment.id) {
      counts.set(segment.id, (counts.get(segment.id) || 0) + 1);
    }
  });
  if (!counts.size) return 'In this schedule no process was interrupted.';
  return `In this schedule: ${[...counts].map(([id, n]) => `${id} interrupted ${n}×`).join(', ')}.`;
}

/* Value drags: whole time units relative to where the drag started; the schedule is rebuilt on every change. */
function startValueDrag(event, kind, id) {
  if (event.button !== 0 || !currentResult) return;
  event.preventDefault();
  event.stopPropagation();
  const start = byId(id)[kind];
  drag = { type: 'value', kind, id, startX: event.clientX, start, value: start, scale: pixelsPerUnit };
  beginDrag(event, moveValueDrag);
}

function moveValueDrag(event) {
  const value = clamp(drag.start + Math.round((event.clientX - drag.startX) / drag.scale), drag.kind === 'arrival' ? 0 : 1, MAX_VALUE);
  if (value !== drag.value) {
    drag.value = value;
    byId(drag.id)[drag.kind] = value;
    markCustomWorkload();
    run();
  }
  const before = drag.start === drag.value ? '' : ` (was ${drag.start})`;
  showTip(event, drag.kind === 'arrival' ? `${drag.id} arrives at ${drag.value}${before}` : `${drag.id} burst: ${drag.value}${before}`);
}

/* Dropping a new process: the tray button is dragged onto the chart; the drop point is the arrival time. */
function startNewDrag(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  drag = { type: 'new', id: nextId(), startX: event.clientX, startY: event.clientY, moved: false, time: null };
  beginDrag(event, moveNewDrag, endNewDrag);
}

function canvasTime(event) {
  const box = $('timeline-canvas').getBoundingClientRect();
  const viewport = $('timeline-viewport').getBoundingClientRect();
  const inside = event.clientX >= viewport.left && event.clientX <= viewport.right && event.clientY >= box.top - 20 && event.clientY <= box.bottom + 20;
  if (!inside) return null;
  return clamp(Math.round(xToTime(event.clientX - box.left - LANE)), 0, MAX_VALUE);
}

function moveNewDrag(event) {
  if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 6) drag.moved = true;
  drag.time = canvasTime(event);
  $('timeline-canvas').classList.toggle('is-drop-target', drag.time !== null);
  const guide = $('drop-guide');
  guide.hidden = drag.time === null;
  if (drag.time !== null) {
    guide.style.transform = `translateX(${LANE + timeToX(drag.time)}px)`;
    $('drop-guide-tag').textContent = `${drag.id} arrives at ${drag.time}`;
  }
  showTip(event, drag.time === null ? `＋ ${drag.id}: drop it on the chart` : `＋ ${drag.id} · arrival ${drag.time} · burst ${NEW_BURST}`);
}

function endNewDrag() {
  $('drop-guide').hidden = true;
  $('timeline-canvas').classList.remove('is-drop-target');
  if (!drag.moved) addProcess();
  else if (drag.time !== null) addProcess(drag.time);
}

// Keyboard and click fallback: the new process arrives with the latest existing arrival.
function addProcess(time = Math.max(0, ...processes.map(process => process.arrival))) {
  if (processes.length >= 100) {
    $('result-error').textContent = 'At most 100 processes are supported.';
    $('result-error').hidden = false;
    return;
  }
  const process = makeProcess({ id: nextId(), arrival: time, burst: NEW_BURST });
  processes.push(process);
  markCustomWorkload();
  run();
  document.querySelector(`.process-lane[data-id="${CSS.escape(process.id)}"]`)?.classList.add('is-new');
}

/* Reordering: drag a process name up or down; a short press without movement opens the editor instead. */
function startLaneDrag(event, id, position) {
  if (event.button !== 0) return;
  drag = { type: 'lane', id, startY: event.clientY, moved: false, position };
  beginDrag(event, moveLaneDrag, () => {
    if (!drag.moved) { const id = drag.id; drag = null; openEditor(id); }
  });
  event.preventDefault();
}

function moveLaneDrag(event) {
  if (!drag.moved && Math.abs(event.clientY - drag.startY) < 6) return;
  drag.moved = true;
  const lanes = [...$('process-lanes').children];
  let target = lanes.findIndex(lane => { const box = lane.getBoundingClientRect(); return event.clientY < box.top + box.height / 2; });
  if (target === -1) target = lanes.length;
  const from = processes.findIndex(process => process.id === drag.id);
  if (target > from) target--;
  if (target !== from) {
    const [moved] = processes.splice(from, 1);
    processes.splice(target, 0, moved);
    markCustomWorkload();
    run();
  }
  document.querySelector(`.process-lane[data-id="${CSS.escape(drag.id)}"]`)?.classList.add('is-lifted');
  showTip(event, `${drag.id}: position ${processes.findIndex(process => process.id === drag.id) + 1} of ${processes.length}`);
}

function beginDrag(event, move, end) {
  document.body.classList.add('is-dragging');
  const finish = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    document.body.classList.remove('is-dragging');
    $('drag-tip').hidden = true;
    for (const lane of document.querySelectorAll('.process-lane.is-lifted')) lane.classList.remove('is-lifted');
    if (end) end();
    drag = null;
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
  move(event);
}

function showTip(event, text) {
  const tip = $('drag-tip');
  tip.textContent = text;
  tip.style.transform = `translate(${event.clientX + 14}px, ${event.clientY - 36}px)`;
  tip.hidden = false;
}

/* Editor: exact ID, arrival and burst; changes are validated with the engine before they replace the process. */
function openEditor(id) {
  const process = byId(id);
  if (!process) return;
  editing = id;
  $('editor-title').textContent = `Edit ${id}`;
  $('edit-id').value = process.id;
  $('edit-arrival').value = process.arrival;
  $('edit-burst').value = process.burst;
  $('editor-error').hidden = true;
  const index = processes.indexOf(process);
  $('edit-up').disabled = index === 0;
  $('edit-down').disabled = index === processes.length - 1;
  $('process-editor').showModal();
  $('edit-id').select();
}

function saveEditor() {
  const index = processes.findIndex(process => process.id === editing);
  const read = id => $(id).value.trim() === '' ? NaN : Number($(id).value);
  const draft = { ...processes[index], id: $('edit-id').value, arrival: read('edit-arrival'), burst: read('edit-burst') };
  const list = processes.map((process, position) => position === index ? draft : process);
  try {
    simulate(plain(list), 'FCFS');
  } catch (error) {
    $('editor-error').textContent = friendly(error.message, list).replace(/^[^:]+:/, '').trim();
    $('editor-error').hidden = false;
    const field = /burst/i.test(error.message) ? 'edit-burst' : /arrival/i.test(error.message) ? 'edit-arrival' : 'edit-id';
    $(field).focus();
    return;
  }
  draft.id = draft.id.trim();
  processes[index] = draft;
  $('process-editor').close();
  markCustomWorkload();
  run();
  document.querySelector(`.process-lane[data-id="${CSS.escape(draft.id)}"] .lane-button`)?.focus();
}

function moveEditing(step) {
  const from = processes.findIndex(process => process.id === editing);
  const to = from + step;
  if (to < 0 || to >= processes.length) return;
  [processes[from], processes[to]] = [processes[to], processes[from]];
  markCustomWorkload();
  run();
  $('edit-up').disabled = to === 0;
  $('edit-down').disabled = to === processes.length - 1;
}

function animate(timestamp) {
  if (!playing) return;
  if (previousTimestamp !== null) {
    const elapsed = Math.min(200, timestamp - previousTimestamp) / 1000;
    renderFrame(currentTime + elapsed * Number($('playback-speed').value), true);
  }
  previousTimestamp = timestamp;
  if (playing) animationId = requestAnimationFrame(animate);
}

for (const radio of document.querySelectorAll('input[name="algorithm"]')) radio.addEventListener('change', run);
$('quantum').addEventListener('input', run);
$('load-a').addEventListener('click', () => setWorkload('A'));
$('load-b').addEventListener('click', () => setWorkload('B'));
$('load-boundary').addEventListener('click', () => setWorkload('boundary'));
$('clear-all').addEventListener('click', () => { processes = []; colorCounter = 0; markCustomWorkload(); run(); });
$('new-process').addEventListener('pointerdown', startNewDrag);
$('new-process').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); addProcess(); } });
$('editor-form').addEventListener('submit', event => { event.preventDefault(); saveEditor(); });
$('edit-cancel').addEventListener('click', () => $('process-editor').close());
$('edit-up').addEventListener('click', () => moveEditing(-1));
$('edit-down').addEventListener('click', () => moveEditing(1));
$('edit-delete').addEventListener('click', () => {
  processes = processes.filter(process => process.id !== editing);
  $('process-editor').close();
  markCustomWorkload();
  run();
});
$('timeline-viewport').addEventListener('scroll', updateScrollHint, { passive: true });
window.addEventListener('resize', () => { if (currentResult) { renderTimeline(currentResult); renderFrame(currentTime); } else if (!processes.length) renderEmpty(); });
$('play-playback').addEventListener('click', () => {
  if (playing) { pausePlayback(); return; }
  if (!currentResult) return;
  if (currentTime >= currentResult.makespan) renderFrame(0, true);
  $('decision-text').setAttribute('aria-live', 'off');
  playing = true;
  previousTimestamp = null;
  syncTransport();
  animationId = requestAnimationFrame(animate);
});
$('reset-playback').addEventListener('click', () => { pausePlayback(); renderFrame(0, true); });
$('next-event').addEventListener('click', () => {
  pausePlayback();
  $('decision-text').setAttribute('aria-live', 'polite');
  const next = playback?.events.find(time => time > currentTime + 1e-8);
  if (next !== undefined) renderFrame(next, true);
});
$('time-scrubber').addEventListener('input', event => { pausePlayback(); renderFrame(Number(event.target.value), true); });
$('time-scrubber').addEventListener('keydown', event => {
  if (!currentResult || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); pausePlayback();
  const target = event.key === 'Home' ? 0 : event.key === 'End' ? currentResult.makespan : currentTime + (event.key === 'ArrowRight' ? 1 : -1);
  renderFrame(target, true);
});
document.addEventListener('visibilitychange', () => { if (document.hidden) pausePlayback(); });

// Clicking "Preemptive", "Non-preemptive" or "Quantum" explains it with a two-process example; clicking it again closes it.
let openMode = null;
function showModeHelp(kind) {
  openMode = kind;
  $('mode-help').hidden = kind === null;
  $('mode-help').classList.toggle('is-preemptive', kind === 'pre');
  $('mode-help').classList.toggle('is-quantum', kind === 'quantum');
  for (const body of document.querySelectorAll('[data-mode-panel]')) body.hidden = body.dataset.modePanel !== kind;
  for (const trigger of document.querySelectorAll('[data-mode-help]')) trigger.setAttribute('aria-expanded', String(trigger.dataset.modeHelp === kind));
}
for (const trigger of document.querySelectorAll('[data-mode-help]')) {
  trigger.addEventListener('click', () => showModeHelp(openMode === trigger.dataset.modeHelp ? null : trigger.dataset.modeHelp));
}
$('mode-help-close').addEventListener('click', () => { const back = document.querySelector(`[data-mode-help="${openMode}"]`); showModeHelp(null); back?.focus(); });
$('mode-help').addEventListener('keydown', event => { if (event.key === 'Escape') $('mode-help-close').click(); });
setWorkload('A');
