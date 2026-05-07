# UI Design Notes

Reference points used while iterating: **PHD2** (the de-facto guiding UI for
amateur astronomy), **KStars/Ekos Guide** (integrated observatory suite),
**N.I.N.A.** (modern Windows app, polished panels), **MaxIm DL**
(feature-dense legacy), **SkyX**.

## What an observer is actually doing while guiding

1. **Find a guide star** — point the mount, see the field, pick a star.
   Today: hard, central_point is operator-set without seeing the field.
2. **Calibrate jacobian** — push N/S/E/W, watch displacement, derive J.
   Today: hand-edit YAML and restart. Barely usable.
3. **Arm the loop** — switch to guiding, watch RMS settle.
   Today: button works, but no RMS readout.
4. **Watch for trouble** — clouds, lost star, hot pixel, periodic error,
   wind. Triage: is this a software issue, mount issue, or weather?
   Today: nothing surfaced.
5. **Adjust on the fly** — bump exposure, change threshold, re-acquire,
   nudge mount. Today: only re-acquire and pulse work.

A great guider UI keeps these five activities visible *simultaneously* —
no modal dialogs hiding telemetry while you set exposure, no full-screen
preview burying the drift chart.

## Information hierarchy (what's always on screen)

```
+- header --------------------------------------------------------+
| ocabox guider     instance ●monitoring v446      ws://…  msgs:N |
+- mode toolbar --------------------------------------------------+
| [off] [monitoring] [guiding] [calibrate]   [acquire] [snap]     |
+- frame view ---------+- telemetry --------+- controls ----------+
|                      | drift chart        | camera              |
|                      |   RA red, Dec blue | exp slider + presets|
|     [ canvas ]       |   5-min rolling    | gain, binning       |
|     image + SVG      |                    | apply (set_state)   |
|     overlays:        +--------------------+---------------------+
|     - search circle  | RMS RA / Dec / tot | mount               |
|     - target marker  | FWHM, ADU sat %    | pulse pad N/S/E/W   |
|     - all detects    | last Δ px          | duration presets    |
|     - scale bar      +--------------------+---------------------+
|     - click target   | service health     | journal feed        |
|                      | pid host uptime    | rolling log         |
+----------------------+--------------------+---------------------+
| status bar: acquired_pos · central · exp · last RPC · errors    |
+----------------------------------------------------------------+
```

## The frame view (largest panel)

This is where the observer spends most of their attention. Reference: PHD2's
star-selection canvas.

What's drawn on top of the JPEG:
- **Search circle** at `central_point`, radius `wide_search_radius_px`
  (where the wide-search will look for the star).
- **Selected guide star** marker — circle with crosshair, ADU label.
- **All detected sources** if available (small dots) — tonight's solver
  doesn't surface this yet, but the slot is ready.
- **Scale bar** in pixels (and arcsec when plate scale is known later).
- **Click to acquire** — same as today, but coords transform through SVG
  not bounding-rect math, so accuracy is exact.
- **Drag to pan** (later): allow zoom + pan for big sensors. FL2.1.

Implementation: `<img>` underneath, `<svg>` overlay matching the natural
image dimensions via a viewBox. Click handler reads `evt.offsetX/Y` in SVG
units == sensor pixels. No bounding-rect ratio math.

## The drift chart (right panel, top)

The single most important telemetry: position error over time. PHD2 puts
this dead-centre of its UI for a reason.

- X axis: time (rolling 5-minute window)
- Y axis: pixels, ±20 default, auto-scales to data
- Two lines: RA (X-axis) red, Dec (Y-axis) blue
- Source: `acquired_pos - central_point` per state update.
  In monitoring mode this is the un-corrected drift (proves tracking
  quality + lets us validate J signs). In guiding mode it shrinks to the
  residuals (loop is closing the loop).
- Annotations: vertical lines for `manual_pulse` events, mode changes
- Below the chart: rolling RMS readouts (RA / Dec / total)

## Camera controls (right panel, middle)

Direct manipulation of pipeline state via `set_state` RPC. Batched: change
multiple fields, hit "Apply".

- **Exposure**: slider 0.05–10s log scale + quick-set buttons (0.1, 0.5,
  1, 2, 5s).
- **Gain**: slider, range from observatory config (placeholder: 0–300).
- **Binning**: segmented control 1×1 / 2×2.
- **Threshold** (FFS): slider 3–10σ.
- **Min/Max FWHM** filters.

Apply sends a single `set_state` patch with all changed fields. Pending
changes show with a glow.

## Mount pulse pad (right panel, bottom)

- Big cardinal layout, plain readable letters.
- Duration presets: 200ms / 500ms / 1s / 2s — radio buttons above pad.
- Custom duration field for off-preset values.
- Keyboard shortcuts: arrow keys = N/S/E/W (with current preset duration).
- Result feedback inline (last RPC line — green for ok, red for error).

## Journal panel (right panel, bottom)

Rolling list of recent events + journal entries. Last ~20 visible, full
history scrollable. Coloured by level (info, warning, error).

Useful entries:
- `acquired_gained` / `acquired_lost` (the most informative state
  transitions)
- `mode_changed`
- `manual_pulse`
- `acquire_at_requested`
- Errors from any RPC

## Service health row

Bottom strip, always visible:
- pid · hostname · uptime · last heartbeat age (greys past 30s)
- restart count if non-zero (warning glow)
- NATS connection state + reconnect button if disconnected

## Keyboard shortcuts

| Key | Action |
|---|---|
| `?` | Show shortcuts overlay |
| Space | Toggle mode (monitoring ↔ guiding) |
| `r` | Re-acquire (clears acquired, forces wide search) |
| `c` | Open calibration wizard (FL2.1 — placeholder for now) |
| Arrow keys | Pulse N/S/E/W with current duration preset |
| `1`/`2`/`3`/`4` | Set pulse duration to 200/500/1000/2000 ms |
| `g` | Set mode to guiding |
| `m` | Set mode to monitoring |
| `o` | Set mode to off |

## Visual design

- Dark theme (default for telescope work — eye adaptation).
- Tailwind palette: `zinc-950` background, `zinc-800` borders,
  `zinc-100` body text. Accent green `emerald-500` (acquired, ok),
  amber `amber-500` (warnings), red `red-500` (errors), blue `sky-500`
  (Dec axis), red `rose-500` (RA axis).
- Monospace for numeric readouts (`JetBrains Mono` if available, else
  `ui-monospace`).
- Animations sparingly: 150ms fade for state transitions, no movement
  that distracts from the field view.

## Out of scope for this iteration

- Calibration wizard (just a stub button pointing at the runbook §4)
- Multi-pipeline display per service (FL1 contract is one)
- Multi-service grid (one card per service is current; expansion later)
- Image stretch controls (linear/log/asinh — the service-side stretch
  is fine for FL2; UI control comes when operator complains)
- Plate-scale awareness (no arcsec annotations until WCS is available)
- Sound on events (controversial; defer)

## Why this is better than the v0 card I shipped earlier

| | v0 (last iteration) | v1 (this iteration) |
|---|---|---|
| Drift chart | absent | central, 5-min rolling |
| RMS readout | absent | RA/Dec/total |
| Frame overlays | acquired-pos circle only | search circle + target + scale bar + click-target |
| Camera controls | display only | live editable, apply via RPC |
| Pulse pad | 4 buttons, fixed 500ms | 4 buttons + 4 durations + keyboard |
| Journal | absent | rolling 20-line panel |
| Service health | hidden | always-on footer |
| Keyboard | none | full shortcut set |
| Layout | 2-pane card | 3-pane workshop with header/footer |
