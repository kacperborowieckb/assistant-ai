# Mascot verification

Run `pnpm --filter @repo/mascot verify`. The tests resolve files through the package interface and check the PNG format, canvas size, alpha channel, and unique accessory IDs. They also check that the web stylesheet exports reduced-motion support. The tests use the checked-in files and need no credentials or network access.

Open the [design preview](../product/mascot/preview.html) from disk. Check that the conversation shows the portrait at 32 px and the light and dark icons show the same face. Select a neck option, turn on the headband, and press **Play greeting**. Check that the full-body layers move as one. Turn on reduced motion in the browser and check that the greeting stays still.

For a release that uses the Apple icon layers, preview the square artwork in Icon Composer on the target platform.
