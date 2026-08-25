export type LogLevel = 'info' | 'warn' | 'error' | 'net';

export interface LogEntry {
  at: number;
  level: LogLevel;
  message: string;
  detail?: unknown;
}

/**
 * Everything interesting goes to two places: the on-page log so a human can see
 * it without opening devtools, and `console` so automated verification can read
 * it over the DevTools protocol. Kept in an array too, so `window.__dino.logs`
 * is a full transcript.
 */
export class Log {
  readonly entries: LogEntry[] = [];
  #sinks = new Set<(entry: LogEntry) => void>();

  onEntry(fn: (entry: LogEntry) => void): () => void {
    this.#sinks.add(fn);
    for (const entry of this.entries) fn(entry);
    return () => this.#sinks.delete(fn);
  }

  info(message: string, detail?: unknown): void {
    this.#push('info', message, detail);
  }
  net(message: string, detail?: unknown): void {
    this.#push('net', message, detail);
  }
  warn(message: string, detail?: unknown): void {
    this.#push('warn', message, detail);
  }
  error(message: string, detail?: unknown): void {
    this.#push('error', message, detail);
  }

  #push(level: LogLevel, message: string, detail?: unknown): void {
    const entry: LogEntry = detail === undefined ? { at: Date.now(), level, message } : { at: Date.now(), level, message, detail };
    this.entries.push(entry);
    const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
    if (detail === undefined) consoleFn(`[dino] ${message}`);
    else consoleFn(`[dino] ${message}`, detail);
    for (const sink of this.#sinks) sink(entry);
  }
}
