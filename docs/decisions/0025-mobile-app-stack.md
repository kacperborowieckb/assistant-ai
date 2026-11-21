# 0025: Expo for the mobile app, SwiftUI for widgets and Live Activities

Status: accepted

Date: 2026-11-21

This records how `apps/mobile` will be built. It does not start the mobile phase: the [MVP](../product/mvp.md) still leaves the mobile app out of scope, and the Mobile Channel stays later work ([architecture](../product/architecture.md)). Builds on [0001](0001-repository-foundation.md) and the [design direction](../product/design-direction.md).

## Decision

- **App.** `apps/mobile` is an Expo app (React Native) with Expo Router. It follows the design direction: native iOS controls where iOS has them, our own components only for what is ours, and the tokens from [@repo/tokens](../../packages/tokens/README.md).
- **Widgets and Live Activities.** They are written in SwiftUI with WidgetKit and ActivityKit, because iOS renders them only from SwiftUI views and React Native cannot draw inside them. They live as native targets beside the app, added with the `@bacons/apple-targets` config plugin, so they survive `expo prebuild` (Continuous Native Generation) and no hand-edited `ios/` folder is committed.
- **Sharing data.** The app and its widgets share data through an App Group. The app writes what a widget shows and asks WidgetKit to reload; the widget reads it and never calls the agent itself.
- **Live Activity control.** The app starts, updates, and ends a Live Activity through a small Swift module of our own (Expo Modules API) until a maintained package does this well. Updates while the app is closed need pushes from the agent and come with the Mobile Channel.
- **Shared design values.** The tokens build gains a Swift output in the change that adds the first widget target, so the widgets and the app use the same colors, type, and spacing. Swift code follows `.agents/skills/write-swift/SKILL.md`; app motion follows `.agents/skills/animate-expo/SKILL.md`.

## Why

The app is iOS first, but Android is not ruled out (design direction, principle 6). Expo gives one React Native codebase with native navigation, sheets, tabs, and menus, and the repository already uses TypeScript everywhere. Widgets and Live Activities have no React Native path, so they are SwiftUI whatever the app uses; keeping them as plugin-managed targets keeps the native project generated.

The `@bacons/apple-targets` README (read on 2026-11-21) generates widget and Live Activity targets outside `ios/` for Continuous Native Generation, shares data through App Groups with an `ExtensionStorage` module, and needs Expo SDK 53 or later and Xcode 16. It shows no JavaScript API for starting or updating a Live Activity, so that part is ours. Source: [expo-apple-targets](https://github.com/EvanBacon/expo-apple-targets).

Open questions, not checked because the Expo docs could not be reached from the session that wrote this: whether a first-party Expo widgets package is now stable, and what `@expo/ui` (SwiftUI components inside the app) offers. Check both when the mobile phase starts.

## Revisit if

- A first-party Expo package for widgets or Live Activities becomes stable and covers what we need.
- The app needs more native iOS surface than Expo and its config plugins allow, so a SwiftUI app becomes simpler than an Expo app with native modules.
- Android is ruled out for good.
