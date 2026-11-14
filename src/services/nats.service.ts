import { Injectable, signal } from '@angular/core';
import {
  connect,
  StringCodec,
  NatsConnection,
  Subscription,
  JetStreamManager,
  Msg,
  JsMsg,
} from 'nats.ws';
import { JetStreamTail } from './jetstream-tail';

export type SubjectHandler = (subject: string, data: unknown) => void;

interface Registration {
  pattern: string;
  handler: SubjectHandler;
  mode: 'core' | 'js';
}

const URL_KEY = 'ocabox-guider.url';

@Injectable({ providedIn: 'root' })
export class NatsService {
  private nc: NatsConnection | null = null;
  private jsm: JetStreamManager | null = null;
  private codec = StringCodec();
  /**
   * Everything the app asked to follow, keyed by mode + pattern. Outlives
   * connections: every connect attaches it anew, a disconnect only drops
   * what was attached.
   */
  private registry = new Map<string, Registration>();
  private coreSubs: Subscription[] = [];
  private tails: JetStreamTail[] = [];

  isConnected = signal(false);
  isConnecting = signal(false);
  connectionError = signal<string | null>(null);
  serverUrl = signal<string>(this.loadSavedUrl());
  messagesReceived = signal(0);

  constructor() {
    // A page that goes away deletes its consumers on the broker instead of
    // leaving them to the inactive threshold. One restored from the
    // back/forward cache connects again, like a freshly loaded one.
    window.addEventListener('pagehide', () => void this.disconnect());
    window.addEventListener('pageshow', e => {
      if (e.persisted) this.connect(this.serverUrl()).catch(() => { /* error already on signal */ });
    });
  }

  private loadSavedUrl(): string {
    try {
      const v = localStorage.getItem(URL_KEY);
      if (v) return v;
    } catch { /* localStorage unavailable */ }
    // OCM observatory NATS-over-WebSocket endpoint. IP, not hostname —
    // some observatory subnets don't resolve local DNS and a default that
    // won't connect is the worst-case for a mobile dashboard. The dialog
    // lets the operator override.
    return 'ws://192.168.7.38:9222';
  }

  private saveUrl(url: string) {
    try { localStorage.setItem(URL_KEY, url); } catch { /* ignore */ }
  }

  async connect(url: string): Promise<void> {
    let target = url.trim();
    if (!target.match(/^[a-z]+:\/\//i)) {
      const isHttps = window.location.protocol === 'https:';
      target = (isHttps ? 'wss://' : 'ws://') + target;
    }

    this.connectionError.set(null);
    this.isConnecting.set(true);

    try {
      if (this.nc) await this.disconnect();

      this.nc = await connect({
        servers: [target],
        // After a SUCCESSFUL first connect, reconnect indefinitely.
        maxReconnectAttempts: -1,
        reconnectTimeWait: 2000,
        // Critical: do NOT wait forever on the first connect. With
        // `waitOnFirstConnect: true` + unlimited reconnects, a bad URL
        // pins the UI in "connecting…" forever — `connect()` never
        // resolves. Set false so the initial attempt fails fast (5 s),
        // surfacing an error in the dialog; the operator can fix the URL
        // and hit Reconnect.
        waitOnFirstConnect: false,
        timeout: 5000,
        name: 'ocabox-guider-ui',
      });
      // No API check here: a broker without JetStream fails the tails, not the connection.
      this.jsm = await this.nc.jetstreamManager({ checkAPI: false });

      this.isConnected.set(true);
      this.serverUrl.set(target);
      this.saveUrl(target);
      console.info('[nats] connected', target);

      // Attach everything registered so far to the new connection
      for (const reg of this.registry.values()) this.attach(reg);

      // Watch status events
      (async () => {
        if (!this.nc) return;
        for await (const status of this.nc.status()) {
          if (status.type === 'disconnect' || status.type === 'error') {
            console.warn('[nats] status', status.type, status.data);
            this.connectionError.set(`${status.type}: ${String(status.data ?? '')}`);
          } else if (status.type === 'reconnect') {
            console.info('[nats] reconnected');
            this.connectionError.set(null);
          }
        }
      })().catch(() => { /* status iter ends on close */ });
    } catch (err: unknown) {
      const e = err as { message?: string };
      let msg = e?.message ?? 'Connection failed';
      if (window.location.protocol === 'https:' && target.toLowerCase().startsWith('ws:')) {
        msg += ' (mixed-content: ws:// is blocked on https — use wss:// or allow insecure content)';
      }
      console.error('[nats] connect failed', msg);
      this.connectionError.set(msg);
      this.isConnected.set(false);
      throw err;
    } finally {
      this.isConnecting.set(false);
    }
  }

  async disconnect(): Promise<void> {
    const tails = this.tails;
    this.tails = [];
    for (const s of this.coreSubs) { try { s.unsubscribe(); } catch { /* ignore */ } }
    this.coreSubs = [];
    // The tails delete their consumers on the broker; only then may the connection go.
    await Promise.all(tails.map(t => t.stop()));
    if (this.nc) {
      try { await this.nc.close(); } catch { /* ignore */ }
      this.nc = null;
    }
    this.jsm = null;
    this.isConnected.set(false);
  }

  /**
   * JetStream subscription delivering last-per-subject first (current state),
   * then tailing live updates. Use for guider state, info beacon, journal,
   * thumbnail.ready notifications.
   */
  subscribeJS(pattern: string, handler: SubjectHandler): void {
    this.register({ pattern, handler, mode: 'js' });
  }

  /** Core NATS subscription (no replay). Reserved for future use. */
  subscribeCore(pattern: string, handler: SubjectHandler): void {
    this.register({ pattern, handler, mode: 'core' });
  }

  /**
   * Send an RPC request and wait for the response.
   *
   * The guider service uses the serverish envelope format — caller passes
   * the unwrapped data; we wrap it as `{data, meta}` before sending and
   * unwrap the response symmetrically. RPC subjects are core NATS, not
   * JetStream.
   */
  async rpcRequest(
    subject: string,
    data: unknown,
    timeoutMs = 5000,
  ): Promise<unknown> {
    if (!this.nc || !this.isConnected()) {
      throw new Error('not connected');
    }
    const envelope = {
      data: data ?? {},
      meta: { message_type: 'rpc' },
    };
    const payload = this.codec.encode(JSON.stringify(envelope));
    try {
      const reply = await this.nc.request(subject, payload, { timeout: timeoutMs });
      const text = this.codec.decode(reply.data);
      let unwrapped: unknown;
      try {
        const parsed = JSON.parse(text);
        unwrapped = (
          parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
          'data' in (parsed as object)
        )
          ? (parsed as { data: unknown }).data
          : parsed;
      } catch {
        unwrapped = text;
      }
      return unwrapped;
    } catch (e) {
      console.warn('[nats] rpc failed', subject, e);
      throw e;
    }
  }

  private register(reg: Registration): void {
    const key = `${reg.mode}:${reg.pattern}`;
    if (this.registry.has(key)) return;
    this.registry.set(key, reg);
    if (this.isConnected()) this.attach(reg);
  }

  private attach({ pattern, handler, mode }: Registration): void {
    if (!this.nc || !this.jsm) return;
    if (mode === 'js') {
      this.tails.push(new JetStreamTail(this.jsm, pattern, m => this.dispatch(m, handler)));
      return;
    }
    const sub = this.nc.subscribe(pattern);
    this.coreSubs.push(sub);
    (async () => {
      for await (const m of sub) this.dispatch(m, handler);
    })().catch(err => console.warn('[nats] core subscription closed', pattern, err));
  }

  private dispatch(m: Msg | JsMsg, handler: SubjectHandler) {
    let payload: unknown = null;
    if (m.data && m.data.length > 0) {
      try {
        const text = this.codec.decode(m.data);
        try { payload = JSON.parse(text); } catch { payload = text; }
      } catch { /* ignore */ }
    }
    // Unwrap serverish envelope: every published message is shaped
    // `{ data: <payload>, meta: <metadata> }` — Python readers receive
    // `data` already unwrapped, do the same here.
    if (
      payload !== null &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      'data' in payload &&
      'meta' in payload
    ) {
      payload = (payload as { data: unknown }).data;
    }
    try {
      handler(m.subject, payload);
      this.messagesReceived.update(v => v + 1);
    } catch (e) {
      console.warn('[nats] handler threw on', m.subject, e);
    }
  }
}
