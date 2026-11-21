# Billy the Beaver

Billy the Beaver is the Personal Agent mascot. Use Billy's **portrait** for the conversation avatar and the app icon. Use the **full-body sprite** for larger views and accessories. The design system and apps can depend on `@repo/mascot` with `workspace:*`.

## Show the conversation avatar

[mascot.json](mascot.json) gives the portrait filename and 256 × 256 canvas size. The portrait zooms in on the full-body artwork so the face fills the frame, with the chest and tail still in view. Web apps can import the JSON manifest, resolve the PNG with their asset bundler, and import `@repo/mascot/web.css` for the circular mask.

```html
<span class="mascot mascot--portrait" style="--mascot-size: 32px">
  <img src="PORTRAIT_URL" alt="Billy the Beaver" width="256" height="256" />
</span>
```

## Compose the full-body mascot

The manifest lists the base PNG and the slot order from back to front. Draw the base at the origin. Draw one layer at most from each slot, at the same origin and size. The neck slot has the Forest neckerchief and the Office tie. The head slot has the Sports headband. A head layer can combine with a neck layer.

Add `mascot--greet` to the wrapper for a 500 ms greeting. Remove it when the animation ends so the next greeting can play. The animation only runs for people who allow motion. In a native app, animate the parent view so all layers move together, and respect the platform's reduced-motion setting.

## Edit the artwork

Open [mascot.ora](mascot.ora) in an editor that supports OpenRaster, or import the individual PNGs into a design tool as same-size layers. Keep the canvas square and transparent. Export accessory layers at 256 × 256 with the base in view, then hide the base for export. Keep the origin and transparent padding. Add the new PNG basename to the correct slot in the manifest. Test it on the base with the layers from the other slot.

## Draw Billy's world

`world` in the manifest lists Billy's pixel world: `scenery` (hills, water, a log, the sun and the moon, clouds, a sparkle, a night star, and a frame) and 16-pixel `icons` (note, reminder, brief, calendar, email, web, connector, search). Each is a static SVG on a grid of `world.pixel` (8) screen pixels per art pixel, so draw it at its own size or a whole multiple, with `image-rendering: pixelated`. The hills and water tile sideways. The world's colors are part of the artwork, like Billy's: do not recolor it. The marketing site uses it for its scenes; the app can use it for empty states.

## Export app icons

The `icon` record defines the 1024 × 1024 square artwork. The icon foreground uses the same crop as the conversation portrait. The flat light and dark PNGs are opaque. The matching background plates and transparent foreground can go into Icon Composer. Leave the corners square in the source so the platform can apply its mask. The platform can generate appearances you leave unspecified. [Apple App Icons guidance](https://developer.apple.com/design/human-interface-guidelines/app-icons/)

The [design preview](../../docs/product/mascot/preview.html) uses the package artwork for a home-screen mock, a launch card, and a chat avatar. The [concept archive](../../docs/product/mascot-concepts) contains the original explorations and outfit studies.
