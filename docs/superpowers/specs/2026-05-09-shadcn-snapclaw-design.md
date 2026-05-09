# SnapClaw setup UI polish — design spec

**Date:** 2026-05-09
**Status:** Approved by user (brainstorming phase)
**Topic file name reflects the user's original framing ("bring shadcn to snapclaw").**
**Actual decision:** **don't adopt shadcn/ui.** Do a CSS-only design system refresh instead.

## Problem

The SnapClaw setup UI (`public/setup.html` + `public/setup.js` from `src/client/setup.ts`) is a single page that serves three states: Connect Codex, Add Telegram Bot, and the post-setup Dashboard (which embeds an xterm terminal and is the long-lived admin view, seen on every visit to the Railway domain — not a one-shot wizard).

The aesthetic reads as "homemade": ad-hoc spacing, mixed radii, gradient text, oversized hero CTAs in dashboard contexts, slow/wobbly entrance animations, inconsistent surface hierarchy. The goal is to make it feel product-grade without changing behavior or expanding surface area.

## Why not shadcn/ui

The user's framing was "bring shadcn to snapclaw," but the underlying goal (confirmed in brainstorming) is purely aesthetic polish, not new UI primitives or future surface expansion.

shadcn/ui is fundamentally a React component collection on Tailwind + Radix. Adopting it means:

- Replacing the ~30KB vanilla-TS IIFE bundle with a ~150–250KB React + ReactDOM + Radix runtime
- Adding Tailwind to the build pipeline
- Rewriting `src/client/setup.ts` as a React app
- Adopting shadcn's Vercel-flavored neutral defaults, which would erase SnapClaw's distinctive orange-on-dark brand identity

For a setup wizard whose problem is "looks unpolished," that cost is wildly out of proportion. A token-driven CSS refresh achieves the actual goal — a cohesive, intentional visual system — while preserving the brand and the existing stack.

If SnapClaw later grows new screens (settings, logs, multi-agent management), revisit React + shadcn at that point. This decision is not load-bearing for that future move.

## Approach: CSS-only design system refresh

Replace the current ad-hoc CSS in `public/setup.html` with a token-driven design system in a new `public/setup.css`. No new dependencies, no behavior changes, no build pipeline changes.

## Design tokens

All declared on `:root` in `public/setup.css`.

### Color
- `--bg`, `--surface-1`, `--surface-2` — page, card, code/input
- `--border`, `--border-strong` — default and focus/active borders
- `--text`, `--text-muted`, `--text-faint` — three-step type contrast
- `--accent` (#e85d3a), `--accent-hover`, `--accent-glow`, `--accent-fg` (#fff for text on accent)
- `--success`, `--success-bg`, `--danger`, `--danger-bg`, `--warning`, `--warning-bg`

### Type scale
- Sizes: `--text-xs` (.75rem), `--text-sm` (.85rem), `--text-base` (.95rem), `--text-lg` (1.1rem), `--text-xl` (1.4rem), `--text-2xl` (1.75rem)
- Families: `--font-sans` (DM Sans), `--font-mono` (JetBrains Mono)
- Only these two families are loaded; remove any inline font-family declarations from HTML

### Spacing scale
4px base. `--space-1` (4) through `--space-8` (64): 4, 8, 12, 16, 24, 32, 48, 64. All margin/padding values in `setup.css` reference these tokens; arbitrary `rem` values are not allowed.

### Radii
- `--radius-sm` (8px) — inputs, badges, code, small chips
- `--radius-md` (12px) — buttons, small cards
- `--radius-lg` (16px) — large cards, terminal container

### Motion
- `--duration-fast` (150ms), `--duration-base` (250ms)
- `--ease` — `cubic-bezier(0.16, 1, 0.3, 1)`

### Elevation
- `--shadow-card` — subtle inner highlight + small drop shadow for cards at rest
- `--shadow-button-hover` — slightly deeper for interactive hover state
- `--shadow-popover` — for any future overlay / popover (not used by current components but defined)

## Component fixes

Each fix is concrete and scoped to existing markup. No new components.

| # | Currently | Fix |
|---|-----------|-----|
| 1 | Gradient text on `<h1>` | Solid `--text` color; logo carries brand weight |
| 2 | Background grid pattern | Keep, but soften: opacity .015 (was .03), grid 96px (was 60px) |
| 3 | Buttons translateY on hover + heavy shadow | No transform. Background shifts to `--accent-hover`; subtle shadow only. `:active` uses filter |
| 4 | "Open Web UI" rendered as huge `done-link` hero | Demote to regular `.btn-secondary`-equivalent matching the other dashboard buttons |
| 5 | `<pre>` and `<code>` use `--bg` | Move to `--surface-2` for clear hierarchy: bg → card surface → code surface |
| 6 | Cards are flat (border + bg only) | Apply `--shadow-card`: inset 1px highlight on top + subtle drop shadow |
| 7 | Step circles are flat orange | Filled state: small inset highlight via box-shadow. Done state: render a checkmark glyph using a `::after` SVG (or an inline-SVG background-image) on `.step-number.done`, with the number text hidden via `font-size:0` on the parent. CSS-only — no markup change |
| 8 | Inputs use `--bg` background | Inputs use `--surface-2`. Focus ring: 1px `--accent` border + 3px `--accent-glow` |
| 9 | Animations are slow (.6s, .4s) and big (16px translate) | Snap to `--duration-base`, translate 4–6px max, ease out |
| 10 | Spacing/radii are arbitrary | All values reference scale tokens |
| 11 | `:focus` only | Switch to `:focus-visible` |
| 12 | Status bar pill is wide for "Loading…" | Compact: 28px height, dot + text only |

## File scope

### Touch
- `public/setup.html` — extract the `<style>` block; replace inline `style="..."` attrs (~6 instances) with utility/component classes; add `<link rel="stylesheet" href="/snapclaw/setup.css">`
- `public/setup.css` — new file (~250–350 lines)

### Don't touch
- `src/client/setup.ts` — no behavior changes
- HTML element IDs — `setup.ts` finds elements by ID; refactoring IDs would force a TS change
- `package.json`, `tsconfig.json`, build scripts — CSS is served as a static asset, no preprocessing
- xterm / terminal theming — has its own theming layer; out of scope
- Server code (`src/index.ts`, `src/gateway.ts`, etc.)

### Behavior contracts — CSS classes setup.ts depends on
`src/client/setup.ts` toggles these classes as part of the setup state machine. The implementation **must preserve these class names** (they can be restyled, but not renamed or removed):

- `.hidden` — show/hide elements via `classList.add/remove("hidden")`. Must keep `display:none !important` semantics.
- `.configured` — applied to `#statusBar` when setup is complete. Restyle freely; preserve the name.
- `.done` — applied to `#codexStep` and `#telegramStep` when each step finishes. Triggers the checkmark swap (item #7).
- `.status-badge` and its variants `.status-badge.success` and `.status-badge.pending` — `setup.ts:39` sets `badge.className = \`status-badge ${type}\``. Both variants must remain valid selectors. (Watch for additional variants like `.error` if used in `setup.ts` — preserve any encountered during implementation.)

For item #4 (demoting `.done-link`): `setup.ts` does **not** reference `.done-link`, so the class can be removed. The "Open Web UI" element is an `<a>` tag, so introduce a `.btn` and `.btn-secondary` rule that styles both `<button>` and `<a>` consistently.

### Inline-style removal map
The 6 inline `style=""` attrs in `setup.html` map to:
- `style="margin-top:.75rem"` (codexStart) → no class needed; spacing is owned by `.card > * + *` rules
- Dashboard button row `style="display:flex; gap:.75rem; margin-top:1.25rem; flex-wrap:wrap;"` → `.btn-row` (extend existing `.btn-row` rule to include flex-wrap)
- `<h3 style="font-size:.85rem; ...">` → use the existing `.card h3` rule (and adjust that rule to match)
- `<a class="done-link" style="margin:0; font-size:.9rem; padding:.7rem 1.6rem;">` → drop `done-link` class entirely; use the standard button rule
- `<input style="text-transform:uppercase">` → keep as-is OR add `.input-uppercase` class; trivial either way

## Risk and rollback

- **Risk surface:** very low. CSS-only; no JS, server, or dependency changes. Worst case is a visual regression on a state we forgot to test.
- **Rollback:** revert the two file changes. No migration, no data, no state to worry about.

## Validation

- Manual: `npm run build && npm start`, open setup page in fresh-deploy state, walk through Codex → Telegram → Dashboard. Verify each state at 360px, 768px, and 1280px widths.
- Visual diff against current state, side-by-side.
- No automated tests; project has none today and a visual regression rig is overkill for this scope.

## Out of scope (explicit)

- Adopting React, Tailwind, or shadcn/ui
- New components (dialogs, toasts, dropdowns, etc.)
- Light-mode support
- Behavior changes to the setup flow
- xterm theming
- Any change to `setup.ts`, server code, or build pipeline

## Next step

Invoke the `superpowers:writing-plans` skill to produce an implementation plan with concrete steps for each token group and component fix.
