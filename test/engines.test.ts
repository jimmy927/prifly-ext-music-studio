import { expect, test } from "bun:test";
import { composeDetailed, credits, errorFrom } from "../engines/elevenlabs";
import { decodeInteraction, lyria } from "../engines/gemini";
import { boundaryOf, parseMultipart } from "../engines/multipart";
import { EngineError } from "../engines/types";
import { AUDIO, detailedReply, lyriaReply, multipart, subscription, world } from "./world";

const REQUEST = { prompt: "lo-fi beat", lengthMs: 30000, instrumental: true };

test("composeDetailed sends the documented request and reads the multipart answer", async () => {
  const w = world(() => detailedReply("abc"));
  const key = "xi-test";
  const made = await composeDetailed(w.studio.deps.fetch, key, REQUEST);
  const call = w.calls[0];
  expect(call?.url).toBe("https://api.elevenlabs.io/v1/music/detailed");
  expect(call?.method).toBe("POST");
  expect(call?.headers.get("xi-api-key")).toBe("xi-test");
  expect(JSON.parse(call?.body ?? "")).toEqual({
    prompt: "lo-fi beat",
    music_length_ms: 30000,
    model_id: "music_v2_5",
    force_instrumental: true,
    store_for_inpainting: true,
    with_timestamps: true,
  });
  expect(made.songId).toBe("abc");
  expect(Array.from(made.audio)).toEqual(Array.from(AUDIO));
  expect(made.lyrics).toBe("[Verse]\nla la\nna na");
  expect(made.timestamps).toEqual([{ word: "la", start_s: 1, end_s: 1.4 }]);
});

test("the song id may come from a response header instead of the JSON", async () => {
  const w = world(() => {
    const reply = multipart({ composition_plan: { sections: [] } }, AUDIO);
    return new Response(reply.body, {
      headers: { "content-type": reply.headers.get("content-type") ?? "", "song-id": "hdr9" },
    });
  });
  const made = await composeDetailed(w.studio.deps.fetch, "k", REQUEST);
  expect(made.songId).toBe("hdr9");
  expect(made.lyrics).toBeNull();
});

test("multipart bytes survive: CRLF, NUL and dashes inside the audio", () => {
  const response = detailedReply();
  const boundary = boundaryOf(response.headers.get("content-type"));
  expect(boundary).toBe("XBOUNDARYX");
  return response.arrayBuffer().then((buffer) => {
    const parts = parseMultipart(new Uint8Array(buffer), boundary ?? "");
    expect(parts).toHaveLength(2);
    expect(parts[0]?.headers["content-type"]).toBe("application/json");
    expect(Array.from(parts[1]?.body ?? [])).toEqual(Array.from(AUDIO));
  });
});

test("a body without parts is refused", () => {
  expect(() => parseMultipart(new TextEncoder().encode("nothing here"), "B")).toThrow();
});

test("bad_prompt maps to a refusal carrying ElevenLabs' suggestion", async () => {
  const body = {
    detail: {
      status: "bad_prompt",
      message: "The prompt mentions copyrighted material.",
      data: { prompt_suggestion: "An epic rock ballad with operatic harmonies." },
    },
  };
  const w = world(() => Response.json(body, { status: 422 }));
  const failure = await composeDetailed(w.studio.deps.fetch, "k", REQUEST).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(EngineError);
  expect((failure as EngineError).kind).toBe("bad_prompt");
  expect((failure as EngineError).suggestion).toBe("An epic rock ballad with operatic harmonies.");
  expect(errorFrom(400, JSON.stringify(body)).kind).toBe("bad_prompt");
});

test("other ElevenLabs errors map to auth, credits and http", () => {
  expect(
    errorFrom(401, JSON.stringify({ detail: { status: "invalid_api_key", message: "no" } })).kind,
  ).toBe("auth");
  expect(errorFrom(402, "{}").kind).toBe("credits");
  expect(errorFrom(500, "gateway").kind).toBe("http");
});

test("credits is the character limit less the count used", async () => {
  const w = world(() => subscription(12300, 40000));
  const got = await credits(w.studio.deps.fetch, "xi-test");
  expect(got).toEqual({ left: 27700, limit: 40000, used: 12300, tier: "starter" });
  expect(w.calls[0]?.url).toBe("https://api.elevenlabs.io/v1/user/subscription");
  expect(w.calls[0]?.headers.get("xi-api-key")).toBe("xi-test");
});

test("credits refuses an answer without the counts", async () => {
  const w = world(() => Response.json({ tier: "free" }));
  await expect(credits(w.studio.deps.fetch, "k")).rejects.toThrow("character counts");
});

test("Lyria is called through the Interactions API and its steps are decoded", async () => {
  const w = world(() => lyriaReply());
  const made = await lyria(w.studio.deps.fetch, "g-test", "lyria-3-clip-preview", REQUEST);
  const call = w.calls[0];
  expect(call?.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
  expect(call?.headers.get("x-goog-api-key")).toBe("g-test");
  expect(call?.headers.get("api-revision")).toBe("2026-05-20");
  const sent = JSON.parse(call?.body ?? "") as { model: string; input: string };
  expect(sent.model).toBe("lyria-3-clip-preview");
  expect(sent.input).toContain("lo-fi beat");
  expect(sent.input).toContain("Instrumental only");
  expect(Array.from(made.audio)).toEqual(Array.from(AUDIO));
  expect(made.lyrics).toBe("[Verse]\nhello");
  expect(made.songId).toBeNull();
});

test("a Lyria answer with no audio is a bad response, and errors carry Google's message", async () => {
  expect(() =>
    decodeInteraction({
      steps: [{ type: "model_output", content: [{ type: "text", text: "x" }] }],
    }),
  ).toThrow("no audio");
  expect(() => decodeInteraction({})).toThrow("no steps");
  const w = world(() =>
    Response.json({ error: { message: "API key not valid" } }, { status: 400 }),
  );
  await expect(lyria(w.studio.deps.fetch, "bad", "lyria-3.5", REQUEST)).rejects.toThrow(
    "API key not valid",
  );
});
