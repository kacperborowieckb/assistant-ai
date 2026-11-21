// The only script on the site: the day and night switch, the header material,
// sections arriving on scroll, and Billy answering a tap. Everything works and
// reads the same without it.

const root = document.documentElement;
const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const themeKey = "billy-theme";

const isNight = () =>
  root.dataset.theme ? root.dataset.theme === "dark" : darkScheme.matches;

const toggles = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]"),
];

const labelToggles = () => {
  for (const toggle of toggles) {
    toggle.setAttribute(
      "aria-label",
      isNight() ? "Switch to day" : "Switch to night"
    );
  }
};

const setTheme = (theme: "light" | "dark") => {
  root.dataset.theme = theme;
  try {
    localStorage.setItem(themeKey, theme);
  } catch {
    // Storage can be blocked; the choice then lasts for this page only.
  }
  labelToggles();
};

const switchTheme = (from: HTMLElement) => {
  const next = isNight() ? "light" : "dark";
  if (!document.startViewTransition || reducedMotion.matches) {
    setTheme(next);
    return;
  }
  const box = from.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const radius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y)
  );
  root.style.setProperty("--reveal-x", `${x}px`);
  root.style.setProperty("--reveal-y", `${y}px`);
  root.style.setProperty("--reveal-r", `${radius}px`);
  document.startViewTransition(() => setTheme(next));
};

for (const toggle of toggles) {
  toggle.addEventListener("click", () => switchTheme(toggle));
}
darkScheme.addEventListener("change", labelToggles);
labelToggles();

// The header turns into a material once the page scrolls under it.
const masthead = document.querySelector<HTMLElement>("[data-masthead]");
if (masthead) {
  const update = () =>
    masthead.classList.toggle("is-scrolled", window.scrollY > 8);
  window.addEventListener("scroll", update, { passive: true });
  update();
}

// Sections arrive once, as they enter the viewport. Chat messages inside a
// revealed panel follow one after another.
const reveal = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        continue;
      }
      const element = entry.target as HTMLElement;
      for (const [index, message] of [
        ...element.querySelectorAll<HTMLElement>("[data-chat] > *"),
      ].entries()) {
        message.style.transitionDelay = `${250 + index * 180}ms`;
      }
      element.classList.add("is-in");
      reveal.unobserve(element);
    }
  },
  { rootMargin: "0px 0px -12% 0px", threshold: 0.12 }
);
for (const element of document.querySelectorAll<HTMLElement>("[data-reveal]")) {
  const siblings = [
    ...(element.parentElement?.querySelectorAll<HTMLElement>(
      ":scope > [data-reveal]"
    ) ?? []),
  ];
  element.style.setProperty(
    "--reveal-index",
    String(siblings.indexOf(element))
  );
  reveal.observe(element);
}

// Billy greets once when the page opens, and answers a tap.
const greet = (mascot: Element) => {
  mascot.classList.remove("mascot--greet");
  // Restart the animation on a repeat tap.
  void (mascot as HTMLElement).offsetWidth;
  mascot.classList.add("mascot--greet");
  mascot.addEventListener(
    "animationend",
    () => mascot.classList.remove("mascot--greet"),
    {
      once: true,
    }
  );
};

for (const element of document.querySelectorAll("[data-greet]")) {
  greet(element);
}

const replies = [
  "Hi. What should I remember?",
  "I'm listening.",
  "Tell me one thing for tomorrow.",
  "Your Notes are safe with me.",
  "Still here. Still remembering.",
];

for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-billy]"
)) {
  const says =
    button.parentElement?.querySelector<HTMLElement>("[data-billy-says]");
  const mascot = button.querySelector(".mascot");
  let count = 0;
  let hide: number | undefined;
  button.addEventListener("click", () => {
    if (mascot) {
      greet(mascot);
    }
    button.classList.remove("is-bursting");
    void button.offsetWidth;
    button.classList.add("is-bursting");
    if (says) {
      says.textContent = replies[count % replies.length] ?? "";
      count += 1;
      says.classList.add("is-shown");
      window.clearTimeout(hide);
      hide = window.setTimeout(() => says.classList.remove("is-shown"), 2800);
    }
  });
}
