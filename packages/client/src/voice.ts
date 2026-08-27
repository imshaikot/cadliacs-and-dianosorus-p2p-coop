import type { PeerId, Transport } from '@dino/shared';

import type { Log } from './log.js';

/**
 * Peer-to-peer voice: the microphone going out, everyone else's coming in.
 *
 * Rides its own MediaConnection per pair, alongside the control and input data
 * channels but entirely independent of them. Nothing in the lockstep path waits
 * on anything in here, which is the point: a denied microphone or a media
 * connection that never forms costs conversation, never a frame.
 *
 * **A muted player holds no microphone.** Not a disabled track — no track at
 * all. `getUserMedia` is called on unmute and every track is stopped on mute, so
 * the browser's recording indicator is off for exactly as long as you are muted,
 * and the tab is not listening to the room in between. That is the whole reason
 * this is shaped the way it is:
 *
 *  - Permission is asked for once, when joining, and the track that answer
 *    arrives on is stopped immediately. On later visits the permission is
 *    already granted, so `navigator.permissions` answers it and nothing opens
 *    at all.
 *  - Toggling is `RTCRtpSender.replaceTrack` inside the transport, which needs
 *    no renegotiation — the call survives a mute, so unmuting is instant rather
 *    than a fresh WebRTC handshake.
 *  - Calls are established at join with a **silent placeholder track**, not the
 *    microphone. A placeholder costs one idle AudioContext; the alternative —
 *    setting up calls only once somebody talks — negotiates a `recvonly` m-line
 *    for everyone who was muted at the time, which can never carry audio
 *    afterwards and has to be torn down and rebuilt mid-conversation. That path
 *    was built, and it raced badly enough under real timing to be worth this.
 *
 * The same AudioContext then measures who is actually talking, which is what
 * puts a name on screen mid-fight.
 */

/**
 * How long to wait for the permission prompt. A prompt the player *dismisses*
 * rather than answers never settles at all, so without this the join would hang
 * on a dialog nobody is looking at.
 */
const MIC_TIMEOUT_MS = 20_000;

export type MicState = 'granted' | 'denied' | 'timeout' | 'unsupported';

export interface VoicePeer {
  peerId: PeerId;
  hasStream: boolean;
  /** False when the local listener has silenced this player for themselves. */
  audible: boolean;
  speaking: boolean;
}

/** How often to look at who is talking. Fast enough to feel immediate. */
const LEVEL_POLL_MS = 100;
/**
 * Loudness above which someone counts as speaking, as RMS of the analyser's
 * time-domain samples. Low enough to catch a quiet voice, high enough that the
 * noise floor of an open microphone does not latch it on.
 */
const SPEAKING_RMS = 0.02;
/**
 * How long a voice stays "speaking" after dropping below the threshold. Without
 * it the indicator strobes on every syllable gap.
 */
const SPEAKING_HOLD_MS = 350;

const CONSTRAINTS: MediaStreamConstraints = {
  // Not optional. Every peer plays its own emulator through its own speakers, so
  // three open microphones without echo cancellation is a feedback loop with the
  // game audio in the middle of it.
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: false,
};

export class Voice {
  readonly micState: MicState;
  readonly micError: string | null;

  /** Non-null only while unmuted. This is the invariant the design turns on. */
  #stream: MediaStream | null = null;
  #muted = true;
  #log: Log;
  #transport: Transport | null = null;
  #unsubscribes: Array<() => void> = [];
  /** A WebRTC stream only actually flows once a media element pulls on it. */
  #sinks = new Map<PeerId, HTMLAudioElement>();
  #host: HTMLElement | null = null;

  /**
   * Owns the silent placeholder track and the analysers. Deliberately separate
   * from the emulator's AudioContext, which drives the frame clock and is not
   * something to hang extra graph on. Nothing is connected to `destination`, so
   * this context makes no sound.
   */
  #ctx: AudioContext | null = null;
  #silent: MediaStream | null = null;
  #meters = new Map<
    PeerId | 'self',
    { analyser: AnalyserNode; buf: Float32Array<ArrayBuffer>; until: number }
  >();
  #speaking = new Set<string>();
  /** Peers the room says are muted. No point analysing known silence. */
  #knownMuted = new Set<PeerId>();
  #levelTimer: number | null = null;
  /** Fires when the set of people currently talking changes. */
  onSpeakingChange: ((speaking: Set<string>) => void) | null = null;

  private constructor(state: MicState, error: string | null, log: Log) {
    this.micState = state;
    this.micError = error;
    this.#log = log;
  }

  /**
   * Settle whether we are allowed to use the microphone, without ending up
   * holding one. Never rejects: a player who says no still joins, hears
   * everyone, and simply cannot be heard.
   */
  static async requestPermission(log: Log, timeoutMs = MIC_TIMEOUT_MS): Promise<Voice> {
    if (!navigator.mediaDevices?.getUserMedia) {
      log.warn('this browser exposes no microphone API, joining as a listener');
      return new Voice('unsupported', 'getUserMedia is unavailable', log);
    }

    // Already answered on a previous visit: reading it costs nothing and, unlike
    // getUserMedia, does not light the recording indicator to find out.
    const known = await Voice.#knownPermission();
    if (known === 'granted') {
      log.info('microphone already permitted, and stays closed until you unmute');
      return new Voice('granted', null, log);
    }
    if (known === 'denied') {
      log.warn('microphone is blocked for this site, joining as a listener');
      return new Voice('denied', 'permission previously denied', log);
    }

    let timer: number | undefined;
    try {
      const stream = await Promise.race([
        navigator.mediaDevices.getUserMedia(CONSTRAINTS),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
      // Asking is the only way to be told, but we do not want what the answer
      // arrived on. Close it again straight away; unmuting opens a fresh one.
      for (const track of stream.getTracks()) track.stop();
      log.info('microphone permitted, and closed again until you unmute');
      return new Voice('granted', null, log);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const state: MicState = message === 'timeout' ? 'timeout' : 'denied';
      log.warn('no microphone, joining as a listener', { state, message });
      return new Voice(state, message, log);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Permissions API is Chrome-and-friends; elsewhere we simply have to ask. */
  static async #knownPermission(): Promise<PermissionState | null> {
    try {
      const status = await navigator.permissions?.query({
        name: 'microphone' as PermissionName,
      });
      return status?.state ?? null;
    } catch {
      return null;
    }
  }

  get muted(): boolean {
    return this.#muted;
  }

  /** Whether unmuting is even an option. */
  get canTalk(): boolean {
    return this.micState === 'granted';
  }

  /**
   * How many microphone tracks this tab is holding open. Zero whenever muted,
   * which is the thing the recording indicator is really reporting.
   */
  get liveTracks(): number {
    return (this.#stream?.getAudioTracks() ?? []).filter((t) => t.readyState === 'live').length;
  }

  get peers(): VoicePeer[] {
    return [...this.#sinks.entries()].map(([peerId, el]) => ({
      peerId,
      hasStream: el.srcObject !== null,
      audible: !el.muted,
      speaking: this.#speaking.has(peerId),
    }));
  }

  /** Who is talking right now — peer ids, plus 'self' for this player. */
  get speaking(): Set<string> {
    return new Set(this.#speaking);
  }

  isSpeaking(who: string): boolean {
    return this.#speaking.has(who);
  }

  /**
   * Tell us what the room says about a peer's microphone.
   *
   * Only an optimisation, but a real one: three emulators, six peer connections
   * and a fistful of analysers on one machine is enough to push a peer past the
   * silence timeout, and the overwhelmingly common case is a room where nobody
   * is talking. A peer we know is muted is sending silence by construction, so
   * there is nothing to measure.
   */
  setPeerMuted(peerId: PeerId, muted: boolean): void {
    if (muted) this.#knownMuted.add(peerId);
    else this.#knownMuted.delete(peerId);
    if (muted && this.#speaking.delete(peerId)) this.onSpeakingChange?.(this.speaking);
  }

  /**
   * Establish voice with every peer and start listening.
   *
   * The stream handed over is silence, not a microphone. That is what makes
   * every call `sendrecv` from the start, so unmuting later is a `replaceTrack`
   * on a sender that already exists rather than a renegotiation PeerJS cannot
   * perform. See the note at the top of the file.
   */
  attach(transport: Transport, host: HTMLElement): void {
    this.#transport = transport;
    this.#host = host;
    transport.attachStream(this.#silence());
    this.#unsubscribes.push(
      transport.onStream((from, stream) => this.#play(from, stream)),
      transport.onPeerLeave((peerId) => this.#drop(peerId)),
    );
    this.#startMetering();
  }

  #audio(): AudioContext {
    this.#ctx ??= new AudioContext();
    return this.#ctx;
  }

  /**
   * A track that is genuinely silent, and genuinely not a microphone — it comes
   * off an AudioContext with nothing connected to it, so no recording indicator
   * lights and nobody is listening to the room.
   */
  #silence(): MediaStream {
    if (!this.#silent) {
      const destination = this.#audio().createMediaStreamDestination();
      this.#silent = destination.stream;
    }
    return this.#silent;
  }

  /**
   * Open or close the microphone. Resolves once it has actually happened —
   * unmuting has to go and get a track first, so the caller has something real
   * to report rather than an optimistic label.
   */
  async setMuted(muted: boolean): Promise<void> {
    if (this.#muted === muted) return;

    if (muted) {
      this.#muted = true;
      this.#transport?.setOutboundTrack(null);
      this.#meters.delete('self');
      this.#stopMic();
      this.#log.info('microphone closed');
      return;
    }

    if (!this.canTalk) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
    } catch (err) {
      // Permission can be revoked between joining and talking, and a device can
      // be unplugged. Stay muted rather than claim to be live.
      this.#log.error('the microphone would not open', {
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // Only now. `muted === false` has to mean a microphone is genuinely open,
    // or everything downstream — the lobby, the other players, the checks —
    // gets to observe a window where we claim to be live with nothing to send.
    this.#stream = stream;
    this.#muted = false;
    this.#transport?.setOutboundTrack(stream.getAudioTracks()[0] ?? null);
    this.#meter('self', stream);
    this.#log.info('microphone open', { tracks: stream.getAudioTracks().length });
  }

  /** Silence one player locally. Does not tell them, and does not stop them. */
  setPeerAudible(peerId: PeerId, audible: boolean): void {
    const el = this.#sinks.get(peerId);
    if (el) el.muted = !audible;
  }

  isPeerAudible(peerId: PeerId): boolean {
    const el = this.#sinks.get(peerId);
    return el ? !el.muted : true;
  }

  #stopMic(): void {
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = null;
    if (this.#speaking.delete('self')) this.onSpeakingChange?.(this.speaking);
  }

  // -- who is talking -------------------------------------------------------

  /**
   * Watch one stream's loudness.
   *
   * The analyser is fed from a MediaStreamSource and connected to nothing, so it
   * measures without making a sound — the actual playback is the <audio>
   * element, which is also the only thing that makes a WebRTC stream flow at
   * all in Chrome.
   */
  #meter(who: PeerId | 'self', stream: MediaStream): void {
    if (stream.getAudioTracks().length === 0) return;
    const ctx = this.#audio();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.1;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
    this.#meters.set(who, { analyser, buf, until: 0 });
    // A context created without a user gesture starts suspended, and a suspended
    // one measures nothing. The join click covers this; a refusal is survivable.
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  }

  #startMetering(): void {
    if (this.#levelTimer !== null) return;
    this.#levelTimer = window.setInterval(() => this.#sampleLevels(), LEVEL_POLL_MS);
  }

  #sampleLevels(): void {
    const now = performance.now();
    let changed = false;
    for (const [who, meter] of this.#meters) {
      // Skip anything that cannot be making a sound. In a quiet room this is
      // every meter, and the tick costs nothing at all.
      if (who === 'self' ? this.#muted : this.#knownMuted.has(who)) continue;
      meter.analyser.getFloatTimeDomainData(meter.buf);
      let sum = 0;
      for (const v of meter.buf) sum += v * v;
      const rms = Math.sqrt(sum / meter.buf.length);
      if (rms >= SPEAKING_RMS) meter.until = now + SPEAKING_HOLD_MS;
      // A player who has silenced someone locally should not see them lit up.
      const audible = who === 'self' || this.isPeerAudible(who);
      const talking = audible && now < meter.until;
      if (talking === this.#speaking.has(who)) continue;
      if (talking) this.#speaking.add(who);
      else this.#speaking.delete(who);
      changed = true;
    }
    if (changed) this.onSpeakingChange?.(this.speaking);
  }

  #play(from: PeerId, stream: MediaStream): void {
    let el = this.#sinks.get(from);
    if (!el) {
      el = document.createElement('audio');
      el.autoplay = true;
      // Safari on iOS refuses to play a stream in an element it thinks wants
      // the fullscreen player. Set as an attribute: the DOM property is typed
      // onto HTMLVideoElement only, though the attribute is honoured on both.
      el.setAttribute('playsinline', '');
      el.dataset['peer'] = from;
      this.#sinks.set(from, el);
      this.#host?.append(el);
    }
    el.srcObject = stream;
    // Sticky activation from the click that opened the room covers this, but a
    // rejected play() must not take the room down with it.
    void el.play().catch((err: unknown) => {
      this.#log.warn('a peer’s audio would not start', {
        peerId: from,
        message: err instanceof Error ? err.message : String(err),
      });
    });
    this.#meter(from, stream);
    this.#log.net('voice connected', { peerId: from, tracks: stream.getAudioTracks().length });
  }

  #drop(peerId: PeerId): void {
    const el = this.#sinks.get(peerId);
    if (!el) return;
    el.srcObject = null;
    el.remove();
    this.#sinks.delete(peerId);
    this.#meters.delete(peerId);
    if (this.#speaking.delete(peerId)) this.onSpeakingChange?.(this.speaking);
  }

  dispose(): void {
    for (const un of this.#unsubscribes) un();
    this.#unsubscribes = [];
    if (this.#levelTimer !== null) clearInterval(this.#levelTimer);
    this.#levelTimer = null;
    for (const peerId of [...this.#sinks.keys()]) this.#drop(peerId);
    this.#stopMic();
    this.#meters.clear();
    this.#speaking.clear();
    this.#knownMuted.clear();
    this.#muted = true;
    for (const track of this.#silent?.getTracks() ?? []) track.stop();
    this.#silent = null;
    void this.#ctx?.close().catch(() => {});
    this.#ctx = null;
    this.#transport = null;
    this.#host = null;
  }
}
