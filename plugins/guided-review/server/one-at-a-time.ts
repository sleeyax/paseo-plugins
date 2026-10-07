/**
 * Runs work one at a time per key: each run starts once every earlier run under its key has settled,
 * whether it succeeded or not, and a key is forgotten once nothing is queued under it. Each call
 * makes a queue of its own, which is what callers share.
 */
export function oneAtATimePer<K>(): <T>(key: K, run: () => Promise<T>) => Promise<T> {
  const last = new Map<K, Promise<unknown>>();
  return <T>(key: K, run: () => Promise<T>): Promise<T> => {
    const next = (last.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
    last.set(key, next);
    const forget = () => {
      if (last.get(key) === next) last.delete(key);
    };
    next.then(forget, forget);
    return next;
  };
}
