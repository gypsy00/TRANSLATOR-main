import { broadcastStore } from "@/lib/broadcast-store";
import { getLanguage } from "@/lib/languages";
import type { NextRequest } from "next/server";

// Long-poll window. Short enough to stay well inside any platform timeout,
// long enough that a quiet sermon does not generate constant requests.
const HOLD_MS = 20_000;

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Listener feed.
 *
 * `GET /api/captions?since=<seq>&session=<id>&id=<listenerId>`
 *
 * Holds the request open until there is a caption newer than `since`, the
 * session changes, or the hold window elapses — then returns either way. The
 * client immediately re-requests, so a dropped request costs one round trip
 * rather than a silent hole in the feed.
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  const since = Number(params.get("since") ?? 0) || 0;
  const sessionId = params.get("session");
  const listenerId = params.get("id");

  // The language this device wants. It also tells the translator to keep
  // producing this language, via presence.
  const lang = getLanguage(params.get("lang")).code;

  // What this device currently believes about the sermon being live. Absent on
  // a first poll, in which case there is nothing to compare against.
  const knownLiveParam = params.get("live");
  const knownLive =
    knownLiveParam === null ? null : knownLiveParam === "1";

  // Heartbeats are now an in-memory Map write, so this costs nothing per
  // device and adds no round trip before the caller starts waiting.
  const listeners = listenerId
    ? broadcastStore.heartbeat(listenerId, lang)
    : 0;

  try {
    const state = await broadcastStore.waitForUpdate(
      since,
      sessionId,
      knownLive,
      HOLD_MS,
    );

    // A new session means the client's cursor refers to a sermon that is over.
    const sessionChanged = sessionId !== null && sessionId !== state.sessionId;

    // Captions exist once per language; this device only wants its own.
    const forThisDevice = state.captions.filter((c) => c.lang === lang);

    const captions = sessionChanged
      ? forThisDevice
      : forThisDevice.filter((c) => c.seq > since);

    return Response.json(
      {
        sessionId: state.sessionId,
        live: state.live,
        lang,
        sessionLang: state.lang,
        seq: state.seq,
        sessionChanged,
        captions: captions.map(({ seq, text, ts }) => ({ seq, text, ts })),
        listeners,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[captions]", error);
    return Response.json({ error: "Feed unavailable" }, { status: 503 });
  }
}
