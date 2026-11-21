// The hero's floating chat: it plays everyday exchanges in turn, and while
// Billy works his bubble says what he is doing. It is decorative: the markup
// already reads complete, and none of it runs under reduced motion.

interface Conversation {
  ask: string;
  status: string;
  reply: string;
  icon: string;
  card: string;
  action: string;
}

const hero = document.querySelector<HTMLElement>("[data-hero]");
let heroVisible = true;
let pending: (() => void)[] = [];

const watched = () => heroVisible && !document.hidden;

// Runs a step after a delay. A step that comes due while the hero is off
// screen or the tab is hidden waits until someone can see it.
const later = (milliseconds: number, run: () => void) => {
  window.setTimeout(() => {
    if (watched()) {
      run();
    } else {
      pending.push(run);
    }
  }, milliseconds);
};

const rouse = () => {
  if (!watched()) {
    return;
  }
  const due = pending;
  pending = [];
  for (const run of due) {
    run();
  }
};

type Step = readonly [delay: number, run: () => void];

const sequence = (steps: readonly Step[], done: () => void) => {
  const [first, ...rest] = steps;
  if (!first) {
    done();
    return;
  }
  later(first[0], () => {
    first[1]();
    sequence(rest, done);
  });
};

const step = (name: string) =>
  hero?.querySelector<HTMLElement>(`[data-step="${name}"]`);
const hook = (name: string) =>
  hero?.querySelector<HTMLElement>(`[data-hook="${name}"]`);

const fill = (conversation: Conversation) => {
  const parts = {
    ask: hook("ask"),
    status: hook("status"),
    reply: hook("reply"),
    text: hook("card-text"),
    action: hook("card-action"),
    icon: hook("card-icon") as HTMLImageElement | null | undefined,
  };
  if (parts.ask) {
    parts.ask.textContent = conversation.ask;
  }
  if (parts.status) {
    parts.status.textContent = conversation.status;
  }
  if (parts.reply) {
    parts.reply.textContent = conversation.reply;
  }
  if (parts.text) {
    parts.text.textContent = conversation.card;
  }
  if (parts.action) {
    parts.action.textContent = conversation.action;
  }
  if (parts.icon) {
    parts.icon.src = conversation.icon;
  }
};

const show = (element: HTMLElement | null | undefined) =>
  element?.classList.add("is-shown");

// Leaving is quicker than arriving (review-animations: asymmetric timing).
const leave = (...elements: (HTMLElement | null | undefined)[]) => {
  for (const element of elements) {
    element?.classList.add("is-leaving");
  }
  window.setTimeout(() => {
    for (const element of elements) {
      element?.classList.remove("is-shown", "is-leaving");
    }
  }, 220);
};

const playChat = (conversations: Conversation[], index: number) => {
  const ask = step("ask");
  const typing = step("typing");
  const reply = step("reply");
  const conversation = conversations[index];
  if (conversation) {
    fill(conversation);
  }
  sequence(
    [
      [0, () => show(ask)],
      [700, () => show(typing)],
      [1600, () => leave(typing)],
      [220, () => show(reply)],
      [5600, () => leave(ask, reply)],
    ],
    () =>
      later(720, () =>
        playChat(conversations, (index + 1) % conversations.length)
      )
  );
};

export const startHero = () => {
  if (!hero || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  new IntersectionObserver(([entry]) => {
    heroVisible = entry?.isIntersecting ?? true;
    rouse();
  }).observe(hero);
  document.addEventListener("visibilitychange", rouse);
  const source = hero.querySelector("[data-conversations]")?.textContent;
  const conversations = source ? (JSON.parse(source) as Conversation[]) : [];
  if (conversations.length > 0) {
    // Let the headline and the buttons land first.
    later(2100, () => playChat(conversations, 0));
  }
};
