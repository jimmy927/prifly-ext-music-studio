/**
 * The words sent to the image and video models. The video docs ask for the
 * role of each picture to be said in natural language (no tags like
 * `<FIRST_FRAME>`), so the prompt says which picture is the opening frame and
 * which are the cast.
 */

import type { CastMember, Treatment } from "../project/video";
import type { Shot } from "./shotlist";

const NO_TEXT = "No text, captions, logos or watermarks in the picture.";

function castLines(cast: CastMember[]): string {
  const named = cast.map(
    (each, at) => `picture ${at + 1} is ${each.name === "" ? `cast member ${at + 1}` : each.name}`,
  );
  return named.length === 0
    ? ""
    : `Keep the cast looking exactly like the reference pictures (${named.join("; ")}).`;
}

function look(treatment: Treatment): string {
  return [
    treatment.concept === "" ? "" : `Music video concept: ${treatment.concept}`,
    treatment.look === "" ? "" : `Look: ${treatment.look}`,
  ]
    .filter((each) => each !== "")
    .join("\n");
}

const CENTRE =
  "Keep the subject in the middle third of the frame so a 9:16 crop of the centre still works.";

/** The prompt for a shot's still frame. */
export function framePrompt(treatment: Treatment, shot: Shot): string {
  return [
    "A single still frame for a music video, 16:9, cinematic.",
    look(treatment),
    `Shot: ${shot.text}`,
    castLines(treatment.cast),
    treatment.vertical ? CENTRE : "",
    NO_TEXT,
  ]
    .filter((each) => each !== "")
    .join("\n");
}

/** The prompt for a cast member's reference picture. */
export function castPrompt(treatment: Treatment, prompt: string): string {
  return [
    "A character or subject reference picture for a music video: one clear, well-lit view of the subject on a plain background, showing the face or the whole design clearly.",
    look(treatment),
    `Subject: ${prompt}`,
    NO_TEXT,
  ]
    .filter((each) => each !== "")
    .join("\n");
}

/** The prompt for a shot's clip: the still frame first, then the cast. */
export function clipPrompt(treatment: Treatment, shot: Shot, castCount: number): string {
  const cast =
    castCount === 0
      ? ""
      : `The other ${castCount === 1 ? "picture shows" : `${castCount} pictures show`} the cast and set: keep them looking the same; do not show these pictures themselves in the video.`;
  return [
    "Make a short music video shot. The first picture is the opening frame of the shot: start from it exactly, then let the scene move.",
    cast,
    look(treatment),
    `Shot: ${shot.text}`,
    "Move to the beat of the music, with a steady camera and no cuts inside the shot.",
    "No on-screen text or captions.",
  ]
    .filter((each) => each !== "")
    .join("\n");
}
