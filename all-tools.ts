/** Every session tool of the extension, each linking the projects it uses to the calling session. */

import type { ExtensionTool } from "@prifly/extension-api";
import { deliverTool, masterTool, prepareTool } from "./dj-tools";
import { inSession } from "./session";
import { arrangeTool, chooseTool, mixTool, sfxTool, stemsTool } from "./stage-tools";
import type { Studio } from "./studio";
import { libraryTool, sketchTool } from "./tools";
import { storyboardTool, treatmentTool } from "./video-tools";
import { editTool, renderTool, shootTool } from "./video-tools-make";

export function allTools(studio: Studio): ExtensionTool[] {
  return inSession([
    sketchTool(studio),
    libraryTool(studio),
    chooseTool(studio),
    arrangeTool(studio),
    stemsTool(studio),
    sfxTool(studio),
    mixTool(studio),
    masterTool(studio),
    prepareTool(studio),
    deliverTool(studio),
    treatmentTool(studio),
    storyboardTool(studio),
    shootTool(studio),
    editTool(studio),
    renderTool(studio),
  ]);
}
