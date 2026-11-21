import { startVignettes } from "./vignettes";

// The site's script: the day and night switch, the header material, sections
// arriving on scroll, and the hero conversations (./vignettes.ts). Everything works and
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

startVignettes();
