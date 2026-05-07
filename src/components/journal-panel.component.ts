import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { JournalEntry } from '../services/guider.store';

interface FeedItem {
  ts: number[];
  kind: 'event' | 'journal';
  level: 'info' | 'warn' | 'error';
  text: string;
}

/**
 * Rolling feed of events + journal entries for the active guider.
 * Newest entries on top. Coloured by source/level. Auto-scrolls.
 *
 * Aggregates two streams (`events` + `journal`) so the operator has one
 * place to watch. Journal carries human-readable text; events carry
 * machine-readable transitions (acquired_gained, mode_changed, etc.).
 */
@Component({
  selector: 'app-journal-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  template: `
    <div class="flex flex-col gap-px font-mono text-[11px] max-h-72 overflow-y-auto">
      @if (items().length === 0) {
        <div class="text-zinc-600 px-1 py-2">no events yet</div>
      }
      @for (it of items(); track it.ts.join(',') + it.text) {
        <div
          class="flex items-baseline gap-2 px-1 py-0.5"
          [class]="rowClass(it)">
          <span class="text-zinc-500 shrink-0 w-14">{{ formatTime(it.ts) }}</span>
          <span class="text-zinc-400 shrink-0 w-12 uppercase">{{ it.kind }}</span>
          <span class="grow">{{ it.text }}</span>
        </div>
      }
    </div>
  `,
})
export class JournalPanelComponent {
  events = input.required<Array<{ event: string; payload: unknown; ts: number[] }>>();
  journal = input.required<JournalEntry[]>();

  items = computed<FeedItem[]>(() => {
    const out: FeedItem[] = [];
    for (const e of this.events()) {
      out.push({
        ts: e.ts,
        kind: 'event',
        level: this.eventLevel(e.event),
        text: this.formatEvent(e),
      });
    }
    for (const j of this.journal()) {
      out.push({
        ts: j.timestamp,
        kind: 'journal',
        level: this.journalLevel(j.level),
        text: j.message,
      });
    }
    out.sort((a, b) => this.tsKey(b.ts) - this.tsKey(a.ts));
    return out.slice(0, 60);
  });

  private tsKey(ts: number[]): number {
    if (!Array.isArray(ts) || ts.length < 7) return 0;
    return Date.UTC(ts[0], ts[1] - 1, ts[2], ts[3], ts[4], ts[5], ts[6] / 1000);
  }

  formatTime(ts: number[]): string {
    if (!Array.isArray(ts) || ts.length < 6) return '——:——:——';
    const [, , , h, m, s] = ts;
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  private formatEvent(e: { event: string; payload: unknown }): string {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    switch (e.event) {
      case 'mode_changed':
        return `mode ${p['from']} → ${p['to']}`;
      case 'acquired_gained': {
        const pos = p['position'] as number[] | undefined;
        return pos ? `acquired @ (${pos[0]?.toFixed?.(0)}, ${pos[1]?.toFixed?.(0)})` : 'acquired';
      }
      case 'acquired_lost':
        return 'acquired lost';
      case 'manual_pulse':
        return `pulse ${p['direction_label'] ?? p['direction']} ${p['duration_ms']}ms`;
      case 'acquire_at_requested':
        return `acquire_at (${(p['x'] as number)?.toFixed?.(0)}, ${(p['y'] as number)?.toFixed?.(0)})`;
      case 'acquire_requested':
        return 'acquire (wide-search)';
      default:
        return `${e.event} ${JSON.stringify(p)}`;
    }
  }

  private eventLevel(event: string): 'info' | 'warn' | 'error' {
    if (event === 'acquired_lost') return 'warn';
    return 'info';
  }

  private journalLevel(level: number): 'info' | 'warn' | 'error' {
    if (level >= 40) return 'error';
    if (level >= 30) return 'warn';
    return 'info';
  }

  rowClass(it: FeedItem): string {
    if (it.level === 'error') return 'text-red-400 bg-red-950/30';
    if (it.level === 'warn') return 'text-amber-400 bg-amber-950/20';
    return 'text-zinc-300';
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
