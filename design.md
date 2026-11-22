# Dashboard design

Daily Learning Heart uses a Supabase-inspired visual style, but the UI is plain HTML, CSS, and JavaScript. Supabase is not a runtime dependency. The [app stylesheet](index.html) is the source of truth for the implemented variables.

## Reading and navigation

- Keep the reading flow clear: pillar and archive navigation, briefing title and date, guideline evolution (Block A), landmark studies (Block B), teaching points, and source links.
- Give trials distinct labels for endpoint, effect estimate, confidence interval, and other reported statistics. Make the population and limitations easy to find; do not use color as the only signal for meaning.
- Separate source verification and educational Q&A from the lesson itself. Make missing sources, unavailable live lookups, and generated text distinguishable from the curated briefing.
- Keep question choices, selected answers, feedback, and explanations visually distinct in the review quiz.

## Visual language

| Element | Reference |
| --- | --- |
| Main surfaces | White `--color-canvas`, soft gray `--color-canvas-soft`, subtle hairline borders |
| Text | Near-black `--color-ink`; muted grays for secondary text where contrast permits |
| Primary action | Emerald `--color-primary` (#3ecf8e) with near-black text |
| Feedback | Pair warnings and error colors with explanatory text; reserve dark surfaces for contrast, such as statistics and toasts |
| Type | Inter with system sans-serif fallbacks; JetBrains Mono with system monospace fallbacks |
| Corners | 6 px for standard controls, 12 px for cards, and 4 px for small tags |

## Review checklist

- Check desktop and small screens: source links, long bilingual titles, trial rows, and answer options should wrap without hiding content.
- Check keyboard navigation, visible focus, control labels, and sufficient contrast. Keep reading order consistent with the layout.
- Check both Vietnamese and English for labels, empty states, messages, and dynamic dates. Keep clinical acronyms, units, and citation identifiers intact when translating.
- Keep archive reading and search available without an AI key or Python backend. Treat live lookup failures as a recoverable state.