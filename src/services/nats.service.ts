import { Injectable, signal } from '@angular/core';
import {
  connect,
  consumerOpts,
  createInbox,
  StringCodec,
  NatsConnection,
  Subscription,
  JetStreamClient,
  JetStreamSubscription,
  Msg,
  JsMsg,
} from 'nats.ws';

export type SubjectHandler = (subject: string, data: unknown) => void;

interface PendingSub {
  pattern: string;
  handler: SubjectHandler;
  mode: 'core' | 'js';
}

const URL_KEY = 'ocabox-guider.url';

@Injectable({ providedIn: 'root' })
export class NatsService {
  private nc: NatsConnection | null = null;
  private js: JetStreamClient | null = null;
  private codec = StringCodec();
  private coreSubs: Subscription[] = [];
  private jsSubs: JetStreamSubscription[] = [];
  private pending: PendingSub[] = [];
  private subscribed = new Set<string>();

  isConnected = signal(false);
  isConnecting = signal(false);
  connectionError = signal<string | null>(null);
  serverUrl = signal<string>(this.loadSavedUrl());
  messagesReceived = signal(0);

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

    if (this.nc) await this.disconnect();
    this.connectionError.set(null);
    this.isConnecting.set(true);

    try {
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
      this.js = this.nc.jetstream();

      this.isConnected.set(true);
      this.serverUrl.set(target);
      this.saveUrl(target);
      console.info('[nats] connected', target);

      // Re-attach pending subscriptions
      const queued = this.pending.slice();
      this.pending = [];
      this.subscribed.clear();
      for (const p of queued) {
        if (p.mode === 'js') this.attachJS(p.pattern, p.handler);
        else this.attachCore(p.pattern, p.handler);
      }

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
    for (const s of this.jsSubs) { try { s.unsubscribe(); } catch { /* ignore */ } }
    for (const s of this.coreSubs) { try { s.unsubscribe(); } catch { /* ignore */ } }
    this.jsSubs = [];
    this.coreSubs = [];
    this.subscribed.clear();
    if (this.nc) {
      try { await this.nc.close(); } catch { /* ignore */ }
      this.nc = null;
    }
    this.js = null;
    this.isConnected.set(false);
  }

  /**
   * JetStream subscription delivering last-per-subject first (current state),
   * then tailing live updates. Use for guider state, info beacon, journal,
   * thumbnail.ready notifications.
   */
  subscribeJS(pattern: string, handler: SubjectHandler): void {
    const key = `js:${pattern}`;
    if (this.subscribed.has(key)) return;
    if (this.js && this.isConnected()) this.attachJS(pattern, handler);
    else this.pending.push({ pattern, handler, mode: 'js' });
  }

  /** Core NATS subscription (no replay). Reserved for future use. */
  subscribeCore(pattern: string, handler: SubjectHandler): void {
    const key = `core:${pattern}`;
    if (this.subscribed.has(key)) return;
    if (this.nc && this.isConnected()) this.attachCore(pattern, handler);
    else this.pending.push({ pattern, handler, mode: 'core' });
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

  private attachJS(pattern: string, handler: SubjectHandler): void {
    if (!this.js) return;
    const key = `js:${pattern}`;
    this.subscribed.add(key);

    const opts = consumerOpts();
    opts.deliverLastPerSubject();
    opts.ackNone();
    opts.replayInstantly();
    opts.deliverTo(createInbox());
    opts.inactiveEphemeralThreshold(60_000_000_000);

    (async () => {
      try {
        const sub = await this.js!.subscribe(pattern, opts);
        this.jsSubs.push(sub);
        for await (const m of sub) this.dispatch(m, handler);
      } catch (err) {
        console.warn('[nats] JS subscribe failed', pattern, err);
      }
    })();
  }

  private attachCore(pattern: string, handler: SubjectHandler): void {
    if (!this.nc) return;
    const key = `core:${pattern}`;
    this.subscribed.add(key);
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
