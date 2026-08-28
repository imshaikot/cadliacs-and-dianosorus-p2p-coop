import {
  AVATAR_IDS,
  CAPACITY_CHOICES,
  DEFAULT_AVATAR,
  DEFAULT_CAPACITY,
  coerceAvatar,
  coerceCapacity,
  coerceName,
  formatRoomCode,
} from '@retro/shared';
import type { AvatarId, ChannelDiagnostics, PeerId, TransportStatus } from '@retro/shared';

import { avatarDefs, avatarName, avatarSvg } from './avatars.js';
import { isTyping } from './emulator/input.js';
import type { MachineStats } from './emulator/machine.js';
import type { LockstepStats } from './net/lockstep.js';
import type { LogEntry } from './log.js';
import { joinLink } from './router.js';
import type { Player } from './session.js';

/** How long the pointer must sit still before fullscreen hides its furniture. */
const IDLE_MS = 2500;

/** So a returning player does not retype their name every session. */
const STORE_NAME = 'retro.name';
const STORE_AVATAR = 'retro.avatar';
const STORE_CAPACITY = 'retro.capacity';

/** localStorage throws outright in a locked-down profile; a name is not worth it. */
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode, or storage disabled */
  }
}

function recall(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function must<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as unknown as T;
}

export interface Identity {
  name: string;
  avatar: AvatarId;
  /** Host only. A guest's copy is ignored — the host's `welcome` decides. */
  capacity: number;
}

export interface UICallbacks {
  onHost: (identity: Identity) => void;
  onJoin: (rawCode: string, identity: Identity) => void;
  onLeave: () => void;
  onChat: (text: string) => void;
  onRomPicked: (file: File) => void;
  onToggleMic: () => void;
  /** Silence one player for this listener only. */
  onPeerAudible: (peerId: PeerId, audible: boolean) => void;
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
  readonly #stageWrap = must<HTMLElement>('stage-wrap');
  readonly #stage = must<HTMLElement>('stage');
  readonly #btnFull = must<HTMLButtonElement>('btn-fullscreen');
  readonly #stageMessage = must<HTMLElement>('stage-message');
  readonly #romPicker = must<HTMLElement>('rom-picker');
  readonly #romPickerLead = must<HTMLElement>('rom-picker-lead');
  readonly #romBar = must<HTMLElement>('rom-bar');
  readonly #romWait = must<HTMLElement>('rom-wait');
  readonly #romFile = must<HTMLInputElement>('rom-file');
  readonly #romProgress = must<HTMLElement>('rom-progress');
  readonly #romNote = must<HTMLElement>('rom-note');
  readonly #hud = must<HTMLElement>('emu-hud');
  readonly #netHud = must<HTMLElement>('net-hud');
  readonly #dialog = must<HTMLDialogElement>('identity-modal');
  readonly #identityForm = must<HTMLFormElement>('identity-form');
  readonly #identityTitle = must<HTMLElement>('identity-title');
  readonly #identityError = must<HTMLElement>('identity-error');
  readonly #identityNote = must<HTMLElement>('identity-note');
  readonly #nameInput = must<HTMLInputElement>('input-name');
  readonly #avatarGrid = must<HTMLElement>('avatar-grid');
  readonly #capacityBlock = must<HTMLElement>('capacity-block');
  readonly #capacityGrid = must<HTMLElement>('capacity-grid');
  readonly #btnIdentityGo = must<HTMLButtonElement>('btn-identity-go');
  readonly #btnIdentityCancel = must<HTMLButtonElement>('btn-identity-cancel');
  readonly #avatarDefs = must<SVGSVGElement>('avatar-defs');
  readonly #voiceSinks = must<HTMLElement>('voice-sinks');
  readonly #lobbyCount = must<HTMLElement>('lobby-count');
  readonly #speakingBar = must<HTMLElement>('speaking');
  readonly #authorView = must<HTMLElement>('view-author');
  #shareText = '';
  /** Which side of the room we are on. Decides who gets a file input. */
  #role: 'host' | 'guest' | null = null;
  #idleTimer: number | null = null;
  /** Which button opened the identity dialog, and so what confirming means. */
  #pending: { role: 'host' | 'guest'; code: string } | null = null;
  // The lobby is drawn from three sources — the roster, whether we may talk at
  // all, and whether a toggle is in flight — and any of them can change on its
  // own, so the last of each is kept to redraw from.
  #players: Player[] = [];
  #audibleFor: (peerId: PeerId) => boolean = () => true;
  #micAvailable = false;
  #micBusy = false;
  #speakingIds = new Set<string>();
  /** What the lobby counts up to. The host picks it; a guest is told it. */
  #capacity = DEFAULT_CAPACITY;

  constructor(cb: UICallbacks) {
    this.#avatarDefs.innerHTML = avatarDefs();
    this.#buildAvatarGrid();
    this.#buildCapacityGrid();
    this.#restoreIdentity();

    this.#btnHost.addEventListener('click', () => this.#openIdentity('host', ''));
    this.#joinForm.addEventListener('submit', (e) => {
      e.preventDefault();
      // The code is checked before the dialog opens, so a typo is reported
      // where it was typed rather than two screens later.
      const raw = this.#codeInput.value;
      if (!raw.trim()) {
        this.showError('Enter the room code the host gave you.');
        return;
      }
      this.#openIdentity('guest', raw);
    });

    this.#nameInput.addEventListener('input', () => this.#syncIdentityForm());
    this.#btnIdentityCancel.addEventListener('click', () => this.#dialog.close());
    this.#identityForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const identity = this.identity;
      if (!identity.name) {
        this.#identityError.textContent = 'A name is required — the others need to know who you are.';
        this.#nameInput.focus();
        return;
      }
      const pending = this.#pending;
      if (!pending) return;
      remember(STORE_NAME, identity.name);
      remember(STORE_AVATAR, identity.avatar);
      if (pending.role === 'host') {
        remember(STORE_CAPACITY, String(identity.capacity));
        cb.onHost(identity);
      } else {
        cb.onJoin(pending.code, identity);
      }
    });

    // The lobby is rebuilt whole on every roster change, so its buttons cannot
    // be bound individually — they would not survive the next render.
    this.#roster.addEventListener('click', (e) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest('#btn-mic')) {
        cb.onToggleMic();
        return;
      }
      const btn = el?.closest('button[data-peer]');
      if (!(btn instanceof HTMLButtonElement)) return;
      const audible = btn.getAttribute('aria-pressed') === 'true';
      cb.onPeerAudible(btn.dataset['peer'] as PeerId, !audible);
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

    // Three ways into fullscreen, because everyone reaches for a different
    // one. Escape on the way out is the browser's, not ours.
    this.#btnFull.addEventListener('click', () => {
      void this.toggleFullscreen();
      // Without this the button keeps keyboard focus inside the fullscreen
      // element, and the next Space or Enter aimed at the game re-toggles it.
      this.#btnFull.blur();
    });
    this.#stage.addEventListener('dblclick', () => void this.toggleFullscreen());
    window.addEventListener('keydown', (e) => {
      if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
      // The chat box and the name field are letters too — see isTyping.
      if (isTyping(e.target)) return;
      if (e.code === 'KeyF') {
        e.preventDefault();
        void this.toggleFullscreen();
      } else if (e.code === 'KeyM' && !this.#room.hidden) {
        e.preventDefault();
        cb.onToggleMic();
      }
    });
    // Covers Escape and the browser's own fullscreen affordances, which never
    // route through toggleFullscreen().
    document.addEventListener('fullscreenchange', () => this.#syncFullscreen());
    this.#stageWrap.addEventListener('pointermove', () => this.#wakeChrome());
  }

  /** True while the game screen owns the display. */
  get fullscreen(): boolean {
    return document.fullscreenElement === this.#stageWrap;
  }

  /**
   * Entering is refused unless there is actually a picture to enlarge --
   * otherwise F on the landing page blacks out the monitor to show the word
   * "waiting". Leaving is always allowed.
   */
  async toggleFullscreen(): Promise<void> {
    try {
      if (this.fullscreen) {
        await document.exitFullscreen();
      } else if (!this.#screen.hidden) {
        await this.#stageWrap.requestFullscreen({ navigationUI: 'hide' });
      }
    } catch {
      // A browser may refuse (no user activation, kiosk policy, a permissions
      // policy on an embedding frame). Staying windowed is a fine outcome.
    }
  }

  #syncFullscreen(): void {
    const on = this.fullscreen;
    this.#btnFull.textContent = on ? 'exit' : 'fullscreen';
    this.#btnFull.setAttribute('aria-pressed', String(on));
    this.#wakeChrome();
  }

  /**
   * The pointer moved, so show the cursor, the button and the HUD again and
   * restart the countdown to hiding them. A no-op outside fullscreen, where
   * the page furniture is supposed to stay put.
   */
  #wakeChrome(): void {
    if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    delete this.#stageWrap.dataset['idle'];
    if (!this.fullscreen) return;
    this.#idleTimer = window.setTimeout(() => {
      this.#idleTimer = null;
      this.#stageWrap.dataset['idle'] = 'true';
    }, IDLE_MS);
  }

  // -- identity -------------------------------------------------------------

  /** Ten radio inputs, one per avatar. Radios give us arrow-key selection. */
  #buildAvatarGrid(): void {
    this.#avatarGrid.replaceChildren(
      ...AVATAR_IDS.map((id, i) => {
        const label = document.createElement('label');
        label.className = 'avatar-pick';
        label.dataset['avatar'] = id;
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'avatar';
        input.value = id;
        input.checked = i === 0;
        const name = document.createElement('span');
        name.className = 'avatar-name';
        name.textContent = avatarName(id);
        label.append(input, avatarSvg(id, 'avatar-art'), name);
        label.title = avatarName(id);
        return label;
      }),
    );
  }

  /** Same radio-group shape as the avatars, so keyboard behaviour matches. */
  #buildCapacityGrid(): void {
    this.#capacityGrid.replaceChildren(
      ...CAPACITY_CHOICES.map((n) => {
        const label = document.createElement('label');
        label.className = 'capacity-pick';
        label.dataset['capacity'] = String(n);
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'capacity';
        input.value = String(n);
        input.checked = n === DEFAULT_CAPACITY;
        const big = document.createElement('span');
        big.className = 'capacity-n';
        big.textContent = String(n);
        const word = document.createElement('span');
        word.className = 'capacity-word';
        word.textContent = 'players';
        label.append(input, big, word);
        return label;
      }),
    );
  }

  #selectCapacity(n: number): void {
    const input = this.#capacityGrid.querySelector<HTMLInputElement>(`input[value="${n}"]`);
    if (input) input.checked = true;
  }

  /** Called once the room exists, so the lobby counts to the host's number. */
  setCapacity(n: number): void {
    this.#capacity = coerceCapacity(n);
    this.renderRoster(this.#players, this.#audibleFor);
  }

  #restoreIdentity(): void {
    this.#nameInput.value = coerceName(recall(STORE_NAME));
    this.selectAvatar(coerceAvatar(recall(STORE_AVATAR) || DEFAULT_AVATAR));
    this.#selectCapacity(coerceCapacity(Number(recall(STORE_CAPACITY)) || DEFAULT_CAPACITY));
    this.#syncIdentityForm();
  }

  /** What the dialog currently holds, cleaned the same way the wire cleans it. */
  get identity(): Identity {
    const checked = this.#avatarGrid.querySelector<HTMLInputElement>('input:checked');
    const cap = this.#capacityGrid.querySelector<HTMLInputElement>('input:checked');
    return {
      name: coerceName(this.#nameInput.value),
      avatar: coerceAvatar(checked?.value),
      capacity: coerceCapacity(Number(cap?.value)),
    };
  }

  selectAvatar(id: AvatarId): void {
    const input = this.#avatarGrid.querySelector<HTMLInputElement>(`input[value="${id}"]`);
    if (input) input.checked = true;
  }

  #openIdentity(role: 'host' | 'guest', code: string): void {
    this.#pending = { role, code };
    this.showError('');
    this.#identityError.textContent = '';
    this.#identityTitle.textContent = role === 'host' ? 'Who are you?' : "Who's joining?";
    this.#btnIdentityGo.textContent = role === 'host' ? 'Start the room' : 'Join the room';
    // Only the host opens the room, so only the host chooses its size.
    this.#capacityBlock.hidden = role !== 'host';
    this.#syncIdentityForm();
    this.#dialog.showModal();
    this.#nameInput.focus();
    this.#nameInput.select();
  }

  /**
   * A guest arriving on a shared link skips the landing page's join form and
   * goes straight to the dialog. Opening a <dialog> needs no user activation;
   * the JOIN click inside it is the real gesture gotcha #6 wants, so a link
   * still never joins — or touches the microphone — on its own.
   */
  openGuestJoin(code: string): void {
    this.prefillCode(code);
    this.#openIdentity('guest', code);
  }

  #syncIdentityForm(): void {
    const ok = this.identity.name.length > 0;
    this.#btnIdentityGo.disabled = !ok;
    if (ok) this.#identityError.textContent = '';
  }

  /**
   * The permission prompt is a browser dialog with no explanation on it, so the
   * one that caused it stays up and says what is going on until it settles.
   */
  showMicPending(): void {
    this.#identityNote.textContent = 'asking for your microphone…';
    this.#btnIdentityGo.disabled = true;
    this.#btnIdentityCancel.disabled = true;
  }

  closeIdentity(): void {
    this.#identityNote.innerHTML =
      'your browser will ask for the microphone. you join <b>muted</b> — press <kbd>M</kbd> to talk.';
    this.#btnIdentityCancel.disabled = false;
    this.#syncIdentityForm();
    if (this.#dialog.open) this.#dialog.close();
    this.#pending = null;
  }

  /** Where `Voice` parks its per-peer <audio> elements. */
  get voiceSinks(): HTMLElement {
    return this.#voiceSinks;
  }

  /** Whether unmuting is an option at all, or the mic was refused. */
  setMicAvailable(available: boolean): void {
    this.#micAvailable = available;
    this.renderRoster(this.#players, this.#audibleFor);
  }

  /**
   * Unmuting has to go and fetch a microphone, so the control says so rather
   * than sitting there looking unresponsive.
   */
  setMicBusy(busy: boolean): void {
    this.#micBusy = busy;
    this.renderRoster(this.#players, this.#audibleFor);
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
    this.#role = role;
    this.#landing.hidden = true;
    this.#authorView.hidden = true;
    this.#room.hidden = false;
    this.#codeLabel.textContent = role === 'host' ? 'Room code — share it' : 'Room';
    this.#roomCode.textContent = formatRoomCode(roomCode);
    // A host shares a link; a guest has nothing useful to hand on but the code.
    this.#shareText = role === 'host' ? joinLink(roomCode) : formatRoomCode(roomCode);
    this.#btnCopy.title = this.#shareText;
    // Settled here, not when the picker shows: only the host may load a file.
    // A guest is sent the host's copy, so its picker is a waiting line.
    this.#romBar.hidden = role !== 'host';
    this.#romWait.hidden = role === 'host';
  }

  showLanding(): void {
    // Leaving the room must not strand the player in a fullscreen black box.
    if (this.fullscreen) void document.exitFullscreen().catch(() => {});
    this.closeIdentity();
    this.#role = null;
    this.#landing.hidden = false;
    this.#authorView.hidden = true;
    this.#room.hidden = true;
    this.setBusy(false);
  }

  /**
   * The author page swaps in for the landing page and never for a live room —
   * mid-game the URL is the room's, and nothing should be able to hide the
   * game behind a biography.
   */
  showAuthorView(show: boolean): void {
    if (!this.#room.hidden) return;
    this.#authorView.hidden = !show;
    this.#landing.hidden = show;
  }

  setStatus(status: TransportStatus, detail: string): void {
    this.#statusPill.textContent = status;
    this.#statusPill.dataset['status'] = status;
    this.#statusPill.title = detail;
  }

  /**
   * The lobby: who is in the room and what their microphone is doing.
   *
   * `audibleFor` answers "can I hear this player" and is a purely local matter,
   * so it comes from `Voice` rather than from the roster the peers agreed on.
   */
  renderRoster(players: Player[], audibleFor: (peerId: PeerId) => boolean = () => true): void {
    this.#players = players;
    this.#audibleFor = audibleFor;
    this.#lobbyCount.textContent = players.length
      ? `${players.length} of ${this.#capacity} players`
      : 'waiting for players';
    this.#roster.replaceChildren(...players.map((p) => this.#playerCard(p, audibleFor)));
    this.renderSpeaking(this.#speakingIds);
  }

  #playerCard(p: Player, audibleFor: (peerId: PeerId) => boolean): HTMLLIElement {
    const li = document.createElement('li');
    li.dataset['slot'] = String(p.slot);
    li.dataset['self'] = String(p.isSelf);
    li.dataset['talking'] = String(!p.muted);
    li.dataset['peer'] = p.peerId;
    li.dataset['speaking'] = String(this.#speakingIds.has(p.isSelf ? 'self' : p.peerId));

    // The portrait, and — for you — the microphone control sitting on it.
    const portrait = document.createElement('div');
    portrait.className = 'portrait';
    portrait.append(avatarSvg(p.avatar, 'avatar-art portrait-art'));
    portrait.append(p.isSelf ? this.#micOrb(p) : this.#micBadge(p));

    const slot = document.createElement('span');
    slot.className = 'slot';
    slot.textContent = `P${p.slot}`;

    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = p.label;

    const state = document.createElement('span');
    state.className = 'mic-state';
    state.dataset['muted'] = String(p.muted);
    state.textContent = p.isSelf
      ? p.muted
        ? 'you are muted'
        : 'you are live'
      : p.muted
        ? 'muted'
        : 'talking';

    const peerId = document.createElement('span');
    peerId.className = 'peer-id';
    peerId.textContent = p.peerId;

    const card = document.createElement('div');
    card.className = 'card-body';
    card.append(slot, who, state, peerId);

    li.append(portrait, card);

    if (p.isSelf) {
      const you = document.createElement('span');
      you.className = 'you';
      you.textContent = 'you';
      li.append(you);
    } else {
      // Silencing someone is between you and your speakers; nothing is sent.
      const audible = audibleFor(p.peerId);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-quiet speaker';
      btn.dataset['peer'] = p.peerId;
      btn.setAttribute('aria-pressed', String(audible));
      btn.textContent = audible ? 'hear' : 'silenced';
      btn.title = `${audible ? 'Silence' : 'Un-silence'} ${p.label} for you only`;
      li.append(btn);
    }
    return li;
  }

  /**
   * Your own microphone, sitting on your own portrait. An icon rather than a
   * word: it is a control you hit mid-fight, and it keeps the id the M hotkey
   * and the checks both reach for.
   */
  #micOrb(p: Player): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btn-mic';
    btn.className = 'mic-orb';
    btn.disabled = !this.#micAvailable || this.#micBusy;
    btn.setAttribute('aria-pressed', String(!p.muted));
    btn.dataset['busy'] = String(this.#micBusy);
    btn.dataset['state'] = !this.#micAvailable ? 'none' : p.muted ? 'muted' : 'live';
    btn.append(micIcon(this.#micAvailable && !p.muted, !this.#micAvailable));
    btn.title = !this.#micAvailable
      ? 'No microphone — you can hear everyone, they cannot hear you'
      : `${p.muted ? 'Open' : 'Close'} your microphone (M)`;
    btn.setAttribute('aria-label', btn.title);
    return btn;
  }

  #micBadge(p: Player): HTMLElement {
    const badge = document.createElement('span');
    badge.className = 'mic-badge';
    badge.dataset['muted'] = String(p.muted);
    badge.append(micIcon(!p.muted, false));
    badge.title = `${p.label}'s microphone is ${p.muted ? 'closed' : 'open'}`;
    badge.setAttribute('aria-label', badge.title);
    return badge;
  }

  /**
   * Who is talking, over the picture.
   *
   * Lives inside the stage wrapper, which is the element that goes fullscreen,
   * so it stays visible mid-game instead of being left behind on the page.
   */
  renderSpeaking(speaking: Set<string>): void {
    this.#speakingIds = speaking;
    // Patch the lobby cards in place. This runs several times a second, and
    // rebuilding the whole lobby at that rate would throw away the focus and
    // the pressed state of the controls inside it every time somebody spoke.
    for (const li of this.#roster.children) {
      if (!(li instanceof HTMLElement)) continue;
      const key = li.dataset['self'] === 'true' ? 'self' : (li.dataset['peer'] ?? '');
      li.dataset['speaking'] = String(speaking.has(key));
    }
    const talkers = this.#players.filter(
      (p) => speaking.has(p.isSelf ? 'self' : p.peerId),
    );
    this.#speakingBar.hidden = talkers.length === 0;
    this.#speakingBar.replaceChildren(
      ...talkers.map((p) => {
        const chip = document.createElement('span');
        chip.className = 'talker';
        chip.dataset['slot'] = String(p.slot);
        chip.append(avatarSvg(p.avatar, 'avatar-art talker-art'));
        const name = document.createElement('b');
        name.textContent = p.isSelf ? 'you' : p.label;
        chip.append(name);
        return chip;
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
    this.#btnFull.hidden = true;
  }

  /**
   * Progress for a game file coming from, or going to, a peer.
   *
   * Deliberately additive to the picker rather than replacing it: a transfer can
   * fail or the peer can leave, and a player left staring at a stalled bar with
   * no way to load their own file would be worse off than before the feature.
   */
  showRomProgress(fraction: number | null, detail: string): void {
    this.#romProgress.hidden = fraction === null && !detail;
    this.#romProgress.textContent = detail;
    if (fraction === null) this.#romProgress.style.removeProperty('--fraction');
    else this.#romProgress.style.setProperty('--fraction', `${Math.round(fraction * 100)}%`);
  }

  /** Names the loaded game and whose copy it is, under the picture. */
  setRomNote(name: string, origin: 'dev-server' | 'file' | 'peer'): void {
    const from = origin === 'peer' ? 'sent by a player in this room' : 'your file';
    this.#romNote.textContent = `${name} · ${from}`;
    this.#romNote.hidden = false;
  }

  showRomPicker(show: boolean): void {
    // The host loads a file; a guest waits for the host's copy. The hidden
    // state of the two halves is set at showRoom(), so this only words the lead.
    this.#romPickerLead.textContent =
      this.#role === 'guest'
        ? 'Waiting for the game to arrive…'
        : 'Load a game to start the emulator.';
    this.#romPicker.hidden = !show;
    this.#stageMessage.hidden = show;
    if (show) this.#btnFull.hidden = true;
  }

  showScreen(): void {
    this.#screen.hidden = false;
    this.#stageMessage.hidden = true;
    this.#romPicker.hidden = true;
    this.#btnFull.hidden = false;
  }

  setNetStatus(phase: string, detail: string): void {
    this.#netHud.hidden = false;
    this.#netHud.dataset['phase'] = phase;
    this.#netHud.title = detail;
  }

  renderHud(
    stats: MachineStats,
    targetFps: number,
    net: LockstepStats | null,
    link: { rttByPort: Record<number, number | null>; resyncs: number } | null = null,
  ): void {
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
    this.#renderNetHud(stats, net, link);
  }

  #renderNetHud(
    stats: MachineStats,
    net: LockstepStats | null,
    link: { rttByPort: Record<number, number | null>; resyncs: number } | null,
  ): void {
    if (!net || !net.running) {
      if (this.#netHud.dataset['phase'] === undefined) this.#netHud.hidden = true;
      return;
    }
    this.#netHud.hidden = false;
    this.#netHud.dataset['warn'] = String(stats.stalled);
    const phase = document.createElement('b');
    phase.className = 'phase';
    phase.textContent = stats.stalled ? `stalled on P${net.waitingFor.map((p) => p + 1).join(',P')}` : 'lockstep';
    // One column per remote player: how far ahead their input reaches, the
    // round trip to them, and how ragged their packet arrivals are.
    const perPeer = Object.keys(net.leadByPort)
      .map(Number)
      .filter((port) => port !== net.selfPort)
      .map((port) => {
        const rtt = link?.rttByPort[port];
        const jitter = net.jitterByPort[port];
        const bits = [`+${net.leadByPort[port] ?? 0}f`];
        if (rtt != null) bits.push(`${rtt.toFixed(0)}ms rtt`);
        if (jitter != null) bits.push(`\u00b1${jitter.toFixed(1)}ms`);
        return `P${port + 1} ${bits.join(' ')}`;
      });

    const children = [
      phase,
      field('frame', String(net.frame)),
      field('input delay', `${net.delayFrames}f / ${(net.delayFrames * 16.78).toFixed(0)}ms`),
      ...perPeer.map((text) => field('', text)),
      field('stalls', `${net.stalls} (${net.stalledFrames}f)`),
      field('pkts', `${net.packetsOut}\u2191 ${net.packetsIn}\u2193`),
    ];
    if (link) children.push(field('resyncs', String(link.resyncs)));
    // Desyncs must be zero. If they are not, that is the most important number
    // on the page, so it is always shown once it is non-zero.
    if (net.desyncs > 0) {
      const d = document.createElement('b');
      d.className = 'desync';
      d.textContent = `DESYNCS ${net.desyncs}`;
      children.push(d);
    }
    this.#netHud.replaceChildren(...children);
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

/**
 * A microphone, or a microphone with a stroke through it. Inline SVG for the
 * same reason as the avatars: nothing to fetch, and it takes its colour from
 * whatever it sits in.
 */
function micIcon(open: boolean, absent: boolean): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'mic-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const body = document.createElementNS(NS, 'path');
  body.setAttribute('fill', 'currentColor');
  body.setAttribute(
    'd',
    'M12 3a3 3 0 013 3v6a3 3 0 01-6 0V6a3 3 0 013-3zm7 9a7 7 0 01-6 6.93V22h-2v-3.07' +
      'A7 7 0 015 12h2a5 5 0 0010 0z',
  );
  svg.append(body);

  if (!open) {
    const slash = document.createElementNS(NS, 'path');
    slash.setAttribute('stroke', 'currentColor');
    slash.setAttribute('stroke-width', absent ? '2.4' : '2');
    slash.setAttribute('stroke-linecap', 'round');
    slash.setAttribute('d', 'M4 3.5 L20 20.5');
    svg.append(slash);
  }
  return svg;
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
