# Design direction

This document sets the direction for how the marketing site and the iOS app look, feel, and are built. It states principles, not a plan. Terms follow [CONTEXT.md](../../CONTEXT.md). The visual language itself (colors, type, Billy, copy rules) lives in the Billy design system. Its values live in code in [@repo/tokens](../../packages/tokens/README.md), and the shared components are written down in [the component contracts](components.md).

## The feel

The app is a colleague you text. It should feel calm, clean, and quietly warm: near-white surfaces, bark-brown accents, one forest-green action, and Billy the Beaver as the face of the agent. Nothing shouts. Motion is small and has a reason.

## Principles

### 1. Native controls, branded surfaces

The iOS app uses real iOS controls wherever iOS has one: glass buttons, tab bar, sheets, context menus, switches, pickers, and SF Symbols. They are tinted with our tokens, never imitated. The OS then provides the glass, haptics, gestures, and accessibility, and the app keeps feeling right as iOS changes.

We draw our own components only for what is ours: chat bubbles, Reminder and Note cards, the composer, Billy, and launch and empty states. That is where the brand lives.

If iOS has a control for it, use the control. If we redraw a system control, we must have a reason we can write down.

### 2. Share the foundations, not the components

The website and the app are different platforms with different accessibility models. We do not force one component to render on both. We share what sits underneath:

- **Tokens**: one token file is the single source for colors, type, spacing, radii, and motion. It produces CSS for the web and a theme for the app. No hex value is written by hand outside it.
- **Billy**: one mascot package for both platforms.
- **Words**: the same product terms and voice everywhere.
- **Contracts**: each shared component (Button, Chip, Bubble) has the same name, variants, and states on both platforms, written down once. Each platform builds it from its own best parts.

The two products should look like one family, not like one codebase.

### 3. Accessibility is part of the design

Accessibility is a property of every component, not a later pass.

- Text meets WCAG AA contrast in every theme. This is checked against the tokens, so a failing color cannot ship.
- Every control is reachable and named: by keyboard and screen reader on the web, and by VoiceOver on iOS.
- Type scales with the person's settings (Dynamic Type on iOS). Layouts adapt instead of clipping.
- Touch targets are at least 44 points.
- All motion, including Billy's, respects reduced motion.
- Meaning never rests on color alone.

Starting from native controls and semantic HTML gives us most of this for free. That is a reason to prefer them.

### 4. The web stays light

The marketing site is mostly plain, fast HTML that search engines can read. Interactive parts load only where something moves. Built-in browser elements come before scripts. Components from a library are copied in one at a time, only when a page truly needs one.

### 5. Billy is the character, not decoration

Billy is the agent's face: the avatar beside the latest reply and the figure in empty states and onboarding. He is pixel art, so he is never redrawn, recolored, or approximated. New poses come from the source artwork. His animations (idle, listening, typing, greeting) express the agent's real state and never play just for show.

### 6. iOS first, Android not ruled out

We design for iOS and accept iOS-only choices where they make the app better. We keep them behind a shared component interface, so an Android version can later swap in its own native parts without changing the screens.

### 7. Honest and quiet

The interface reports only what the agent can confirm. There are no exclamation marks, no emoji in the UI, and no fake urgency. Undo is better than confirmation dialogs. Destructive actions such as Forget are clearly marked.

## What this rules out

- A shared cross-platform UI kit that makes the app look the same everywhere and native nowhere.
- Hand-drawn imitations of iOS glass, menus, or sheets.
- Colors, sizes, or fonts hard-coded outside the tokens.
- Full app-style component libraries on the marketing site.
- Decorative motion, and motion that ignores the reduced-motion setting. The one exception is the marketing site's scenery: clouds drift, water flows, and stars twinkle slowly, and all of it stops under reduced motion ([apps/site](../../apps/site/README.md)).
