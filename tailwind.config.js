/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{html,ts}"],
  theme: {
    extend: {
      colors: {
        ok:    { DEFAULT: '#22c55e', dim: '#14532d' },
        warn:  { DEFAULT: '#f59e0b', dim: '#78350f' },
        bad:   { DEFAULT: '#ef4444', dim: '#7f1d1d' },
        idle:  { DEFAULT: '#94a3b8', dim: '#334155' }
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace']
      }
    }
  },
  plugins: []
};
