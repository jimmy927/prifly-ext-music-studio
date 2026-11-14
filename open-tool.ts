/** The session tool `music_open`: shows the Music Studio beside the chat, on a project. */

import type { ExtensionTool } from "@prifly/extension-api";
import type { IndexEntry } from "./project/store";
import { linkSession, STAGE_IDS, type StageId, sessionProject } from "./session";
import type { Studio } from "./studio";
import { OLD_PRIFLY, showView, viewApi } from "./view";

/** The project a reader named by id or title: the exact one, else the only one whose title or brief holds the words. */
async function named(studio: Studio, name: string): Promise<IndexEntry | string> {
  const store = studio.store();
  const byId = await store.find(name);
  if (byId !== null) return byId;
  const all = await store.list();
  const exact = all.filter((each) => each.title.toLowerCase() === name.trim().toLowerCase());
  const found = exact.length > 0 ? exact : await store.list(name);
  const [first, second] = found;
  if (first === undefined) return `No project is called "${name}". music_library lists them.`;
  if (second === undefined || exact.length === 1) return first;
  const lines = found.slice(0, 5).map((each) => `- ${each.title} (${each.id})`);
  return `More than one project matches "${name}"; call again with the id:\n${lines.join("\n")}`;
}

const stageNamed = (name: string): StageId | null =>
  STAGE_IDS.find((each) => each === name) ?? null;

/** The project a call names, else the session's own, else the newest; null for an empty library, a string for what to tell the session. */
async function projectNamed(studio: Studio, given: unknown): Promise<IndexEntry | string | null> {
  const name = typeof given === "string" ? given.trim() : "";
  if (name !== "") return await named(studio, name);
  return (await sessionProject(studio)) ?? (await studio.store().list())[0] ?? null;
}

export function openTool(studio: Studio): ExtensionTool {
  return {
    name: "music_open",
    description:
      "Shows the Music Studio beside the chat, on a song or video project, so the reader sees the sketches, the arrangement, the mix and the video stages as you work on them. Call it FIRST when the reader names a song or a video (a title or id from music_library); the other music_* and video_* tools also open it by themselves the first time, so you only need it to switch to another project or stage. Free, read-only.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description:
            "The project's id or title; default the session's own project, else the newest.",
        },
        stage: {
          type: "string",
          enum: [...STAGE_IDS],
          description:
            "The stage to open on: idea, arrange, produce, mix, master, prepare, treatment, storyboard, shoot, edit or deliver; default idea.",
        },
      },
      additionalProperties: false,
    },
    call: async (args, ctx) => {
      if (viewApi(studio.api()) === null) return `Not done: ${OLD_PRIFLY}`;
      const wanted = args["stage"];
      const stage = typeof wanted === "string" ? stageNamed(wanted) : "idea";
      if (stage === null)
        return `Not done: there is no stage "${String(wanted)}"; the stages are ${STAGE_IDS.join(", ")}.`;
      const found = await projectNamed(studio, args["project"]);
      if (found === null) return "The library is empty. Make sketches first with music_sketch.";
      if (typeof found === "string") return `Not done: ${found}`;
      // Linked first, so the page opens on this project and a later tool call finds it shown.
      await linkSession(studio, ctx.session, found.id, "music_open");
      const shown = await showView(studio, ctx.session, found.id, stage, true);
      if (!shown) return "Not done: prifly could not show the view. Try again.";
      return `Showing "${found.title}" (${found.id}) in the Music Studio beside the chat, on ${stage}.`;
    },
  };
}
