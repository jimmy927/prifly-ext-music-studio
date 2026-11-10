/**
 * What the Music Studio page asks for at `api/<path>`, answered as JSON. The
 * host serves no audio types, so a sketch's audio goes to the page as base64
 * in JSON (`api/media`) and the page plays it from a Blob URL.
 */

import type { PanelRequest } from "@prifly/extension-api";
import { panelRequest } from "./confirm";
import { isSketchId } from "./project/store";
import { arrangeRoutes } from "./routes/arrange";
import { bodyOf, entryOf, type Handler, startedAnswer } from "./routes/common";
import { crateRoutes } from "./routes/crates";
import { deliverRoutes } from "./routes/deliver";
import { editRoutes } from "./routes/edit";
import { type ListItem, libraryRoute, listItem } from "./routes/library";
import { masterRoutes } from "./routes/master";
import { media } from "./routes/media";
import { mixRoutes } from "./routes/mix";
import { prepareRoutes } from "./routes/prepare";
import { produceRoutes } from "./routes/produce";
import { shootRoutes } from "./routes/shoot";
import { storyboardRoutes } from "./routes/storyboard";
import { treatmentRoutes } from "./routes/treatment";
import { tempoOf } from "./routes/video-common";
import { followRoute } from "./session";
import { type Studio, startSketch, statusOf } from "./studio";

/** The routes of the stages after Idea, one file each; a later stage adds its own here. */
const STAGE_ROUTES: Record<string, Handler> = {
  ...arrangeRoutes,
  ...produceRoutes,
  ...mixRoutes,
  ...masterRoutes,
  ...prepareRoutes,
  ...deliverRoutes,
  ...crateRoutes,
  ...treatmentRoutes,
  ...storyboardRoutes,
  ...shootRoutes,
  ...editRoutes,
};

async function projectView(studio: Studio, id: unknown) {
  const entry = await entryOf(studio, id);
  const store = studio.store();
  const record = await store.readBrief(entry);
  const sketches = await store.sketches(entry);
  return {
    ...listItem(entry),
    folder: store.pathOf(entry),
    /** The tempo Prepare found or was given: the Video stages wait for one. */
    tempo: await tempoOf(store.pathOf(entry)),
    brief: record?.brief ?? null,
    chosen: record?.chosen ?? entry.chosen,
    sketchList: sketches.map((each) => ({
      id: each.id,
      engine: each.engine,
      songId: each.songId,
      lyrics: each.lyrics,
      title: each.title ?? null,
      created: each.created,
    })),
  };
}

async function sketch(studio: Studio, request: PanelRequest) {
  return startedAnswer(await startSketch(studio, request.body));
}

/**
 * The module's `panel` export for the Music Studio window. Every request may
 * carry `session`, the session the window is docked beside: the cards a paid
 * button raises are asked over it (see confirm.ts).
 */
export async function route(studio: Studio, request: PanelRequest): Promise<unknown> {
  const session = request.query["session"] ?? "";
  return await panelRequest.run({ session: session === "" ? null : session }, () =>
    answer(studio, request),
  );
}

async function answer(studio: Studio, request: PanelRequest): Promise<unknown> {
  const { path, query } = request;
  switch (path) {
    case "follow":
      return await followRoute(studio, query["session"] ?? "");
    case "status":
      return await statusOf(studio);
    case "library":
      return await libraryRoute(studio, query["q"] ?? "", query["crate"] ?? "");
    case "project":
      return await projectView(studio, query["id"]);
    case "media":
      return await media(studio, request);
    case "job": {
      const job = studio.jobs.get(query["id"] ?? "");
      if (job === undefined) throw new Error("No such job.");
      return job;
    }
    case "jobs":
      // What is running for a project: a reopened page picks the runs up again.
      return {
        jobs: [...studio.jobs.values()].filter(
          (each) => each.status === "running" && each.project === (query["project"] ?? ""),
        ),
      };
    case "sketch":
      return await sketch(studio, request);
    case "cancel":
      return { ok: studio.cancel(String(bodyOf(request)["job"] ?? "")) };
    case "choose": {
      const body = bodyOf(request);
      if (!isSketchId(body["sketch"])) throw new Error("Pick sketch a, b or c.");
      await studio.store().choose(await entryOf(studio, body["project"]), body["sketch"]);
      return await projectView(studio, body["project"]);
    }
    default: {
      const handler = STAGE_ROUTES[path];
      if (handler === undefined) throw new Error(`No such route: ${path}`);
      return await handler(studio, request);
    }
  }
}

export type { ListItem };
export type ProjectView = Awaited<ReturnType<typeof projectView>>;
