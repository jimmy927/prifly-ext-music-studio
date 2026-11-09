/**
 * Bundles `panel/src/main.ts` into the committed `panel/app.js`. prifly
 * installs extensions with `--ignore-scripts`, so the bundle is built here and
 * committed; `test/panel-bundle.test.ts` fails when it is stale.
 */

import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** The bundle's text for the current sources. */
export async function bundle(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(ROOT, "panel/src/main.ts")],
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
  console.log("panel/app.js written");
}
