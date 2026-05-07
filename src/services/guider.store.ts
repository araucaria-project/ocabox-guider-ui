import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { NatsService } from './nats.service';

/**
 * Discovery payload sourced from the standard TCS service status stream
 * (`<prefix>.status.<service>`), under `details.metrics.guider`. This is
 * the same stream `tcsctl` reads, so guider discovery shares the lifecycle
 * + health surface of every other TCS service.
 */
export interface GuiderInfo {
  /** TCS service id (matches the subject path: `svc.status.<service_id>`). */
  service_id: string;
  /** Process status reported by the TCS framework. */
  service_status: string;
  /** Hostname / pid published by the runner. */
  hostname?: string;
  pid?: number;

  /** Guider-specific discovery metadata from details.metrics.guider. */
  service: string;
  instance: string;
  telescope_id: string;
  variant: string | null;
  subject_prefix: string;
  started_at: number[] | null;
  subjects: {
    thumbnail_ready: string;
    active_correction: string;
  };
  pipelines: PipelineInfo[];
}

export interface PipelineInfo {
  id: string;
  camera_id: string;
  mode: string;
  method: string;
  selection_policy: string;
  subjects: {
    rpc_root: string;
    state: string;
    events: string;
    journal: string;
    correction: string;
  };
  rpcs: string[];
}

export interface PipelineState {
  pipeline_id: string;
  camera_id: string;
  mode: string;
  method: string;
  selection_policy: string;
  exp_time: number;
  current_exp_time: number | null;
  binning: number;
  gain: number | null;
  central_point: [number, number];
  wide_search_radius_px: number;
  search_reg_px: number;
  acquired: boolean;
  acquired_pos: [number, number] | null;
  acquired_adu: number | null;
  fwhm_recent: number | null;
  last_correction_dx_px: number | null;
  last_correction_dy_px: number | null;
  version: number;
  [k: string]: unknown;
}

export interface ThumbnailNotification {
  path: string;
  sequence: number;
  frame_seq: number;
  ts: number[];
  frame_ts: number[];
  exp_time_total: number;
  n_stacked: number;
  dimensions: [number, number];
  instance: string;
  pipeline_id: string;
}

export interface JournalEntry {
  message: string;
  level: number;
  timestamp: number[];
}

/** Single point on the drift chart — derived from each PipelineState update. */
export interface DriftPoint {
  /** Wall-clock timestamp (epoch ms). */
  t: number;
  /** Pixel error on the X axis: acquired_pos.x − central_point.x. */
  dx: number;
  /** Pixel error on the Y axis: acquired_pos.y − central_point.y. */
  dy: number;
}

const THUMB_BASE_KEY = 'ocabox-guider.thumb-base';
const THUMB_PREFIX_KEY = 'ocabox-guider.thumb-prefix';

/** Rolling drift-chart window length, in seconds. */
const DRIFT_WINDOW_S = 300;
/** Maximum buffered drift points (covers ~5 minutes at 1 Hz with headroom). */
const DRIFT_CAP = 600;

/**
 * Per-guider live state store. One instance for the whole app; UI components
 * read from its signals.
 *
 * Discovery runs in two layers:
 *  1. Subscribe `<prefix>.status.guiding_svc.guider.>` last-per-subject — the
 *     standard TCS service-status stream. Each message carries the framework's
 *     own status/pid/hostname plus, under `details.metrics.guider`, the
 *     guider-specific subject scheme + RPC vocabulary needed by the UI.
 *     This is the same stream `tcsctl` reads, so the UI shares discovery and
 *     health surface with every other TCS service.
 *  2. As each new GuiderInfo arrives, attach subscriptions to its state,
 *     events, journal, and thumbnail-ready subjects.
 */
@Injectable({ providedIn: 'root' })
export class GuiderStore {
  private nats = inject(NatsService);

  /** Map of instance → discovery info. */
  guiders = signal<Map<string, GuiderInfo>>(new Map());

  /** Map of instance → latest PipelineState (one per pipeline; key is `${instance}::${pipe_id}`). */
  states = signal<Map<string, PipelineState>>(new Map());

  /** Map of instance → latest thumbnail notification. */
  thumbnails = signal<Map<string, ThumbnailNotification>>(new Map());

  /** Recent journal entries (per instance, capped). */
  journals = signal<Map<string, JournalEntry[]>>(new Map());

  /** Recent events (per instance, capped). */
  events = signal<Map<string, Array<{ event: string; payload: unknown; ts: number[] }>>>(new Map());

  /**
   * Per-pipeline rolling drift history. Each PipelineState update with
   * ``acquired === true`` contributes one point ``(t, dx, dy)`` where
   * ``dx = acquired_pos.x − central_point.x`` and similarly for dy. Capped
   * at ~5 minutes so the chart stays bounded without explicit pruning logic
   * inside components.
   *
   * Keyed by ``${instance}::${pipe_id}`` like ``states``.
   */
  drift = signal<Map<string, DriftPoint[]>>(new Map());

  /**
   * Per-pipeline RMS over the rolling drift window. Recomputed on every
   * state push so the dashboard updates without a separate timer.
   */
  rms = signal<Map<string, { ra: number; dec: number; total: number; n: number }>>(new Map());


  /** Static HTTP server base URL for thumbnails (configured by operator). */
  thumbnailHttpBase = signal<string>(this.loadThumbBase());

  /** Filesystem prefix to strip when mapping path → URL. */
  thumbnailPathPrefix = signal<string>(this.loadThumbPrefix());

  /** Computed list of guiders, sorted by instance for stable rendering. */
  guidersList = computed(() =>
    Array.from(this.guiders().values()).sort((a, b) => a.instance.localeCompare(b.instance))
  );

  private subscribed = new Set<string>();

  constructor() {
    // Auto-start discovery once NATS is connected.
    effect(() => {
      if (this.nats.isConnected()) {
        this.startDiscovery();
      }
    });
  }

  setThumbnailHttpBase(url: string): void {
    this.thumbnailHttpBase.set(url);
    try { localStorage.setItem(THUMB_BASE_KEY, url); } catch { /* ignore */ }
  }

  /**
   * Trigger a CSV download of the active drift history for the given pipeline.
   * Useful for post-session analysis (RMS over arbitrary windows, FFT for
   * periodic-error detection, plate-scale conversions).
   */
  exportDriftCsv(instance: string, pipelineId: string): void {
    const points = this.drift().get(`${instance}::${pipelineId}`) ?? [];
    const lines = ['# t_iso,t_epoch_ms,dx_px,dy_px'];
    for (const p of points) {
      lines.push(`${new Date(p.t).toISOString()},${p.t},${p.dx.toFixed(3)},${p.dy.toFixed(3)}`);
    }
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `drift-${instance}-${pipelineId}-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  clearDrift(instance: string, pipelineId: string): void {
    const key = `${instance}::${pipelineId}`;
    this.drift.update(prev => {
      const next = new Map(prev);
      next.set(key, []);
      return next;
    });
    this.rms.update(prev => {
      const next = new Map(prev);
      next.set(key, { ra: 0, dec: 0, total: 0, n: 0 });
      return next;
    });
  }

  setThumbnailPathPrefix(prefix: string): void {
    this.thumbnailPathPrefix.set(prefix);
    try { localStorage.setItem(THUMB_PREFIX_KEY, prefix); } catch { /* ignore */ }
  }

  /** Resolve a filesystem path from the notification to a fetchable URL. */
  resolveThumbnailUrl(path: string): string {
    const base = this.thumbnailHttpBase().replace(/\/+$/, '');
    const prefix = this.thumbnailPathPrefix().replace(/\/+$/, '');
    let rel = path;
    if (prefix && rel.startsWith(prefix)) {
      rel = rel.slice(prefix.length);
    }
    if (!rel.startsWith('/')) rel = '/' + rel;
    // Cache-bust on every notification — same filename gets reused for
    // `latest.jpg` symlink, browser would otherwise show stale.
    return `${base}${rel}?t=${Date.now()}`;
  }

  /** RPC helpers — convenience over NatsService.rpcRequest. */
  async setMode(instance: string, pipelineId: string, mode: string): Promise<unknown> {
    return this.callRpc(instance, pipelineId, 'set_mode', { mode });
  }
  async setState(instance: string, pipelineId: string, patch: Record<string, unknown>): Promise<unknown> {
    return this.callRpc(instance, pipelineId, 'set_state', { patch });
  }
  async acquire(instance: string, pipelineId: string): Promise<unknown> {
    return this.callRpc(instance, pipelineId, 'acquire', {});
  }
  async acquireAt(instance: string, pipelineId: string, x: number, y: number): Promise<unknown> {
    return this.callRpc(instance, pipelineId, 'acquire_at', { x, y });
  }
  async manualPulse(
    instance: string, pipelineId: string,
    direction: number | string, durationMs: number,
  ): Promise<unknown> {
    return this.callRpc(instance, pipelineId, 'manual_pulse', {
      direction, duration_ms: durationMs,
    });
  }
  async snapshot(instance: string, pipelineId: string): Promise<unknown> {
    return this.callRpc(instance, pipelineId, 'snapshot', {});
  }

  private async callRpc(
    instance: string, pipelineId: string, cmd: string, data: unknown,
  ): Promise<unknown> {
    const info = this.guiders().get(instance);
    if (!info) throw new Error(`unknown guider instance: ${instance}`);
    const pipe = info.pipelines.find(p => p.id === pipelineId);
    if (!pipe) throw new Error(`unknown pipeline: ${instance}.${pipelineId}`);
    const subject = `${pipe.subjects.rpc_root}.${cmd}`;
    return this.nats.rpcRequest(subject, data);
  }

  private loadThumbBase(): string {
    try {
      const v = localStorage.getItem(THUMB_BASE_KEY);
      if (v) return v;
    } catch { /* ignore */ }
    // Default to same-host static server (operator-run nginx/caddy/python).
    // The OCM observatory NATS WS host (192.168.7.38) often hosts the share
    // too — a runtime override in the Connection panel handles that case.
    return `${window.location.protocol}//${window.location.hostname}:8080`;
  }

  private loadThumbPrefix(): string {
    try {
      const v = localStorage.getItem(THUMB_PREFIX_KEY);
      if (v) return v;
    } catch { /* ignore */ }
    // Default matches the dev YAML config (output_dir: /tmp/guider_thumbs).
    return '/tmp/guider_thumbs';
  }

  private startDiscovery(): void {
    // 1) Discovery: standard TCS service-status stream, filtered to guider
    // services. Same stream `tcsctl` reads — last-per-subject delivers the
    // current snapshot to late-joiners.
    this.nats.subscribeJS(
      'svc.status.guiding_svc.guider.>',
      (subject, data) => this.handleStatus(subject, data as Record<string, unknown>),
    );

    // The handler chains per-instance subscriptions for state/events/journal/
    // thumbnail when discovery metadata first arrives — see handleStatus.
  }

  /**
   * Parse a standard TCS svc.status message and extract guider-specific
   * discovery metadata from ``details.metrics.guider``. Stopped or failed
   * services are kept in the list with their reported status so the UI can
   * still surface them; only services missing the metric are skipped.
   */
  private handleStatus(subject: string, msg: Record<string, unknown>): void {
    if (!msg || typeof msg !== 'object') return;
    const details = (msg['details'] as Record<string, unknown> | undefined) ?? {};
    const metrics = (details['metrics'] as Record<string, unknown> | undefined) ?? {};
    const guider = metrics['guider'] as Partial<GuiderInfo> | undefined;
    if (!guider || typeof guider !== 'object' || !guider.instance) {
      // Either not a guider-instance status, or older message before the
      // metric callback was registered. Ignore.
      return;
    }
    const info: GuiderInfo = {
      service_id: String(msg['name'] ?? subject.replace(/^.*svc\.status\./, '')),
      service_status: String(msg['status'] ?? 'unknown'),
      hostname: msg['hostname'] as string | undefined,
      pid: msg['pid'] as number | undefined,
      service: String(guider.service ?? 'guider'),
      instance: String(guider.instance),
      telescope_id: String(guider.telescope_id ?? 'unknown'),
      variant: (guider.variant as string | null) ?? null,
      subject_prefix: String(guider.subject_prefix ?? 'svc'),
      started_at: (guider.started_at as number[] | null) ?? null,
      subjects: guider.subjects as GuiderInfo['subjects'] ?? {
        thumbnail_ready: '', active_correction: '',
      },
      pipelines: (guider.pipelines as PipelineInfo[]) ?? [],
    };
    this.guiders.update(prev => {
      const next = new Map(prev);
      next.set(info.instance, info);
      return next;
    });
    this.attachInstance(info);
  }

  private attachInstance(info: GuiderInfo): void {
    const seen = `inst:${info.instance}`;
    if (this.subscribed.has(seen)) return;
    this.subscribed.add(seen);

    // Per-pipeline state, events, journal — JetStream streams.
    for (const pipe of info.pipelines) {
      this.nats.subscribeJS(pipe.subjects.state, (_s, data) =>
        this.handleState(info.instance, pipe.id, data as PipelineState));
      this.nats.subscribeJS(pipe.subjects.journal, (_s, data) =>
        this.handleJournal(info.instance, data as JournalEntry));
      this.nats.subscribeJS(pipe.subjects.events, (_s, data) =>
        this.handleEvent(info.instance, data as { event: string; payload: unknown; ts: number[] }));
    }

    // Per-instance thumbnail notifications.
    this.nats.subscribeJS(info.subjects.thumbnail_ready, (_s, data) =>
      this.handleThumbnail(data as ThumbnailNotification));
  }

  private handleState(instance: string, pipelineId: string, state: PipelineState): void {
    if (!state || typeof state !== 'object') return;
    const key = `${instance}::${pipelineId}`;
    this.states.update(prev => {
      const next = new Map(prev);
      next.set(key, state);
      return next;
    });

    // Append a drift sample whenever we have an acquired position to
    // compare against the (possibly newly-set) central_point. We use the
    // wall clock — state updates are bursty (every set_state bumps
    // version), but visually the chart is anchored on time-of-arrival.
    if (state.acquired && state.acquired_pos && state.central_point) {
      const dx = state.acquired_pos[0] - state.central_point[0];
      const dy = state.acquired_pos[1] - state.central_point[1];
      const t = Date.now();
      this.drift.update(prev => {
        const next = new Map(prev);
        const cutoff = t - DRIFT_WINDOW_S * 1000;
        const old = next.get(key) ?? [];
        const fresh = old.filter(p => p.t >= cutoff);
        fresh.push({ t, dx, dy });
        if (fresh.length > DRIFT_CAP) fresh.splice(0, fresh.length - DRIFT_CAP);
        next.set(key, fresh);
        return next;
      });

      const points = this.drift().get(key) ?? [];
      if (points.length > 0) {
        const n = points.length;
        const sxx = points.reduce((a, p) => a + p.dx * p.dx, 0);
        const syy = points.reduce((a, p) => a + p.dy * p.dy, 0);
        const ra = Math.sqrt(sxx / n);
        const dec = Math.sqrt(syy / n);
        const total = Math.sqrt(ra * ra + dec * dec);
        this.rms.update(prev => {
          const next = new Map(prev);
          next.set(key, { ra, dec, total, n });
          return next;
        });
      }
    }
  }

  private handleJournal(instance: string, entry: JournalEntry): void {
    if (!entry || typeof entry !== 'object') return;
    this.journals.update(prev => {
      const next = new Map(prev);
      const list = (next.get(instance) ?? []).concat(entry).slice(-50);
      next.set(instance, list);
      return next;
    });
  }

  private handleEvent(instance: string, ev: { event: string; payload: unknown; ts: number[] }): void {
    if (!ev || typeof ev !== 'object' || !('event' in ev)) return;
    this.events.update(prev => {
      const next = new Map(prev);
      const list = (next.get(instance) ?? []).concat(ev).slice(-50);
      next.set(instance, list);
      return next;
    });
  }

  private handleThumbnail(note: ThumbnailNotification): void {
    if (!note || typeof note !== 'object' || !note.instance) return;
    this.thumbnails.update(prev => {
      const next = new Map(prev);
      next.set(note.instance, note);
      return next;
    });
  }
}
