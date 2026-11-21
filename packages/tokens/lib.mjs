// Reads tokens.json, checks it, and turns it into the web stylesheet and the
// native theme. build.mjs writes the outputs; the tests call these functions.

const namePattern = /^[a-z][a-z0-9-]*$/u;
const hexPattern = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/u;
const aliasPattern = /^\{(?<target>[a-z][a-z0-9-]*)\}$/u;
const lengthPattern = /^(?<amount>-?\d+(?:\.\d+)?)(?<unit>px|%)$/u;
const durationPattern = /^(?<milliseconds>\d+)ms$/u;
const emPattern = /^(?<amount>-?\d*\.?\d+)em$/u;
const bezierPattern =
  /^cubic-bezier\((?<x1>-?[\d.]+), (?<y1>-?[\d.]+), (?<x2>-?[\d.]+), (?<y2>-?[\d.]+)\)$/u;
const stepsPattern = /^steps\((?<count>\d+), (?<position>start|end)\)$/u;
const shadowLayerPattern =
  /^(?<x>-?\d+)(?:px)? (?<y>-?\d+)(?:px)? (?<blur>\d+)(?:px)?(?: (?<spread>-?\d+)(?:px)?)? (?<color>#[0-9a-f]{6}(?:[0-9a-f]{2})?)$/u;

const families = ["spacing", "radius", "shadow", "size", "motion"];

const fail = (message) => {
  throw new Error(`tokens.json: ${message}`);
};

const themeIds = (tokens) => tokens.color.themes.map(({ id }) => id);

// The page that edits the design system reads a plain string as the first
// theme and a missing theme as the first theme's value. Do the same here.
const rawColor = (token, theme, first) => {
  if (typeof token.value === "string") {
    return token.value;
  }
  return token.value[theme] ?? token.value[first];
};

/** Resolves every color token to a hex value in every theme. */
export const resolveColors = (tokens) => {
  const [first] = themeIds(tokens);
  const byName = new Map(
    tokens.color.tokens.map((token) => [token.name, token])
  );
  const resolve = (name, theme, seen) => {
    const token = byName.get(name);
    if (!token) {
      fail(`unknown color alias {${name}}`);
    }
    if (seen.has(name)) {
      fail(`color alias loop at ${name}`);
    }
    const value = rawColor(token, theme, first);
    const alias = aliasPattern.exec(value);
    if (alias) {
      return resolve(alias.groups.target, theme, new Set([...seen, name]));
    }
    if (!hexPattern.test(value)) {
      fail(`${name} in ${theme} must be lowercase hex or an alias: ${value}`);
    }
    return value;
  };
  return Object.fromEntries(
    themeIds(tokens).map((theme) => [
      theme,
      Object.fromEntries(
        tokens.color.tokens.map(({ name }) => [
          name,
          resolve(name, theme, new Set()),
        ])
      ),
    ])
  );
};

const channel = (value) => {
  const unit = value / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex) => {
  const full = hex.length === 4 ? hex.replaceAll(/[0-9a-f]/gu, "$&$&") : hex;
  const [red, green, blue] = [1, 3, 5].map((start) =>
    channel(Number.parseInt(full.slice(start, start + 2), 16))
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
};

/** WCAG 2 contrast ratio between two opaque hex colors. */
export const contrastRatio = (foreground, background) => {
  const [light, dark] = [luminance(foreground), luminance(background)].toSorted(
    (a, b) => b - a
  );
  return (light + 0.05) / (dark + 0.05);
};

/** Every declared pair in every theme, with its ratio and whether it passes. */
export const contrastResults = (tokens) => {
  const colors = resolveColors(tokens);
  return Object.entries(colors).flatMap(([theme, values]) =>
    tokens.contrast.pairs.map(({ fg, bg, min }) => {
      if (!(fg in values && bg in values)) {
        fail(`contrast pair ${fg} on ${bg} names a missing color`);
      }
      if (values[fg].length === 9 || values[bg].length === 9) {
        fail(`contrast pair ${fg} on ${bg} must use opaque colors`);
      }
      const ratio = contrastRatio(values[fg], values[bg]);
      return { theme, fg, bg, min, ratio, passes: ratio >= min };
    })
  );
};

const styles = (tokens) =>
  tokens.type.groups.flatMap((group) =>
    group.styles.map((style) => ({ ...style, family: group.family }))
  );

/** Throws on any value the outputs or the design system page cannot use. */
export const validate = (tokens) => {
  const names = [
    ...tokens.color.tokens.map(({ name }) => name),
    ...families.flatMap((family) =>
      tokens[family].tokens.map(({ name }) => name)
    ),
  ];
  for (const name of names) {
    if (!namePattern.test(name)) {
      fail(`token name must be lowercase kebab case: ${name}`);
    }
    if (names.indexOf(name) !== names.lastIndexOf(name)) {
      fail(`duplicate token name: ${name}`);
    }
  }
  const tokensWithUsage = [
    ...tokens.color.tokens,
    ...families.flatMap((family) => tokens[family].tokens),
    ...styles(tokens),
  ];
  for (const token of tokensWithUsage) {
    if (typeof token.usage !== "string" || token.usage.trim() === "") {
      fail(`${token.name} needs a usage note`);
    }
  }
  for (const style of styles(tokens)) {
    if (!(style.family in tokens.type.families)) {
      fail(`${style.name} uses an unknown family: ${style.family}`);
    }
    if (typeof style.iosTextStyle !== "string") {
      fail(
        `${style.name} needs an iosTextStyle so it scales with Dynamic Type`
      );
    }
  }
  resolveColors(tokens);
  for (const result of contrastResults(tokens)) {
    if (!result.passes) {
      fail(
        `${result.fg} on ${result.bg} in ${result.theme} is ${result.ratio.toFixed(2)}:1, below ${result.min}:1`
      );
    }
  }
  return tokens;
};

const cssColor = (token, theme, first) => {
  const value = rawColor(token, theme, first);
  const alias = aliasPattern.exec(value);
  return alias ? `var(--color-${alias.groups.target})` : value;
};

const cssLength = (value) =>
  typeof value === "number" ? String(value) : value;

// `font: var(--text-body)` sets the whole style; tracking is separate because
// the font shorthand cannot carry letter-spacing.
const cssTextStyle = (style) => {
  const family = `var(--font-${style.family})`;
  const prefix = `--text-${style.name}`;
  return [
    `${prefix}: ${style.fontWeight} ${style.fontSize}/${cssLength(style.lineHeight)} ${family};`,
    `${prefix}-tracking: ${style.letterSpacing ?? "normal"};`,
  ];
};

const block = (selector, lines) =>
  [`${selector} {`, ...lines.map((line) => `  ${line}`), "}"].join("\n");

/** The web stylesheet: custom properties with a dark theme and reduced motion. */
export const toCss = (tokens) => {
  validate(tokens);
  const [first, ...others] = themeIds(tokens);
  const colorLines = (theme) =>
    tokens.color.tokens
      .filter(
        (token) =>
          theme === first ||
          cssColor(token, theme, first) !== cssColor(token, first, first)
      )
      .map(
        (token) => `--color-${token.name}: ${cssColor(token, theme, first)};`
      );
  const root = [
    "color-scheme: light dark;",
    ...colorLines(first),
    ...Object.entries(tokens.type.families).map(
      ([name, stack]) => `--font-${name}: ${stack};`
    ),
    ...styles(tokens).flatMap((style) => cssTextStyle(style)),
    ...families.flatMap((family) =>
      tokens[family].tokens.map(({ name, value }) => `--${name}: ${value};`)
    ),
  ];
  const durations = tokens.motion.tokens
    .filter(({ value }) => durationPattern.test(value))
    .map(({ name }) => `--${name}: 0ms;`);
  const themed = others.flatMap((theme) => {
    const lines = colorLines(theme);
    const blocks = [
      block(`:root[data-theme="${theme}"]`, [
        `color-scheme: ${theme};`,
        ...lines,
      ]),
    ];
    if (theme === "dark") {
      blocks.unshift(
        `@media (prefers-color-scheme: dark) {\n${block(
          `:root:not([data-theme="${first}"])`,
          lines
        ).replaceAll(/^/gmu, "  ")}\n}`
      );
    }
    return blocks;
  });
  return [
    `/* ${tokens.name} — generated from tokens.json by build.mjs. Do not edit. */`,
    block(":root", root),
    block(`:root[data-theme="${first}"]`, [`color-scheme: ${first};`]),
    ...themed,
    `@media (prefers-reduced-motion: reduce) {\n${block(":root", durations).replaceAll(/^/gmu, "  ")}\n}`,
    "",
  ].join("\n\n");
};

const nativeLength = (value, label) => {
  const match = lengthPattern.exec(value);
  if (!match) {
    fail(`${label} must be px or %: ${value}`);
  }
  const amount = Number(match.groups.amount);
  return match.groups.unit === "px" ? amount : { percent: amount };
};

const nativeShadow = ({ name, value }) =>
  value.split(", ").map((layer) => {
    const match = shadowLayerPattern.exec(layer);
    if (!match) {
      fail(`${name} layers must be "x y blur [spread] #hex": ${layer}`);
    }
    const { x, y, blur, spread, color } = match.groups;
    return {
      x: Number(x),
      y: Number(y),
      blur: Number(blur),
      spread: Number(spread ?? 0),
      color,
    };
  });

const nativeMotion = ({ name, value }) => {
  const duration = durationPattern.exec(value);
  if (duration) {
    return { milliseconds: Number(duration.groups.milliseconds) };
  }
  const bezier = bezierPattern.exec(value);
  if (bezier) {
    return { cubicBezier: Object.values(bezier.groups).map(Number) };
  }
  const steps = stepsPattern.exec(value);
  if (steps) {
    return {
      steps: Number(steps.groups.count),
      position: steps.groups.position,
    };
  }
  return fail(`${name} must be ms, cubic-bezier() or steps(): ${value}`);
};

const nativeText = (style) => {
  const size = nativeLength(style.fontSize, style.name);
  const lineHeight =
    typeof style.lineHeight === "number"
      ? Math.round(size * style.lineHeight * 100) / 100
      : nativeLength(style.lineHeight, style.name);
  let tracking = 0;
  if (style.letterSpacing) {
    const em = emPattern.exec(style.letterSpacing);
    if (!em) {
      fail(`${style.name} letterSpacing must be in em: ${style.letterSpacing}`);
    }
    tracking = Math.round(Number(em.groups.amount) * size * 100) / 100;
  }
  return {
    family: style.family,
    size,
    lineHeight,
    weight: style.fontWeight,
    tracking,
    iosTextStyle: style.iosTextStyle,
  };
};

const byName = (list, convert) =>
  Object.fromEntries(list.map((token) => [token.name, convert(token)]));

/** The native theme: resolved colors per theme and plain numbers in points. */
export const toTheme = (tokens) => {
  validate(tokens);
  return {
    name: tokens.name,
    version: tokens.version,
    generated: "Generated from tokens.json by build.mjs. Do not edit.",
    colors: resolveColors(tokens),
    fonts: tokens.type.families,
    text: byName(styles(tokens), nativeText),
    space: byName(tokens.spacing.tokens, ({ name, value }) =>
      nativeLength(value, name)
    ),
    radius: byName(tokens.radius.tokens, ({ name, value }) =>
      nativeLength(value, name)
    ),
    size: byName(tokens.size.tokens, ({ name, value }) =>
      nativeLength(value, name)
    ),
    shadow: byName(tokens.shadow.tokens, nativeShadow),
    motion: byName(tokens.motion.tokens, nativeMotion),
  };
};
