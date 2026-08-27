/**
 * Minimal Chrome DevTools Protocol driver. Zero dependencies: Node 26 has a
 * global WebSocket. Used to verify milestones by driving real browser tabs with
 * real input events, reading real console output, and taking real screenshots.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * Launches a throwaway Chrome and returns the DevTools endpoint it picked.
 *
 * The debugging port is deliberately ephemeral (`=0`, then read back from
 * DevToolsActivePort). A fixed port looks simpler right up until a previous run
 * is killed mid-flight: the orphan keeps answering on that port, the next run
 * silently attaches to *it* instead of a fresh browser, and you spend an hour
 * debugging the app instead of the harness.
 */
export async function launchChrome({ headless = true, profileDir } = {}) {
  const dir = profileDir ?? `/tmp/cdp-profile-${process.pid}-${Date.now()}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    'about:blank',
  ];
  if (headless) args.unshift('--headless=new');
  // Detached so we can take the whole process group down; Chrome's renderer
  // children outlive a kill aimed only at the parent.
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));

  const kill = () => {
    try {
      process.kill(-proc.pid, 'SIGKILL');
    } catch {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  };
  process.on('exit', kill);

  const portFile = join(dir, 'DevToolsActivePort');
  const deadline = Date.now() + 30000;
  for (;;) {
    let port = null;
    try {
      port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
    } catch {
      /* not written yet */
    }
    if (port) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (r.ok) return { proc, port, kill, info: await r.json(), profileDir: dir };
      } catch {
        /* not listening yet */
      }
    }
    if (Date.now() > deadline) {
      kill();
      throw new Error(`Chrome never exposed CDP. stderr:\n${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

class Conn {
  #ws;
  #next = 1;
  #pending = new Map();
  #handlers = new Set();

  static async open(url) {
    const c = new Conn();
    c.#ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      c.#ws.addEventListener('open', resolve, { once: true });
      c.#ws.addEventListener('error', () => reject(new Error(`cdp socket failed: ${url}`)), { once: true });
    });
    c.#ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (msg.id !== undefined) {
        const p = c.#pending.get(msg.id);
        if (!p) return;
        c.#pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else p.resolve(msg.result);
      } else {
        for (const h of c.#handlers) h(msg);
      }
    });
    return c;
  }

  send(method, params = {}, sessionId) {
    const id = this.#next++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.#ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 30000);
    });
  }

  onEvent(fn) {
    this.#handlers.add(fn);
    return () => this.#handlers.delete(fn);
  }

  close() {
    this.#ws.close();
  }
}

export class Tab {
  constructor(conn, sessionId, name) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.name = name;
    this.console = [];
    this.errors = [];
  }

  static async create(conn, url, name) {
    const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(conn, sessionId, name);
    tab.targetId = targetId;
    conn.onEvent((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.consoleAPICalled') {
        tab.console.push({
          at: Date.now(),
          type: msg.params.type,
          text: msg.params.args.map(renderRemote).join(' '),
        });
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        tab.errors.push(d.exception?.description ?? d.text);
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        tab.errors.push(`[${msg.params.entry.source}] ${msg.params.entry.text}`);
      }
    });
    await conn.send('Runtime.enable', {}, sessionId);
    await conn.send('DOM.enable', {}, sessionId);
    await conn.send('Log.enable', {}, sessionId);
    await conn.send('Page.enable', {}, sessionId);
    if (url && url !== 'about:blank') await tab.goto(url);
    return tab;
  }

  async goto(url) {
    await this.conn.send('Page.navigate', { url }, this.sessionId);
    await this.waitFor('document.readyState === "complete"', 20000);
  }

  async eval(expression, { awaitPromise = true } = {}) {
    const res = await this.conn.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise, userGesture: false },
      this.sessionId,
    );
    if (res.exceptionDetails) {
      throw new Error(`${this.name}: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    return res.result.value;
  }

  async waitFor(expression, timeoutMs = 15000, label = expression) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let value;
      try {
        value = await this.eval(`(() => { try { return (${expression}); } catch { return undefined; } })()`);
      } catch {
        value = undefined;
      }
      if (value) return value;
      if (Date.now() > deadline) {
        // Dying blind here costs more time than the check saves.
        const tail = this.console.slice(-6).map((c) => `      ${c.type}: ${c.text.slice(0, 160)}`).join('\n');
        const errs = this.errors.length ? `\n    errors:\n      ${this.errors.join('\n      ')}` : '';
        throw new Error(`${this.name}: timed out waiting for ${label}\n    last console:\n${tail}${errs}`);
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  /** Real trusted mouse input, so user-activation-gated APIs behave normally. */
  async clickSelector(selector) {
    const box = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`${this.name}: no element matches ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.conn.send(
        'Input.dispatchMouseEvent',
        { type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 },
        this.sessionId,
      );
    }
  }

  async typeInto(selector, text) {
    await this.clickSelector(selector);
    await this.eval(`document.querySelector(${JSON.stringify(selector)}).value = ''`);
    for (const ch of text) {
      await this.conn.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch }, this.sessionId);
      await this.conn.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch }, this.sessionId);
    }
  }

  /** Real trusted key events, so app keydown/keyup handlers see the real thing. */
  async keyEvent(type, { code, key, vk }) {
    await this.conn.send(
      'Input.dispatchKeyEvent',
      {
        type,
        code,
        key,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        ...(type === 'char' ? { text: key } : {}),
      },
      this.sessionId,
    );
  }

  async holdKey(spec, ms) {
    await this.keyEvent('rawKeyDown', spec);
    await new Promise((r) => setTimeout(r, ms));
    await this.keyEvent('keyUp', spec);
  }

  async pressEnter() {
    const base = { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter' };
    await this.conn.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, this.sessionId);
    await this.conn.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...base }, this.sessionId);
    await this.conn.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, this.sessionId);
  }

  /** Drive a real <input type=file>, which is otherwise unreachable from JS. */
  async setFileInput(selector, filePath) {
    const { root } = await this.conn.send('DOM.getDocument', { depth: 1 }, this.sessionId);
    const { nodeId } = await this.conn.send(
      'DOM.querySelector',
      { nodeId: root.nodeId, selector },
      this.sessionId,
    );
    if (!nodeId) throw new Error(`${this.name}: no file input matches ${selector}`);
    await this.conn.send('DOM.setFileInputFiles', { files: [filePath], nodeId }, this.sessionId);
  }

  async screenshot(path) {
    await this.conn.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1400, deviceScaleFactor: 2, mobile: false }, this.sessionId);
    const { data } = await this.conn.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, this.sessionId);
    writeFileSync(path, Buffer.from(data, 'base64'));
    await this.conn.send('Emulation.clearDeviceMetricsOverride', {}, this.sessionId);
    return path;
  }

  /** Poll the captured console for a line. Console arrives asynchronously, so
   *  asserting on it with a bare `.some()` is a race. */
  async waitForConsole(pattern, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.console.find((c) => pattern.test(c.text));
      if (hit) return hit;
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  consoleText() {
    return this.console.map((c) => `${c.type}: ${c.text}`).join('\n');
  }
}

function renderRemote(arg) {
  if (arg.type === 'string') return arg.value;
  if ('value' in arg) return JSON.stringify(arg.value);
  if (arg.preview) return previewToString(arg.preview);
  return arg.description ?? arg.type;
}

function previewToString(preview) {
  if (preview.subtype === 'array') {
    return `[${(preview.properties ?? []).map((p) => p.value).join(', ')}${preview.overflow ? ', …' : ''}]`;
  }
  const props = (preview.properties ?? []).map((p) => `${p.name}: ${p.value}`).join(', ');
  return `{${props}${preview.overflow ? ', …' : ''}}`;
}

/**
 * Loads the app once and throws the tab away.
 *
 * Vite transforms modules on first request, so a cold dev server makes the
 * first real navigation arbitrarily slow — slow enough to blow a timeout and
 * look exactly like an application hang. Paying that cost somewhere clearly
 * labelled beats debugging a phantom.
 */
export async function warmUp(conn, url) {
  const tab = await Tab.create(conn, url, 'WARMUP');
  const t0 = Date.now();
  try {
    await tab.waitFor('typeof window.__dino === "object"', 180000, 'app module graph');
  } finally {
    await conn.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
  }
  return Date.now() - t0;
}

export async function connectBrowser(port) {
  const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  return Conn.open(info.webSocketDebuggerUrl);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
