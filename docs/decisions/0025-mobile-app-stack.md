# 0025: Expo for the mobile app and its widgets and Live Activities

Status: accepted

Date: 2026-11-21

This records how `apps/mobile` will be built. It does not start the mobile phase: the [MVP](../product/mvp.md) still leaves the mobile app out of scope, and the Mobile Channel stays later work ([architecture](../product/architecture.md)). Builds on [0001](0001-repository-foundation.md) and the [design direction](../product/design-direction.md).

## Decision

- **App.** `apps/mobile` is an Expo app (React Native) with Expo Router. It follows the design direction: native iOS controls where iOS has them, our own components only for what is ours, and the tokens from [@repo/tokens](../../packages/tokens/README.md).
- **Widgets and Live Activities.** They are SwiftUI, because iOS renders them only from SwiftUI views. We write them in TypeScript with Expo's `expo-widgets` and the `@expo/ui/swift-ui` components, which render as native SwiftUI. Its config plugin generates the widget extension and the App Group, so they survive `expo prebuild` (Continuous Native Generation) and no hand-edited `ios/` folder is committed.
- **Sharing data.** The app sends a widget everything it shows as props (`updateSnapshot` or `updateTimeline`) through the App Group. Widget code runs in an isolated runtime with no hooks, imports, or module-scope values, so it never calls the agent and never reads the app's state.
- **Live Activities.** The app starts and updates them through `expo-widgets` (`createLiveActivity`). Updates while the app is closed use the Live Activity push token and pushes from the agent, so they come with the Mobile Channel.
- **Swift fallback.** A widget that needs more than `expo-widgets` and Expo UI offer becomes a SwiftUI target written by hand, added with the `@bacons/apple-targets` config plugin. Such Swift code follows `.agents/skills/write-swift/SKILL.md`.
- **Shared design values.** Widget code cannot import `@repo/tokens`, so the app passes the colors and sizes a widget needs in its props, taken from the tokens theme. The tokens build gains a Swift output only when the first hand-written Swift target needs it. App motion follows `.agents/skills/animate-expo/SKILL.md`.

## Why

The app is iOS first, but Android is not ruled out (design direction, principle 6). Expo gives one React Native codebase with native navigation, sheets, tabs, and menus, and the repository already uses TypeScript everywhere. Widgets and Live Activities have no React Native path, so they are SwiftUI whatever the app uses; keeping them as plugin-managed targets keeps the native project generated.

Sources, read on 2026-11-21:

- [Expo Widgets](https://docs.expo.dev/versions/latest/sdk/widgets/) (recommended version `~58.0.29`, not marked alpha or beta): home screen and Lock Screen widgets and iOS Live Activities from Expo UI components without native code; interactive buttons on iOS 17 and later; Live Activity start, update, and push tokens; a config plugin for the extension, the App Group, and push entitlements. Not available in Expo Go, so it needs a development build.
- [Expo UI](https://docs.expo.dev/versions/latest/sdk/ui/): SwiftUI and Jetpack Compose components that map one to one to their native counterparts, usable for a whole app or one screen at a time.
- [expo-apple-targets](https://github.com/EvanBacon/expo-apple-targets): hand-written Swift targets outside `ios/` for Continuous Native Generation, Expo SDK 53 or later, Xcode 16.

## Revisit if

- `expo-widgets` cannot build a widget we need, or its isolated runtime makes widgets harder to keep correct than hand-written SwiftUI.
- The app needs more native iOS surface than Expo and its config plugins allow, so a SwiftUI app becomes simpler than an Expo app with native modules.
- Android is ruled out for good.
