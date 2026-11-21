import base from "@repo/mascot/assets/base.png?url";
import headband from "@repo/mascot/assets/headband.png?url";
// Billy and his world, from @repo/mascot. Imported as URLs so the build copies
// them untouched: pixel art is never resampled (design direction, principle 5).
import brief from "@repo/mascot/assets/icons/brief.svg?url";
import calendar from "@repo/mascot/assets/icons/calendar.svg?url";
import connector from "@repo/mascot/assets/icons/connector.svg?url";
import email from "@repo/mascot/assets/icons/email.svg?url";
import note from "@repo/mascot/assets/icons/note.svg?url";
import reminder from "@repo/mascot/assets/icons/reminder.svg?url";
import search from "@repo/mascot/assets/icons/search.svg?url";
import web from "@repo/mascot/assets/icons/web.svg?url";
import neckerchief from "@repo/mascot/assets/neckerchief.png?url";
import portrait from "@repo/mascot/assets/portrait.png?url";
import tie from "@repo/mascot/assets/tie.png?url";
import cloud from "@repo/mascot/assets/world/cloud.svg?url";
import frame from "@repo/mascot/assets/world/frame.svg?url";
import hills from "@repo/mascot/assets/world/hills.svg?url";
import log from "@repo/mascot/assets/world/log.svg?url";
import sparkle from "@repo/mascot/assets/world/sparkle.svg?url";
import sun from "@repo/mascot/assets/world/sun.svg?url";
import water from "@repo/mascot/assets/world/water.svg?url";

export const billy = { base, portrait } as const;

export const outfits = {
  forest: neckerchief,
  office: tie,
  sports: headband,
} as const;

export type Outfit = keyof typeof outfits;

export const world = { cloud, frame, hills, log, sparkle, sun, water } as const;

export const icons = {
  brief,
  calendar,
  connector,
  email,
  note,
  reminder,
  search,
  web,
} as const;

export type IconName = keyof typeof icons;
