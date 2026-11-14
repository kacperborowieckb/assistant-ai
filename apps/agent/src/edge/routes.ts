export const edgeRoutes = [
  {
    method: "POST",
    path: "/telegram/webhook",
    access: "Telegram secret token in X-Telegram-Bot-Api-Secret-Token",
    purpose:
      "Receives a Telegram update, finds the Owner through the Directory, and stores the Event in the Owner's Personal Agent before it answers 200.",
  },
  {
    method: "POST",
    path: "/operator/owners",
    access: "Operator token as Authorization: Bearer",
    purpose:
      "Adds an Owner with a Telegram Channel Identity through the Directory. Registration stays closed.",
  },
] as const;

export type EdgeRoute = (typeof edgeRoutes)[number];

export type EdgeRouteKey = `${EdgeRoute["method"]} ${EdgeRoute["path"]}`;
