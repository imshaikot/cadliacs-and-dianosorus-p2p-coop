import { formatRoomCode } from '@dino/shared';
import type { ChannelDiagnostics, TransportStatus } from '@dino/shared';

import type { MachineStats } from './emulator/machine.js';
import type { LockstepStats } from './net/lockstep.js';
import type { LogEntry } from './log.js';
import type { Player } from './session.js';

function must<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as unknown as T;
}

export interface UICallbacks {
  onHost: () => void;
  onJoin: (rawCode: string) => void;
  onLeave: () => void;
  onChat: (text: string) => void;
  onRomPicked: (file: File) => void;
}

export class UI {
  readonly #landing = must<HTMLElement>('view-landing');
  readonly #room = must<HTMLElement>('view-room');
  readonly #btnHost = must<HTMLButtonElement>('btn-host');
  readonly #btnJoin = must<HTMLButtonElement>('btn-join');
  readonly #btnLeave = must<HTMLButtonElement>('btn-leave');
  readonly #btnCopy = must<HTMLButtonElement>('btn-copy');
  readonly #joinForm = must<HTMLFormElement>('join-form');
  readonly #codeInput = must<HTMLInputElement>('input-code');
  readonly #landingError = must<HTMLElement>('landing-error');
  readonly #roomCode = must<HTMLElement>('room-code');
  readonly #codeLabel = must<HTMLElement>('code-label');
  readonly #statusPill = must<HTMLElement>('status-pill');
  readonly #roster = must<HTMLOListElement>('roster');
  readonly #chatForm = must<HTMLFormElement>('chat-form');
  readonly #chatInput = must<HTMLInputElement>('chat-input');
  readonly #chatLog = must<HTMLOListElement>('chat-log');
  readonly #logList = must<HTMLOListElement>('log-list');
  readonly #channelTable = must<HTMLPreElement>('channel-table');
  readonly #brokerLine = must<HTMLElement>('broker-line');
  readonly #screen = must<HTMLCanvasElement>('screen');
  readonly #stageMessage = must<HTMLElement>('stage-message');
  readonly #romPicker = must<HTMLElement>('rom-picker');
  readonly #romFile = must<HTMLInputElement>('rom-file');
  readonly #hud = must<HTMLElement>('emu-hud');
  readonly #netHud = must<HTMLElement>('net-hud');
  #shareText = '';

  constructor(cb: UICallbacks) {
    this.#btnHost.addEventListener('click', () => cb.onHost());
    this.#joinForm.addEventListener('submit', (e) => {
      e.preventDefault();
      cb.onJoin(this.#codeInput.value);
    });
    this.#btnLeave.addEventListener('click', () => cb.onLeave());
    this.#chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      cb.onChat(this.#chatInput.value);
      this.#chatInput.value = '';
    });
    this.#romFile.addEventListener('change', () => {
      const file = this.#romFile.files?.[0];
      if (file) cb.onRomPicked(file);
    });
    this.#btnCopy.addEventListener('click', () => {
      void navigator.clipboard?.writeText(this.#shareText);
      this.#btnCopy.textContent = 'copied';
      setTimeout(() => (this.#btnCopy.textContent = 'copy'), 1200);
    });
  }

  setBroker(description: string): void {
    this.#brokerLine.textContent = `signalling via ${description}`;
  }

  prefillCode(code: string): void {
    this.#codeInput.value = formatRoomCode(code);
  }

  setBusy(busy: boolean): void {
    this.#btnHost.disabled = busy;
    this.#btnJoin.disabled = busy;
  }

  showError(message: string): void {
    this.#landingError.textContent = message;
  }

  showRoom(role: 'host' | 'guest', roomCode: string): void {
    this.#landing.hidden = true;
    this.#room.hidden = false;
    this.#codeLabel.textContent = role === 'host' ? 'ROOM CODE — share this' : 'JOINED ROOM';
    this.#roomCode.textContent = formatRoomCode(roomCode);
    // A host shares a link; a guest has nothing useful to hand on but the code.
    this.#shareText =
      role === 'host'
        ? `${location.origin}${location.pathname}?join=${roomCode}`
        : formatRoomCode(roomCode);
    this.#btnCopy.title = this.#shareText;
  }

  showLanding(): void {
    this.#landing.hidden = false;
    this.#room.hidden = true;
    this.setBusy(false);
  }

  setStatus(status: TransportStatus, detail: string): void {
    this.#statusPill.textContent = status;
    this.#statusPill.dataset['status'] = status;
    this.#statusPill.title = detail;
  }

  renderRoster(players: Player[]): void {
    this.#roster.replaceChildren(
      ...players.map((p) => {
        const li = document.createElement('li');
        li.dataset['slot'] = String(p.slot);
        li.innerHTML =
          `<span class="slot">P${p.slot}</span>` +
          `<span class="who"></span>` +
          `<span class="peer-id"></span>` +
          (p.isSelf ? '<span class="you">you</span>' : '');
        li.querySelector('.who')!.textContent = p.label;
        li.querySelector('.peer-id')!.textContent = p.peerId;
        return li;
      }),
    );
  }

  appendChat(entry: { label: string; text: string; mine: boolean }): void {
    const li = document.createElement('li');
    li.dataset['mine'] = String(entry.mine);
    const from = document.createElement('span');
    from.className = 'from';
    from.textContent = entry.mine ? 'you' : entry.label;
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = entry.text;
    li.append(from, text);
    this.#chatLog.append(li);
    this.#chatLog.scrollTop = this.#chatLog.scrollHeight;
  }

  appendLog(entry: LogEntry): void {
    const li = document.createElement('li');
    li.dataset['level'] = entry.level;
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = new Date(entry.at).toISOString().slice(11, 23);
    const body = document.createElement('span');
    body.textContent =
      entry.detail === undefined ? entry.message : `${entry.message} ${safeJson(entry.detail)}`;
    li.append(ts, body);
    this.#logList.append(li);
    this.#logList.scrollTop = this.#logList.scrollHeight;
  }

  /** The canvas the emulator blits into. Also what M2 will captureStream(). */
  get screen(): HTMLCanvasElement {
    return this.#screen;
  }

  showStageMessage(message: string): void {
    this.#stageMessage.textContent = message;
    this.#stageMessage.hidden = false;
    this.#screen.hidden = true;
  }

  showRomPicker(show: boolean): void {
    this.#romPicker.hidden = !show;
    this.#stageMessage.hidden = show;
  }

  showScreen(): void {
    this.#screen.hidden = false;
    this.#stageMessage.hidden = true;
    this.#romPicker.hidden = true;
  }

  setNetStatus(phase: string, detail: string): void {
    this.#netHud.hidden = false;
    this.#netHud.dataset['phase'] = phase;
    this.#netHud.title = detail;
  }

  renderHud(stats: MachineStats, targetFps: number, net: LockstepStats | null): void {
    this.#hud.hidden = false;
    // Anything below ~58fps on a 59.63Hz target is visible as slowdown.
    const behind = stats.emulatedFps > 0 && stats.emulatedFps < targetFps - 1.5;
    this.#hud.dataset['warn'] = String(behind);
    this.#hud.replaceChildren(
      field('emulated', `${stats.emulatedFps.toFixed(1)} / ${targetFps.toFixed(2)} fps`),
      field('frame cost', `${stats.frameTimeMs.toFixed(2)} ms`),
      field('frames', String(stats.frames)),
      field('audio buffer', `${stats.audio.fill} smp`),
      field('underruns', String(stats.audio.underruns)),
      field('drift fixes', `${stats.audio.dropped}/${stats.audio.repeated}`),
    );
    this.#renderNetHud(stats, net);
  }

  #renderNetHud(stats: MachineStats, net: LockstepStats | null): void {
    if (!net || !net.running) {
      if (this.#netHud.dataset['phase'] === undefined) this.#netHud.hidden = true;
      return;
    }
    this.#netHud.hidden = false;
    this.#netHud.dataset['warn'] = String(stats.stalled);
    const phase = document.createElement('b');
    phase.className = 'phase';
    phase.textContent = stats.stalled ? `stalled on P${net.waitingFor.map((p) => p + 1).join(',P')}` : 'lockstep';
    const lead = Object.entries(net.leadByPort)
      .map(([port, frames]) => `P${Number(port) + 1}:${frames >= 0 ? '+' : ''}${frames}`)
      .join(' ');
    this.#netHud.replaceChildren(
      phase,
      field('frame', String(net.frame)),
      field('input delay', `${net.delayFrames}f / ${(net.delayFrames * 16.78).toFixed(0)}ms`),
      field('lead', lead || '—'),
      field('stalls', `${net.stalls} (${net.stalledFrames}f)`),
      field('pkts', `${net.packetsOut}\u2191 ${net.packetsIn}\u2193`),
    );
  }

  hideHud(): void {
    this.#hud.hidden = true;
  }

  renderChannels(rows: ChannelDiagnostics[]): void {
    if (rows.length === 0) {
      this.#channelTable.textContent = 'no peers yet';
      return;
    }
    const header = ['kind', 'label', 'state', 'asked reliable', 'ordered', 'maxRetransmits', 'maxPacketLifeTime', 'peer'];
    const body = rows.map((r) => [
      r.kind,
      r.label,
      r.readyState,
      String(r.requestedReliable),
      String(r.ordered),
      String(r.maxRetransmits),
      String(r.maxPacketLifeTime),
      r.peerId,
    ]);
    this.#channelTable.textContent = formatTable([header, ...body]);
  }
}

function field(label: string, value: string): HTMLElement {
  const span = document.createElement('span');
  span.append(`${label} `);
  const b = document.createElement('b');
  b.textContent = value;
  span.append(b);
  return span;
}

function formatTable(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ')).join('\n');
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
