/**
 * Bundles `panel/src/main.ts` into the committed `panel/app.js` (the studio
 * view) and `panel/src/opener.ts` into `panel/opener.js` (the status bar's
 * opener page). prifly installs extensions with `--ignore-scripts`, so the
 * bundles are built here and committed; `test/store-and-bundle.test.ts` fails
 * when one is stale.
 */

import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** The bundle's text for the current sources of `entry`, the studio view's by default. */
export async function bundle(entry = "panel/src/main.ts"): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(ROOT, entry)],
    target: "browser",
    format: "esm",
    minify: false,
  });
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"));
  const output = result.outputs[0];
  if (output === undefined) throw new Error("The bundler produced nothing.");
  return await output.text();
}

if (import.meta.main) {
  await Bun.write(join(ROOT, "panel/app.js"), await bundle());
  await Bun.write(join(ROOT, "panel/opener.js"), await bundle("panel/src/opener.ts"));
  console.log("panel/app.js and panel/opener.js written");
}
