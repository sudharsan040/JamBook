// Tailwind config — scans src/app.jsx + index.html for utility classes used
// and emits only those into dist/styles.css. Keeps the production CSS tiny.
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: { extend: {} },
  plugins: [],
};
