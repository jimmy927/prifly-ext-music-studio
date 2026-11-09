/** The page's one way to ask its extension: relative `api/<path>`, JSON both ways. */

import type { ListItem, ProjectView } from "../../panel-router";
import type { Job, Status } from "../../studio";

export type { Job, ListItem, ProjectView, Status };

export type SketchAnswer =
  | { ok: true; job: Job }
  | {
      ok: false;
      reason: "invalid" | "no_key" | "cancelled" | "unsupported" | "failed";
      message: string;
    };

export async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const error =
      typeof data === "object" && data !== null ? (data as { error?: unknown }).error : null;
    throw new Error(typeof error === "string" ? error : `The request failed (${response.status}).`);
  }
  return data as T;
}

export const errorText = (caught: unknown): string =>
  caught instanceof Error ? caught.message : String(caught);
