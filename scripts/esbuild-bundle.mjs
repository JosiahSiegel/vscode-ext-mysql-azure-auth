#!/usr/bin/env node
// scripts/esbuild-bundle.mjs
//
// Cross-platform wrapper around `esbuild` for the package step.
//
// Why this exists:
//   The native `esbuild` binary lives at node_modules/esbuild/bin/esbuild.
//   On Windows it is `esbuild.exe`, so `node node_modules/esbuild/bin/esbuild`
//   execs it via the OS shell. On Linux it is the bare ELF binary, which
//   Node refuses to launch as a script (`SyntaxError: Invalid or unexpected
//   token`) because it is not a JS file.
//
//   This wrapper uses esbuild's JS API (`node_modules/esbuild/lib/main.js`)
//   so the same script works on every OS npm runs on. It accepts the
//   same CLI-style flags `esbuild` would, parsing them out of process.argv
//   after the script path.
//
// Flags understood (positional or `--flag value`):
//   --bundle
//   --outfile <path>
//   --external:<name>          (repeatable)
//   --format cjs|esm
//   --platform node|browser|neutral
//   --minify
//   --sourcemap                (boolean)
//
// Anything else is passed through verbatim to esbuild's `build` options.

import { build } from "esbuild";
import { resolve } from "node:path";

const args = process.argv.slice(2);

const opts = {
  entryPoints: [],
  bundle: false,
  outfile: undefined,
  external: [],
  format: undefined,
  platform: undefined,
  minify: false,
  sourcemap: false,
};

for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === "--bundle") {
    opts.bundle = true;
  } else if (a.startsWith("--outfile=")) {
    opts.outfile = a.slice("--outfile=".length);
  } else if (a === "--outfile") {
    i += 1;
    opts.outfile = args[i];
  } else if (a.startsWith("--external:")) {
    opts.external.push(a.slice("--external:".length));
  } else if (a === "--external") {
    i += 1;
    opts.external.push(args[i]);
  } else if (a.startsWith("--format=")) {
    opts.format = a.slice("--format=".length);
  } else if (a === "--format") {
    i += 1;
    opts.format = args[i];
  } else if (a.startsWith("--platform=")) {
    opts.platform = a.slice("--platform=".length);
  } else if (a === "--platform") {
    i += 1;
    opts.platform = args[i];
  } else if (a === "--minify") {
    opts.minify = true;
  } else if (a === "--sourcemap") {
    opts.sourcemap = true;
  } else if (a.startsWith("--")) {
    // Pass-through flag; pair with next arg if it doesn't look like a
    // flag itself.
    const passthrough = { [a.slice(2)]: true };
    if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
      i += 1;
      passthrough[a.slice(2)] = args[i];
    }
    Object.assign(opts, passthrough);
  } else {
    // Positional = entry point.
    opts.entryPoints.push(a);
  }
}

if (!opts.outfile) {
  console.error("esbuild-bundle.mjs: --outfile is required");
  process.exit(2);
}
if (opts.entryPoints.length === 0) {
  console.error("esbuild-bundle.mjs: at least one entry point is required");
  process.exit(2);
}

try {
  await build({
    entryPoints: opts.entryPoints,
    bundle: opts.bundle,
    outfile: resolve(process.cwd(), opts.outfile),
    external: opts.external,
    format: opts.format,
    platform: opts.platform,
    minify: opts.minify,
    sourcemap: opts.sourcemap,
    logLevel: "info",
  });
} catch (err) {
  // esbuild's build() throws on failure; the message already includes
  // the file/line. Print and exit 1.
  console.error(err && err.message ? err.message : err);
  process.exit(1);
}
