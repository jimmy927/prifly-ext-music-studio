/**
 * How the reader is asked before a run. A session tool asks with
 * `api.confirm`, which prifly shows over the session whose tool call is
 * running. The panel's own buttons are not inside a tool call, and prifly
 * answers `api.confirm` with no session at once with "no" (`ext.confirm_no_session`),
 * so a panel request asks over its own session when it knows one (`session=`
 * in the page's address), else with a dialog that needs none.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ConfirmSpec, ExtensionApi } from "@prifly/extension-api";
import { sessionOf } from "./session";

/** The panel request being answered: the session its window is docked beside, or null. */
export const panelRequest = new AsyncLocalStorage<{ session: string | null }>();

/** The button word of the dialog a panel without a session asks with. */
export const DIALOG_WORD = "Generate";

/**
 * Asks the reader. True when they said yes, false when they said no, null when
 * this prifly has no way to ask. Inside a panel request, over the panel's
 * session when it has one, else in a dialog showing the same words.
 */
export async function askReader(
  api: ExtensionApi,
  spec: ConfirmSpec,
  word = DIALOG_WORD,
): Promise<boolean | null> {
  const panel = panelRequest.getStore();
  if (panel === undefined) return api.confirm === undefined ? null : await api.confirm(spec);
  // A session prifly no longer knows has no card to show on: prifly would answer no at once.
  if (panel.session !== null && sessionOf(api, panel.session) !== null) {
    if (api.confirm === undefined) return null;
    return await api.confirm({ ...spec, sessionId: panel.session });
  }
  const content = spec.content ?? "";
  const answer = await api.dialog({
    title: spec.title,
    description: spec.summary,
    text: content,
    rows: content === "" ? 1 : 6,
    confirm: word,
  });
  return answer !== null;
}
