// Build script — replaces the inline esbuild command in the GitHub Action.
// Avoids shell-quoting headaches by passing config through a plain JS object.
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/app.jsx"],
  bundle:    true,
  minify:    true,
  loader:    { ".jsx": "jsx" },
  jsx:       "automatic",
  jsxImportSource: "react",
  // Inject secrets as string literals at build time.
  define: {
    "process.env.NODE_ENV":       JSON.stringify("production"),
    "process.env.SUPABASE_URL":   JSON.stringify(process.env.SUPABASE_URL   || ""),
    "process.env.SUPABASE_KEY":   JSON.stringify(process.env.SUPABASE_KEY   || ""),
    "process.env.CORS_PROXY_URL": JSON.stringify(process.env.CORS_PROXY_URL || ""),
  },
  // Safety net: if any `process.env.SOMETHING` slips through (e.g. a library
  // imports it expecting a Node runtime), give the bundle a stub `process`
  // so accessing `.env.X` returns undefined instead of crashing.
  banner: {
    js: 'var process=typeof process!=="undefined"?process:{env:{}};',
  },
  target:   "es2020",
  format:   "iife",
  outfile:  "dist/app.js",
}).catch((err) => {
  console.error(err);
  process.exit(1);
});

console.log("✓ Built dist/app.js");
