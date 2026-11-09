/** The Arrange stage's routes: the section view, "Render changes", and picking a version. */

import { totalMs } from "../arrange/plan";
import { startArrange } from "../arrange/render";
import { baseOf } from "../project/source";
import { activeVersion, isVersionName, setActive, versions } from "../project/stage";
import { tempoFor } from "../project/tracks";
import { bodyOf, entryOf, type Handler, startedAnswer } from "./common";

export const arrangeView: Handler = async (studio, request) => {
  const entry = await entryOf(studio, request.query["project"]);
  const store = studio.store();
  const dir = store.pathOf(entry);
  const base = await baseOf(store, entry);
  const all = await versions(dir);
  const active = await activeVersion(dir);
  return {
    available: base.ok,
    reason: base.ok ? null : base.reason,
    base: base.ok ? { label: base.label, from: base.from, sections: base.sections } : null,
    tempo: await tempoFor(store, entry),
    active: active?.id ?? null,
    versions: all.map((each) => ({
      id: each.id,
      n: each.n,
      from: each.from,
      counts: each.counts,
      created: each.created,
      sectionCount: each.sections.length,
      durationMs: totalMs(each.sections),
    })),
  };
};

const render: Handler = async (studio, request) => {
  const body = bodyOf(request);
  return startedAnswer(await startArrange(studio, body["project"], body["sections"]));
};

const pick: Handler = async (studio, request) => {
  const body = bodyOf(request);
  const entry = await entryOf(studio, body["project"]);
  const dir = studio.store().pathOf(entry);
  const name = body["version"];
  const found = isVersionName(name)
    ? (await versions(dir)).find((each) => each.id === name)
    : undefined;
  if (found === undefined) throw new Error("No such version.");
  await setActive(dir, found.n);
  return await arrangeView(studio, { path: "arrange", query: { project: entry.id }, body: null });
};

export const arrangeRoutes: Record<string, Handler> = {
  arrange: arrangeView,
  "arrange-render": render,
  "version-pick": pick,
};
