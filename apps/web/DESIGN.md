# Amrita Web — Design System (Claude design language)

Source of truth for the web app's visual system. Tokens extracted **live from
claude.com's official CSS** (2026-07-12, Playwright computed-style dump) — this is
Claude's real palette/type/shape system, not an approximation. Amrita adopts the
language and keeps her own identity (the अ mark, Project-OS layout).

## Tokens (authoritative — mirror of `styles.css` `:root`)

```yaml
color:
  # warm gray ramp (Claude gray-000…950)
  paper:        "#faf9f5"   # gray-050 — app background (light)
  ivory:        "#f5f4ed"   # gray-100 — sidebar / secondary bg
  pampas:       "#f0eee6"   # gray-150 — tertiary bg, user bubble
  cloud:        "#e8e6dc"   # gray-200 — hover fills, secondary button
  border:       "#dedcd1"   # gray-250 — hairline borders
  border-mid:   "#d1cfc5"   # gray-300
  stone:        "#b0aea5"   # gray-400 — disabled/placeholder
  gray-500:     "#87867f"
  slate:        "#5e5d59"   # gray-600 — secondary text
  ink-soft:     "#3d3d3a"   # gray-700
  surface-dark: "#30302e"   # gray-750 — dark surfaces
  bg-dark:      "#262624"   # gray-800 — dark app background
  ink:          "#141413"   # gray-950 — primary text
  clay:         "#d97757"   # accent (brand)
  clay-strong:  "#c96442"   # interactive accent (buttons)
  error:        "#b53333"
  ok:           "#629987"   # mineral — success/ready
  sky:          "#6a9bcc"   # info
  oat:          "#e3dacc"   # warm chip
type:
  display: '"Anthropic Serif", ui-serif, Georgia, "Times New Roman", serif'
  body:    '"Anthropic Sans", -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif'
  mono:    'ui-monospace, "SF Mono", Menlo, Consolas, monospace'
  scale:   { micro: 10px, caption: 12px, body-3: 15px, body-2: 17px, h6: 16-19px,
             h5: 20-25px, h4: 23-32px, h3: 28-36px, display: serif 500 weight }
  rules:   headings = serif, weight 500, line-height 1.1–1.2; body 1.6; UI labels sans 500
radius:  { xs: 4px, sm: 8px, md: 12px, lg: 16px, pill: 999px }
border:  1px hairline; focus ring 2px clay at 40%
shadow:
  card:  "0 1px 2px rgba(20,20,19,.04), 0 4px 16px rgba(20,20,19,.05)"
  float: "0 8px 30px rgba(20,20,19,.12)"
motion:  { ease: "cubic-bezier(0.16,1,0.3,1)", fast: 150ms, main: 300ms }
buttons:
  brand:     { bg: clay-strong, text: paper, radius: md }
  primary:   { bg: ink, text: paper }
  secondary: { bg: cloud, text: gray-650, hover-bg: white }
  ghost:     { bg: transparent, text: slate, hover-text: ink }
```

## Layout rules

- **Shell**: ivory sidebar (left, 264px, collapsible) · paper chat center (column
  max-width 46rem) · inspector right (light cards on paper, 360px).
- **Chat**: user messages in `pampas` rounded-lg bubbles; Amrita replies as plain
  text on paper (no bubble) with a small अ avatar; serif greeting hero.
- **Composer**: white rounded-lg (16px) bordered box, soft shadow, clay send button.
- **Cards**: white, 1px `border`, radius 12px, `card` shadow, 16–20px padding;
  section titles: caption-size, letter-spaced, slate.
- **Dark mode**: `prefers-color-scheme: dark` → bg `#262624`, surfaces `#30302e`,
  borders `#3d3d3a`, text `#faf9f5`, same clay accents.

## Mobile (Claude app patterns)

- < 960px: sidebar becomes an overlay drawer (hamburger, backdrop, expo-out slide);
  inspector becomes a full-width section below the chat behind a segmented switch
  (Chat / Project / Brain / Settings); composer sticks to the bottom with
  `env(safe-area-inset-bottom)`; touch targets ≥ 44px.
- No horizontal scroll at 390px, ever. `minmax(0,1fr)` on all grid tracks.

## Do / Don't

- DO keep honest empty states styled as quiet ivory panels with one clear action.
- DO keep RTL support: `dir="auto"` on user content stays mandatory.
- DON'T use random gradients, glassmorphism, neon, or decorative dashboards
  (anti AI-slop rule from the Claude-Design guide).
- DON'T introduce a second accent; clay is the only warm accent, `mineral` only
  for ready/ok badges, `error` only for failures.
