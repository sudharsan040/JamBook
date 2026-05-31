// Build script — replaces the inline esbuild command in the GitHub Action.
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/app.jsx"],
  bundle:    true,
  minify:    true,
  loader:    { ".jsx": "jsx" },
  jsx:       "automatic",
  jsxImportSource: "react",
  define: {
    "process.env.NODE_ENV":     JSON.stringify("production"),
    "process.env.SUPABASE_URL": JSON.stringify(process.env.SUPABASE_URL || ""),
    "process.env.SUPABASE_KEY": JSON.stringify(process.env.SUPABASE_KEY || ""),
  },
  target:   "es2020",
  format:   "iife",
  outfile:  "dist/app.js",
}).catch((err) => {
  console.error(err);
  process.exit(1);
});

console.log("✓ Built dist/app.js");
