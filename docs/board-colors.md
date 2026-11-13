# Board color language

The shared Claude/Codex HTML board uses the owner-provided **afterglow Markenguide**, pages 8–9, as its visual source. This is the guide’s Nacht theme, not a separate Conductor palette.

| State | Color | Graph shape |
| --- | --- | --- |
| Building | Pink `#F46B9A` | Solid bar |
| In review | Paper `#F8F5F0` | Hollow bar |
| Ready to merge | Turquoise `#59D5CF` | Hollow bar |
| Done | Turquoise `#59D5CF` | Solid, thinner bar |
| Handed back / queued | Sand `#E7E2DD` | Dashed outline |
| Blocked / warning | Dämmergelb `#FFB547` | Solid bar |
| Failed / blocker | Zinnober `#B42318` | Solid bar with a Paper border |

Navy `#17263B` is the canvas. Paper is primary text; Sand is secondary text. Pink never means failure. Navy separates adjacent bars, including Pink and Turquoise. No gradients, transparency, glow, shadows or additional colors are used. The graph is the main Pink accent; controls remain neutral.

Each graph state has a visible name in the legend. Bars also expose their task and state to keyboard and screen-reader users. Hollow, dashed and thin bars distinguish nearby workflow states without relying on hue alone. The red bar needs a Paper edge: Zinnober against Navy has only 2.32:1 contrast, while Paper against Navy is 14.03:1. Paper on the red error notice is 6.05:1. Normal secondary text is 11.85:1 against Navy.

## Reference decisions

| Decision | Source | Application |
| --- | --- | --- |
| Navy canvas, exact Miami colors, Turquoise success, separate warning/error colors | afterglow Markenguide, p. 8 | Owns every production color; no external palette is imported |
| Figtree / Spline Sans Mono roles; 12 px minimum | afterglow Markenguide, p. 9 | Local font stacks, Arial/system fallbacks; no remote font request |
| Restrained signal accents and high-contrast working text | [Sourcegraph](https://sourcegraph.com), Refero style `243e5bba-b6bc-483d-9a0b-6413968ba15c` | Supports accent discipline only; its colors, effects and marketing layout are not copied |
| Named workflow states alongside color | [Linear task screen](https://refero.design/pages/4a094449-e0ab-4893-8e58-c6239e7c228c) | Existing grouped task rows retained; timeline gains an explicit status key |
| Aligned worker labels and horizontal task bars | [Wrike timeline screen](https://refero.design/pages/4c88646d-64eb-4756-ad02-0055f60b5f87) | Existing timeline layout retained; distinguish states within that layout |

This change applies to the shared HTML view. Claude’s native SVG fallback retains its host-oriented styling.
