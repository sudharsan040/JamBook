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
    "process.env.SUPABASE_URL": JSON.stringify(process.env.SUPABASE_URL || "https://ztgntzelqnosogkzarjw.supabase.co"),
    "process.env.SUPABASE_KEY": JSON.stringify(process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp0Z250emVscW5vc29na3phcmp3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwNTIxNDAsImV4cCI6MjA5NTYyODE0MH0.WG9ozARaBQuFbmljKs7dRSd9iuyXOBPjt9vP887M6GA"),
  },
  target:   "es2020",
  format:   "iife",
  outfile:  "dist/app.js",
}).catch((err) => {
  console.error(err);
  process.exit(1);
});

console.log("✓ Built dist/app.js");
