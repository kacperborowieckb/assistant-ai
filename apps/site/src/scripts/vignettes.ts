// The hero's small conversations answer a tap: a choice adds your message,
// Billy types, and his answer lands; the Brief's tasks check off; the
// password copies. New messages animate in with CSS (@starting-style in
// hero.astro); this script only adds and removes them.

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const typingTemplate =
  document.querySelector<HTMLTemplateElement>("#typing-template");

// How long Billy "types" before answering; shorter when motion is reduced.
const typingTime = () => (reducedMotion.matches ? 300 : 1000);

const enter = (thread: Element, node: Element) => {
  node.classList.add("is-new");
  thread.append(node);
};

const leave = (node: Element) => {
  node.classList.add("is-leaving");
  window.setTimeout(() => node.remove(), 150);
};

// Plays a reply template: your message first, then Billy typing, then his
// answer in the typing bubble's place.
const play = (vignette: Element, name: string) => {
  const template = vignette.querySelector<HTMLTemplateElement>(
    `template[data-reply="${name}"]`
  );
  const thread = vignette.querySelector("[data-thread]");
  if (!(template && thread)) {
    return;
  }
  const fragment = template.content.cloneNode(true) as DocumentFragment;
  let delay = 0;
  for (const node of fragment.children) {
    if (node.matches(".ask")) {
      window.setTimeout(() => enter(thread, node), delay);
      delay += 450;
      continue;
    }
    const typing = typingTemplate?.content.firstElementChild?.cloneNode(
      true
    ) as Element | undefined;
    if (typing) {
      window.setTimeout(() => enter(thread, typing), delay);
      delay += typingTime();
    }
    window.setTimeout(() => {
      if (typing) {
        leave(typing);
      }
      enter(thread, node);
    }, delay);
    delay += 300;
  }
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
      450 + typingTime()
    );
  }
  if (swap && name === "undo") {
    window.setTimeout(
      () => swap.classList.add("is-struck"),
      450 + typingTime()
    );
  }
  play(vignette, name);
};

const copy = async (button: HTMLButtonElement) => {
  try {
    await navigator.clipboard.writeText(button.dataset.copy ?? "");
  } catch {
    // Copying can be blocked; the button still confirms the example.
  }
  button.classList.add("is-done");
  button.setAttribute("aria-label", "Copied");
  window.setTimeout(() => {
    button.classList.remove("is-done");
    button.removeAttribute("aria-label");
  }, 1800);
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
    const copyButton = target.closest<HTMLButtonElement>("[data-copy]");
    const task = target.closest<HTMLButtonElement>("[data-task]");
    if (chip && !chip.disabled) {
      choose(chip, vignette);
    } else if (copyButton) {
      copy(copyButton);
    } else if (task) {
      tick(task, vignette);
    }
  });
};
