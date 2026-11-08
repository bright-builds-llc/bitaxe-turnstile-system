/**
 * A page-wide clock whose timers run in a dedicated Worker. Chrome throttles a hidden page's own timers to one
 * wake-up a second, then to one a minute, which breaks the Worker Serial heartbeat; a dedicated Worker's timers
 * keep their cadence, and the page still handles its messages promptly (ADR-0110).
 */
export type PageClock = {
  every(milliseconds: number, listener: () => void): () => void;
  after(milliseconds: number, listener: () => void): () => void;
};

export type ClockRequest = { op: "every" | "after"; id: number; milliseconds: number } | { op: "cancel"; id: number };

/** The few Worker operations the clock uses, so tests can stand in for the Worker. */
export type ClockPort = {
  post(request: ClockRequest): void;
  listen(onTick: (id: unknown) => void, onError: () => void): void;
  terminate(): void;
};

export type FallbackTimers = {
  setInterval(listener: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(listener: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
};

type Schedule = {
  kind: "every" | "after";
  milliseconds: number;
  listener: () => void;
  maybeCancelFallback?: () => void;
};

const WORKER_SOURCE = `const timers = new Map();
onmessage = ({ data }) => {
  if (data.op === "cancel") { clearTimeout(timers.get(data.id)); clearInterval(timers.get(data.id)); timers.delete(data.id); return; }
  if (data.op === "every") { timers.set(data.id, setInterval(() => postMessage(data.id), data.milliseconds)); return; }
  timers.set(data.id, setTimeout(() => { timers.delete(data.id); postMessage(data.id); }, data.milliseconds));
};`;

/** Runs schedules on the port while it works, and on the page's own timers without one or after it fails. */
export function createPageClock(timers: FallbackTimers, maybePort?: ClockPort): PageClock {
  const live = new Map<number, Schedule>();
  let next = 0;
  let maybeWorker = maybePort;

  const armFallback = (id: number, schedule: Schedule) => {
    if (schedule.kind === "every") {
      const handle = timers.setInterval(schedule.listener, schedule.milliseconds);
      schedule.maybeCancelFallback = () => timers.clearInterval(handle);
      return;
    }
    const handle = timers.setTimeout(() => {
      live.delete(id);
      schedule.listener();
    }, schedule.milliseconds);
    schedule.maybeCancelFallback = () => timers.clearTimeout(handle);
  };
  const arm = (id: number, schedule: Schedule) => {
    if (maybeWorker) maybeWorker.post({ op: schedule.kind, id, milliseconds: schedule.milliseconds });
    else armFallback(id, schedule);
  };

  maybeWorker?.listen(
    (id) => {
      if (typeof id !== "number") return;
      const maybeSchedule = live.get(id);
      if (!maybeSchedule) return;
      if (maybeSchedule.kind === "after") live.delete(id);
      maybeSchedule.listener();
    },
    () => {
      // A failed Worker must not silently stop the heartbeat; a re-armed `after` restarts its full delay, which
      // only makes a deadline later.
      maybeWorker?.terminate();
      maybeWorker = undefined;
      for (const [id, schedule] of live) armFallback(id, schedule);
    },
  );

  const schedule = (kind: Schedule["kind"]) => (milliseconds: number, listener: () => void) => {
    const id = ++next;
    const entry: Schedule = { kind, milliseconds, listener };
    live.set(id, entry);
    arm(id, entry);
    return () => {
      if (!live.delete(id)) return;
      if (entry.maybeCancelFallback) entry.maybeCancelFallback();
      else maybeWorker?.post({ op: "cancel", id });
    };
  };
  return { every: schedule("every"), after: schedule("after") };
}

function maybeBrowserClockPort(): ClockPort | undefined {
  if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL.createObjectURL !== "function")
    return undefined;
  let worker: Worker;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" })));
  } catch {
    // A page that forbids blob: Workers keeps working on its own timers, as it did before ADR-0110.
    return undefined;
  }
  return {
    post: (request) => worker.postMessage(request),
    listen: (onTick, onError) => {
      worker.onmessage = (event) => onTick(event.data);
      worker.onerror = () => onError();
    },
    terminate: () => worker.terminate(),
  };
}

let maybeShared: PageClock | undefined;

/** The page's one clock, created on first use. */
export function pageClock(): PageClock {
  maybeShared ??= createPageClock(
    {
      setInterval: (listener, milliseconds) => setInterval(listener, milliseconds),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
      setTimeout: (listener, milliseconds) => setTimeout(listener, milliseconds),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    maybeBrowserClockPort(),
  );
  return maybeShared;
}
