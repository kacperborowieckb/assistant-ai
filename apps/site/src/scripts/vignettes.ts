// The hero's small conversations answer a tap: a choice is marked, Billy
// types, and his answer lands; the Brief's tasks check off. New messages
// animate in with CSS (@starting-style in hero.astro); this script only adds
// them.

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const typingTemplate =
  document.querySelector<HTMLTemplateElement>("#typing-template");

// How long Billy "types" before answering; shorter when motion is reduced.
const typingTime = () => (reducedMotion.matches ? 300 : 1000);

const enter = (thread: Element, node: Element) => {
  node.classList.add("is-new");
  thread.append(node);
};

// Billy types, then his answer takes the typing bubble's exact place, so
// nothing below it jumps (no exit fade while the answer is added under it).
const play = (vignette: Element, name: string) => {
  const template = vignette.querySelector<HTMLTemplateElement>(
    `template[data-reply="${name}"]`
  );
  const thread = vignette.querySelector("[data-thread]");
  const answer = template?.content.firstElementChild?.cloneNode(true) as
    | Element
    | undefined;
  if (!(thread && answer)) {
    return;
  }
  const typing = typingTemplate?.content.firstElementChild?.cloneNode(true) as
    | Element
    | undefined;
  if (!typing) {
    enter(thread, answer);
    return;
  }
  enter(thread, typing);
  window.setTimeout(() => {
    answer.classList.add("is-new");
    typing.replaceWith(answer);
  }, typingTime());
};

// Changes a card's text in place: blur out, swap, blur back in.
const swapText = (element: HTMLElement, text: string) => {
  element.classList.add("is-swapping");
  window.setTimeout(() => {
    element.textContent = text;
    element.classList.remove("is-swapping");
  }, 150);
};

const choose = (chip: HTMLButtonElement, vignette: Element) => {
  const choices = chip.closest("[data-choices]");
  for (const option of choices?.querySelectorAll<HTMLButtonElement>("button") ??
    []) {
    option.disabled = true;
  }
  chip.setAttribute("aria-pressed", "true");
  const swap = vignette.querySelector<HTMLElement>("[data-swap]");
  const name = chip.dataset.say ?? "";
  if (swap && chip.dataset.swapTo) {
    window.setTimeout(
      () => swapText(swap, chip.dataset.swapTo ?? ""),
      typingTime()
    );
  }
  if (swap && name === "undo") {
    window.setTimeout(() => swap.classList.add("is-struck"), typingTime());
  }
  play(vignette, name);
};

const tick = (task: HTMLButtonElement, vignette: HTMLElement) => {
  task.setAttribute(
    "aria-pressed",
    task.getAttribute("aria-pressed") === "true" ? "false" : "true"
  );
  const tasks = [...vignette.querySelectorAll("[data-task]")];
  const allDone = tasks.every(
    (item) => item.getAttribute("aria-pressed") === "true"
  );
  if (allDone && !vignette.dataset.finished) {
    vignette.dataset.finished = "true";
    play(vignette, "done");
  }
};

export const startVignettes = () => {
  document.querySelector(".vignettes")?.addEventListener("click", (event) => {
    const target = event.target as Element;
    const vignette = target.closest<HTMLElement>("[data-vignette]");
    if (!vignette) {
      return;
    }
    const chip = target.closest<HTMLButtonElement>("[data-say]");
    const task = target.closest<HTMLButtonElement>("[data-task]");
    if (chip && !chip.disabled) {
      choose(chip, vignette);
    } else if (task) {
      tick(task, vignette);
    }
  });
};
