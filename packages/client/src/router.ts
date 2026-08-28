/**
 * A hash router, in about sixty lines.
 *
 * Hash and not the History API, for one concrete reason: this ships to GitHub
 * Pages, which serves static files and has no SPA fallback. `/room/ABC` would
 * 404 on a refresh or on a link someone pasted, and the usual workaround — a
 * `404.html` that re-serves the app — turns every mistyped URL into a silent
 * soft-200. A fragment never reaches the server at all, so a shared link works
 * on the first try from any host, including `file://`.
 *
 * It is also why there is no router dependency here. The whole surface this app
 * needs is "read a code out of the URL, put one back in, and tell me when it
 * changes", and that is smaller than the code required to configure a library.
 */

/** Path segments after the `#`, e.g. `#/join/ABC` -> `['join', 'ABC']`. */
type Params = Record<string, string>;
type Handler = (params: Params) => void;

interface Route {
  /** `/join/:code` — a `:name` segment captures, anything else must match. */
  readonly pattern: readonly string[];
  readonly handler: Handler;
}

function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** Everything after `#`, normalised to a leading slash and no trailing one. */
export function currentPath(): string {
  const raw = location.hash.replace(/^#/, '');
  return `/${segments(raw).join('/')}`;
}

export class Router {
  #routes: Route[] = [];
  #fallback: Handler = () => {};
  #started = false;
  /**
   * Set while we are the ones changing the hash. `navigate()` would otherwise
   * fire `hashchange` and re-enter the handler that called it, which turns
   * "show the room" into an infinite loop the first time a route both renders
   * and redirects.
   */
  #suppress = false;

  on(pattern: string, handler: Handler): this {
    this.#routes.push({ pattern: segments(pattern), handler });
    return this;
  }

  otherwise(handler: Handler): this {
    this.#fallback = handler;
    return this;
  }

  /**
   * Replace the hash without adding a history entry.
   *
   * `replace` rather than `push` for the room: a player who joins and then hits
   * Back expects to leave the room, not to walk through every state the room
   * passed through on the way in.
   */
  navigate(path: string, { replace = true } = {}): void {
    const target = `#${path}`;
    if (location.hash === target) return;
    this.#suppress = true;
    if (replace) history.replaceState(null, '', target);
    else location.hash = target;
    this.#suppress = false;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    addEventListener('hashchange', () => {
      if (!this.#suppress) this.resolve();
    });
    this.resolve();
  }

  /** Run the handler for whatever is in the URL right now. */
  resolve(): void {
    const parts = segments(currentPath());
    for (const route of this.#routes) {
      const params = match(route.pattern, parts);
      if (params) {
        route.handler(params);
        return;
      }
    }
    this.#fallback({});
  }
}

function match(pattern: readonly string[], parts: readonly string[]): Params | null {
  if (pattern.length !== parts.length) return null;
  const params: Params = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const p = pattern[i] as string;
    const value = parts[i] as string;
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(value);
    else if (p !== value) return null;
  }
  return params;
}

/** The link a host hands out. Absolute, so it survives being pasted anywhere. */
export function joinLink(roomCode: string): string {
  return `${location.origin}${location.pathname}#/join/${encodeURIComponent(roomCode)}`;
}
