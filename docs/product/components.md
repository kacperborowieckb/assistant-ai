# Component contracts

Each shared component has one contract: its name, variants, states, tokens, and accessibility. The website and the iOS app build it from their own best parts and keep the same name and behavior ([design direction](design-direction.md), principle 2). Token names come from [@repo/tokens](../../packages/tokens/README.md), and terms follow [CONTEXT.md](../../CONTEXT.md). The iOS chat mocks in the Billy chat canvas show these components in use.

Every component follows these rules:

- Touch targets are at least `size-touch` (44 points), even when the drawn shape is smaller.
- Text and control edges use only pairs listed in `contrast.pairs` in `tokens.json`.
- Keyboard focus on the web is a 2px `focus-ring` outline with a 2px offset. iOS uses the system focus.
- A state is never shown by color alone. Pair it with a word, an icon, or a shape.
- Motion uses the `duration-*` and `easing-*` tokens and stops under reduced motion.

Write copy in the product voice: short, plain, second person, sentence case. Use the product terms exactly (Brief, Reminder, Note, Recall, Forget). Use no exclamation marks and no emoji.

## Native, not drawn

On iOS these are system controls tinted with tokens, never redrawn: buttons that iOS draws (glass and bordered), the navigation bar, the tab bar, sheets, context menus (the message long-press menu), switches, pickers, and SF Symbols. On the web, use the built-in element first: `<button>`, `<a>`, `<dialog>`, `<details>`, `<input>`. Forget is the destructive item in a menu: iOS marks it with the destructive role, and the web uses `danger` text with its word.

The contracts below are for what is ours.

## Button

The one primary action of a view, or a secondary action beside it.

- Variants: `primary` has a `forest` fill and `on-forest` text, one per view. `secondary` has a `control-line` border and `ink` text on the surface. `plain` has `forest` text and no fill, for inline actions such as Undo.
- States: default, pressed, focused, disabled. Disabled keeps its label readable and is not focusable on iOS. On the web it uses `aria-disabled` when the reason must stay readable.
- Tokens: `radius-pill` on the marketing site and `radius-sm` inside the app, `text-label` in the app, `space-3` horizontal padding at least.
- iOS: a system `Button` with the bordered prominent or glass style, tinted `forest`. Draw nothing.
- Web: `<a>` when it goes to a page, `<button>` when it acts.

## Chip

A choice in a short set, such as an option in a picker row.

- Variants: `unselected` has a `control-line` border and `ink` text. `selected` has a `honey` fill, a `honey-line` border, `on-honey` text, and a check icon, so the state does not rest on color.
- States: default, pressed, focused, selected, disabled.
- Tokens: `radius-sm`, `text-label`, `space-1` between icon and label, `space-2` between chips.
- iOS: a toggle button with `isSelected` as its accessibility trait.
- Web: `<button aria-pressed>` for a toggle, or a radio input in a `<fieldset>` for one of a set.

## Bubble

One message in the chat.

- Variants: `billy` has a `bubble-billy` fill, no border, `ink` text, and sits on the left. `you` has a `bubble-you` fill, `on-bubble-you` text, and sits on the right. Both use `text-body`.
- Groups: consecutive messages from the same sender form a group, as in Messenger. A message from the other side or a timestamp separator starts a new group. Bubbles in a group sit `space-1` apart, and groups sit `space-3` apart.
- Shape: `radius-lg` corners, except where two bubbles of a group meet on the sender's side: those corners are `radius-tail`. So the first bubble of a group has a small bottom corner, a middle one has two, and the last one has a small top corner. A bubble on its own keeps all four `radius-lg` corners.
- Avatar: the last bubble of each of Billy's groups has his avatar, to its left and aligned to its bottom (see Avatar). The other bubbles of the group keep the same left indent with no avatar. The person never has an avatar.
- Content: text, and Cards inside a `billy` bubble. A bubble does not hold another bubble.
- Actions: Billy's latest message shows Copy, Read aloud, and Share as icon buttons below it, each with its name as the accessible label. A long press opens the native context menu: Copy, Save as Note, Edit Reminder (when the message has one), Share, and Forget.
- Accessibility: each bubble reads its sender, then its text ("Billy: Done. The Reminder is now on Friday."). The timestamp separator reads as text, not as decoration.

## Card

A Reminder, a Note, or a confirmation inside one of Billy's bubbles.

- Variants: `reminder-row` is a list row with an open circle (`control-line` edge), the title in `ink`, and the time in `ink-muted` with tabular figures. `confirmation` has a `forest-soft` ground with `forest-ink` text, a `forest` icon, and a `plain` Button such as Undo. `suggestion` (first launch) has a `bubble-billy` fill, a title, and a line in `ink-muted`, and the whole card is one control.
- Tokens: `radius-md` for `confirmation`, `radius-lg` for `suggestion`, `space-3` padding, `text-body-strong` for the confirmation line.
- Accessibility: a card is one element for VoiceOver with its action as a custom action (Undo). On the web, the card holds a real `<button>` for each action.

## Composer

Where the person writes to Billy. It floats above the chat at the bottom of the screen.

- Parts: an add button (photo, file, or Note), a text field labelled "Message Billy", and a `forest` button that dictates when the field is empty and sends when it is not.
- Tokens: `surface-raised` fill, a `line` hairline with `shadow-composer` to lift it off the chat, `radius-pill`, `size-touch` for each button, and 16 points of text so iOS does not zoom the web field.
- The hairline is decorative and below 3:1. The field is found by its `ink-muted` placeholder, its position, and the `forest` button inside it, and keyboard focus shows the `focus-ring`. This look comes from the iOS chat mock; revisit it if testing shows people miss the field.
- States: empty, typing, sending, dictating, and disabled while offline, with a word that says why.
- iOS: the text field and buttons are system controls inside our drawn container. Return inserts a line, and the send button sends.
- Web: a `<form>` with a `<label>` (visually hidden) and a `<textarea>`.

## Avatar

Billy's face beside the last message of each of his groups (see Bubble). The markup and artwork come from [@repo/mascot](../../packages/mascot/README.md).

- The portrait at `size-avatar` (44 points) in a `radius-round` mask on `avatar-ground`, with the alt text "Billy the Beaver". The portrait crop and disc come from the design system, the size from the iOS chat mock.
- States: idle, listening, typing, and greeting. Each plays only when the agent is in that state, and none plays under reduced motion. Only the greeting exists today (`mascot--greet`, `duration-greet`).
