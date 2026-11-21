// The hero's conversations: on load they play in one after another (your
// message, Billy saying what he is doing, then his answer), and then they
// stay. It is decorative: the markup already reads complete, and none of it
// runs under reduced motion.

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

const sequence = (steps: readonly Step[], done?: () => void) => {
  const [first, ...rest] = steps;
  if (!first) {
    done?.();
    return;
  }
  later(first[0], () => {
    first[1]();
    sequence(rest, done);
  });
};

const show = (element: Element | null | undefined) =>
  element?.classList.add("is-shown");

// Leaving is quicker than arriving (review-animations: asymmetric timing).
const leave = (element: Element | null | undefined) => {
  element?.classList.add("is-leaving");
  window.setTimeout(
    () => element?.classList.remove("is-shown", "is-leaving"),
    220
  );
};

const playVignette = (vignette: HTMLElement, startAt: number) => {
  const steps: Step[] = [];
  let wait = startAt;
  for (const part of vignette.querySelector(".bob")?.children ?? []) {
    const answer =
      part.querySelector("[data-answer]") ??
      (part.matches("[data-answer]") ? part : null);
    if (answer) {
      const typing = answer.querySelector("[data-typing]");
      const reply = answer.querySelector("[data-reply]");
      steps.push(
        [wait, () => show(typing)],
        [1100, () => leave(typing)],
        [220, () => show(reply)]
      );
    } else {
      steps.push([
        wait,
        () =>
          show(
            part.matches("[data-step]")
              ? part
              : part.querySelector("[data-step]")
          ),
      ]);
    }
    wait = 450;
  }
  sequence(steps);
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
  // One after another, once the headline and the buttons have landed.
  for (const [index, vignette] of [
    ...hero.querySelectorAll<HTMLElement>("[data-vignette]"),
  ].entries()) {
    playVignette(vignette, 1900 + index * 650);
  }
};
