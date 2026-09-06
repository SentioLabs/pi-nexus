export function createFakeEventBus() {
  const listeners = new Map();
  return {
    on(name, fn) {
      const set = listeners.get(name) ?? new Set();
      set.add(fn);
      listeners.set(name, set);
      return () => set.delete(fn);
    },
    emit(name, value) {
      for (const fn of [...(listeners.get(name) ?? [])]) fn(value);
    },
    listenerCount(name) {
      return listeners.get(name)?.size ?? 0;
    },
  };
}
