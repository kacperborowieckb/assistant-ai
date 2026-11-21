// The hero's living parts: the ticker of what Billy just did, the floating
// chat that plays real exchanges, and a little depth against the pointer.
// Everything here is decorative: the markup already reads complete, and none
// of it runs under reduced motion.

interface Conversation {
  ask: string;
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

const cycleTicker = (items: HTMLElement[], index: number) => {
  later(3200, () => {
    const current = items[index];
    const nextIndex = (index + 1) % items.length;
    current?.classList.replace("is-active", "is-leaving");
    items[nextIndex]?.classList.add("is-active");
    window.setTimeout(() => current?.classList.remove("is-leaving"), 300);
    cycleTicker(items, nextIndex);
  });
};

const step = (name: string) =>
  hero?.querySelector<HTMLElement>(`[data-step="${name}"]`);
const hook = (name: string) =>
  hero?.querySelector<HTMLElement>(`[data-hook="${name}"]`);

const fill = (conversation: Conversation) => {
  const parts = {
    ask: hook("ask"),
    reply: hook("reply"),
    text: hook("card-text"),
    action: hook("card-action"),
    icon: hook("card-icon") as HTMLImageElement | null | undefined,
  };
  if (parts.ask) {
    parts.ask.textContent = conversation.ask;
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
      [650, () => show(typing)],
      [1300, () => leave(typing)],
      [220, () => show(reply)],
      [5200, () => leave(ask, reply)],
    ],
    () =>
      later(720, () =>
        playChat(conversations, (index + 1) % conversations.length)
      )
  );
};

// Each float drifts against the pointer by its own depth. The offset eases
// toward the target every frame, so it has weight instead of sticking to the
// mouse (emil-design-eng: smooth decorative pointer tracking). Each element
// gets its own transform, so no parent variable restyles the whole scene.
const startDepth = () => {
  const floats = [
    ...(hero?.querySelectorAll<HTMLElement>("[data-depth]") ?? []),
  ].map((element) => ({
    element,
    depth: Number(element.dataset.depth ?? 0),
  }));
  let targetX = 0;
  let targetY = 0;
  let x = 0;
  let y = 0;
  let frame = 0;
  const tick = () => {
    x += (targetX - x) * 0.08;
    y += (targetY - y) * 0.08;
    for (const { element, depth } of floats) {
      element.style.translate = `${(-x * depth).toFixed(2)}px ${(-y * depth).toFixed(2)}px`;
    }
    frame =
      Math.abs(targetX - x) + Math.abs(targetY - y) > 0.001
        ? requestAnimationFrame(tick)
        : 0;
  };
  window.addEventListener(
    "pointermove",
    (event) => {
      if (!heroVisible) {
        return;
      }
      targetX = (event.clientX / window.innerWidth) * 2 - 1;
      targetY = (event.clientY / window.innerHeight) * 2 - 1;
      if (!frame) {
        frame = requestAnimationFrame(tick);
      }
    },
    { passive: true }
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
  const items = [
    ...document.querySelectorAll<HTMLElement>("[data-ticker] .ticker-item"),
  ];
  if (items.length > 1) {
    cycleTicker(items, 0);
  }
  const source = hero.querySelector("[data-conversations]")?.textContent;
  const conversations = source ? (JSON.parse(source) as Conversation[]) : [];
  if (conversations.length > 0) {
    // Let the headline land first.
    later(1100, () => playChat(conversations, 0));
  }
  if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    startDepth();
  }
};
