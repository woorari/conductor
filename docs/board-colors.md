# Board color language

The shared Claude/Codex HTML board adapts **Afterglow Logbook’s current Night design**. The primary references are Logbook’s `app/styles/tokens.css`, `app/styles/ui.css`, `docs/design/prototypes/j-afterglow` and `docs/studio-process-pages/afterglow-brand-theme.md`, inspected on 2026-11-13. Its palette and typography originate in the owner-provided **afterglow Markenguide**, pages 8–9.

| State | Color | Graph shape |
| --- | --- | --- |
| Building | Pink `#F46B9A` | Solid bar |
| In review | Paper `#F8F5F0` | Hollow bar |
| Ready to merge | Turquoise `#59D5CF` | Hollow bar |
| Done | Turquoise `#59D5CF` | Solid, thinner bar |
| Handed back / queued | Logbook secondary `#AEB7C6` | Dashed outline |
| Blocked / warning | Dämmergelb `#FFB547` | Solid bar |
| Failed / blocker | Logbook’s Night Zinnober `#E0443A` | Solid bar; pale-red text on a dark red tag |

Navy `#17263B` is the content sheet, above Logbook’s deeper `#101B2B` canvas. Cards use `#1C2D45`, raised controls `#22354F`, borders `#2A3C57`, Paper primary text and `#AEB7C6` secondary text. These are Logbook’s exact tokens rather than a new neutral ramp. Pink never means failure. Card-colored gaps separate adjacent graph marks, including Pink and Turquoise. The graph is the main Pink accent; controls remain neutral.

Each graph state has a visible name in the legend. Bars also expose their task and state to keyboard and screen-reader users. Hollow, dashed and thin bars distinguish nearby workflow states without relying on hue alone. The original Zinnober `#B42318` has only 2.32:1 contrast against Navy; the graph uses Logbook’s brighter Night error bar. Error tags use its pale-red `#FF9A8E` on `#3B1F27` pair. Text, signal colors and focus rings are checked against their actual card or sheet surfaces.

## Surface and layout adaptation

- A floating content sheet sits on the deeper canvas, with Logbook’s Navy-tinted contact shadows and subtle inset hairlines.
- The top toolbar alone uses the translucent material. Task text, timeline and forms stay on solid surfaces. Reduced-transparency preferences restore an opaque toolbar.
- The compact progress overview uses a three-tile grid, stacking naturally in the desktop side panel. These are actual saved task counts, not invented worker-liveness telemetry.
- The timeline is a full-width panel before the task lists. Named task groups become adjacent panels at wide sizes and stack at narrow sizes. Open problems and pending decisions stay visible ahead of the timeline.
- Task tags use Logbook’s 3px corner and colored edge; controls use 8px corners, panels 14px, and the page sheet 18px. Stroke icons share its compact 24px vocabulary.
- Figtree and Spline Sans Mono are bundled locally with their OFL notices. Facts use Mono; UI copy uses Figtree. Text never goes below 12px.

Logbook explicitly records the 2026 material layer as its exception to the PDF guide’s flat rule. The owner’s instruction to adapt the current Logbook design is the basis for carrying that treatment into this board. It is not inferred from a third-party approval claim.

## Reference decisions

| Decision | Source | Application |
| --- | --- | --- |
| Night surface hierarchy, muted text, semantic tints and status tags | Current Logbook token and component source, plus prototype J | Owns the production surface and component treatment |
| Navy/Pink/Turquoise roles; distinct warning/error families | afterglow Markenguide, p. 8, as adapted by Logbook Night | No external product palette is imported |
| Figtree / Spline Sans Mono roles; 12 px minimum | afterglow Markenguide, p. 9, and Logbook root stylesheet | Bundled webfonts with Arial/system fallbacks; no remote font request |
| Restrained signal accents and high-contrast working text | [Sourcegraph](https://sourcegraph.com), Refero style `243e5bba-b6bc-483d-9a0b-6413968ba15c` | Supports accent discipline only; its colors, effects and marketing layout are not copied |
| Named workflow states alongside color | [Linear task screen](https://refero.design/pages/4a094449-e0ab-4893-8e58-c6239e7c228c) | Existing grouped task rows retained; timeline gains an explicit status key |
| Aligned worker labels and horizontal task bars | [Wrike timeline screen](https://refero.design/pages/4c88646d-64eb-4756-ad02-0055f60b5f87) | Existing timeline layout retained; distinguish states within that layout |

This change applies to the shared HTML view. Claude’s native SVG fallback retains its host-oriented styling.
