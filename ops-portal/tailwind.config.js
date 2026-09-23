/** Colours come from CSS variables in src/index.css so light/dark themes swap in one place. */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: v("bg"),
        surface: v("surface"),
        sunken: v("sunken"),
        line: v("line"),
        ink: v("ink"),
        muted: v("muted"),
        faint: v("faint"),
        primary: { DEFAULT: v("primary"), fg: v("primary-fg"), soft: v("primary-soft"), hover: v("primary-hover") },
        danger: { DEFAULT: v("danger"), soft: v("danger-soft") },
        g: {
          brand: v("g-brand"), "brand-bg": v("g-brand-bg"),
          kbb: v("g-kbb"), "kbb-bg": v("g-kbb-bg"),
          v360: v("g-v360"), "v360-bg": v("g-v360-bg"),
          transit: v("g-transit"), "transit-bg": v("g-transit-bg"),
          done: v("g-done"), "done-bg": v("g-done-bg"),
          problem: v("g-problem"), "problem-bg": v("g-problem-bg"),
          closed: v("g-closed"), "closed-bg": v("g-closed-bg"),
        },
      },
      fontFamily: {
        sans: ['"Instrument Sans"', "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
      borderRadius: { DEFAULT: "6px", lg: "10px" },
      boxShadow: {
        pop: "0 12px 32px -8px rgb(var(--shadow) / 0.28), 0 2px 6px rgb(var(--shadow) / 0.12)",
      },
    },
  },
  plugins: [],
};
