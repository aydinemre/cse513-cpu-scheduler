# CPU Scheduling Simulator (CSE513 Assignment 1)

Live: https://aydinemre.github.io/cse513-cpu-scheduler/

A dependency-free, browser-only simulator for FCFS, non-preemptive SJF,
preemptive SRTF and Round Robin. Build the workload directly on the Gantt
chart: drop processes on it, drag them to change arrival time and CPU burst,
and read the per-process metrics and averages below the chart.

## Run locally

Browser module security requires HTTP, so serve the folder instead of opening
`index.html` from disk:

```sh
python3 -m http.server 5130 --bind 127.0.0.1
```

Then open http://127.0.0.1:5130. No build step, packages or backend are needed.

## Model

One CPU, one CPU burst per process, no I/O, zero-cost context switches,
integer times. Ties go to the earlier arrival, then the process listed higher.
SRTF preempts only for strictly shorter remaining time. In Round Robin,
arrivals at a quantum boundary are queued before the unfinished process.
This models scheduling policies; it does not reproduce Ubuntu's scheduler.
