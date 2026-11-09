import { expect, test } from "bun:test";
import { planBody } from "../engines/elevenlabs";
import { sfxBody, sfxProblem, soundEffect } from "../engines/sfx";
import { parseStems, separateStems } from "../engines/stems";
import { readZip } from "../engines/zip";
import { STEMS, wav, zip } from "./stage-world";

test("a ZIP of stems is read into named audio files", () => {
  const files = STEMS.map((name) => ({ name: `${name}.mp3`, bytes: wav(0.05) }));
  const stems = parseStems(zip([{ name: "__MACOSX/", bytes: new Uint8Array() }, ...files]));
  expect(stems.map((each) => each.name)).toEqual(STEMS);
  expect(stems[0]?.ext).toBe("mp3");
  expect(stems[0]?.audio).toEqual(wav(0.05));
  expect(readZip(zip(files)).map((each) => each.name)).toEqual(files.map((each) => each.name));
});

test("stem names are whatever the archive holds, folders and capitals dropped", () => {
  const stems = parseStems(
    zip([
      { name: "stems/Backing Vocals.wav", bytes: wav(0.05) },
      { name: "stems/Guitar.wav", bytes: wav(0.05) },
      { name: "notes.txt", bytes: new Uint8Array([1, 2]) },
    ]),
  );
  expect(stems.map((each) => each.name)).toEqual(["backing-vocals", "guitar"]);
});

test("a reply that is no ZIP, or holds no audio, is a plain error", () => {
  expect(() => parseStems(new Uint8Array([1, 2, 3]))).toThrow("not a ZIP archive");
  expect(() => parseStems(zip([{ name: "readme.txt", bytes: new Uint8Array([1]) }]))).toThrow(
    "no stems",
  );
});

test("separateStems posts the audio as the multipart field file and parses the ZIP", async () => {
  let seen: { url: string; form: FormData | null; key: string | null } | null = null;
  const stems = await separateStems(
    async (url, init) => {
      seen = {
        url,
        form: init?.body instanceof FormData ? init.body : null,
        key: new Headers(init?.headers).get("xi-api-key"),
      };
      return new Response(zip([{ name: "vocals.mp3", bytes: wav(0.05) }]));
    },
    "xi-test",
    { audio: wav(0.05), name: "v1.mp3" },
    null,
  );
  const call = seen as { url: string; form: FormData | null; key: string | null } | null;
  expect(call?.url).toBe("https://api.elevenlabs.io/v1/music/stem-separation");
  expect(call?.key).toBe("xi-test");
  const file = call?.form?.get("file");
  expect(file instanceof Blob).toBe(true);
  expect((file as File).name).toBe("v1.mp3");
  expect(call?.form?.has("stem_variation_id")).toBe(false);
  expect(stems.map((each) => each.name)).toEqual(["vocals"]);
});

test("separateStems sends the variation when one is asked for, and an API error keeps its words", async () => {
  let form: FormData | null = null;
  await separateStems(
    async (_url, init) => {
      form = init?.body instanceof FormData ? init.body : null;
      return new Response(zip([{ name: "a.mp3", bytes: wav(0.05) }]));
    },
    "k",
    { audio: wav(0.05), name: "x.mp3" },
    "two_stems",
  );
  expect((form as FormData | null)?.get("stem_variation_id")).toBe("two_stems");
  await expect(
    separateStems(
      async () =>
        Response.json(
          { detail: { status: "quota_exceeded", message: "Out of credits" } },
          { status: 402 },
        ),
      "k",
      { audio: wav(0.05), name: "x.mp3" },
      null,
    ),
  ).rejects.toThrow("Out of credits");
});

test("the sound-effect request has the shape /v1/sound-generation takes", async () => {
  const request = { text: "cymbal swell", durationSec: 4, loop: false, promptInfluence: 0.3 };
  expect(sfxBody(request)).toEqual({
    text: "cymbal swell",
    duration_seconds: 4,
    loop: false,
    prompt_influence: 0.3,
    model_id: "eleven_text_to_sound_v2",
  });
  let seen = "";
  const audio = await soundEffect(
    async (url, init) => {
      seen = `${init?.method} ${url} ${String(init?.body)}`;
      return new Response(wav(0.05));
    },
    "k",
    request,
  );
  expect(seen).toStartWith("POST https://api.elevenlabs.io/v1/sound-generation {");
  expect(audio.length).toBeGreaterThan(44);
});

test("a sound effect lasts 0.5 to 30 seconds and needs a prompt", () => {
  const ok = { text: "x", durationSec: 1, loop: false, promptInfluence: 0.3 };
  expect(sfxProblem(ok)).toBeNull();
  expect(sfxProblem({ ...ok, durationSec: 0.4 })).toContain("0.5 to 30");
  expect(sfxProblem({ ...ok, durationSec: 31 })).toContain("0.5 to 30");
  expect(sfxProblem({ ...ok, text: " " })).toContain("Describe");
});

test("a plan render asks ElevenLabs to store the song again so it can be edited again", () => {
  const body = planBody([{ song_id: "s", range: { start_ms: 0, end_ms: 5 } }]);
  expect(body["model_id"]).toBe("music_v2_5");
  expect(body["store_for_inpainting"]).toBe(true);
  expect(body["composition_plan"]).toEqual({
    chunks: [{ song_id: "s", range: { start_ms: 0, end_ms: 5 } }],
  });
});
