export function retryClock(start = 1000) {
  let now = start, sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay) {
      const token = { id: ++sequence, unref() {} };
      timers.set(token, { at: now + delay, fn });
      return token;
    },
    clearTimeout(token) { timers.delete(token); },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...timers].filter(([, t]) => t.at <= until).sort((a,b) => a[1].at-b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn();
        await new Promise(resolve => setImmediate(resolve));
      }
      now = until;
      await new Promise(resolve => setImmediate(resolve));
    },
    get size() { return timers.size; },
  };
}
