/**
 * Tiny typed multi-listener helper. Every `on*` method on Transport returns an
 * Unsubscribe so callers can tear down cleanly without a separate `off` API.
 */
export type Unsubscribe = () => void;

export class Signal<Args extends unknown[]> {
  #listeners = new Set<(...args: Args) => void>();

  on(fn: (...args: Args) => void): Unsubscribe {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  emit(...args: Args): void {
    // Copy first: a listener may unsubscribe itself (or others) during dispatch.
    for (const fn of [...this.#listeners]) {
      try {
        fn(...args);
      } catch (err) {
        console.error('[signal] listener threw', err);
      }
    }
  }

  clear(): void {
    this.#listeners.clear();
  }

  get size(): number {
    return this.#listeners.size;
  }
}
