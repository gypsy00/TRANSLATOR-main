import { broadcastStore } from "@/lib/broadcast-store";
import { getLanguage } from "@/lib/languages";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** Preacher-side status: is anyone actually out there, and which store are we on. */
export async function GET() {
  try {
    const [state, listeners, languages] = await Promise.all([
      broadcastStore.getState(),
      broadcastStore.listenerCount(),
      broadcastStore.activeLanguages(),
    ]);

    return Response.json(
      {
        sessionId: state.sessionId,
        live: state.live,
        lang: state.lang,
        seq: state.seq,
        listeners,
        languages,
        backend: broadcastStore.backend,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[session] status failed", error);
    return Response.json({ error: "Store unavailable" }, { status: 503 });
  }
}

/** Start or end a sermon. Starting clears the feed so listeners don't replay last week. */
export async function POST(req: NextRequest) {
  let live: boolean;
  let language: string | undefined;

  try {
    ({ live, language } = await req.json());
  } catch {
    return Response.json({ error: "Malformed request" }, { status: 400 });
  }

  try {
    // getLanguage falls back to the default, so an unknown code can never
    // leave the session in a state the prompt cannot express.
    const state = await broadcastStore.setLive(
      Boolean(live),
      getLanguage(language).code,
    );
    return Response.json({
      sessionId: state.sessionId,
      live: state.live,
      lang: state.lang,
      backend: broadcastStore.backend,
    });
  } catch (error) {
    console.error("[session]", error);
    return Response.json({ error: "Store unavailable" }, { status: 503 });
  }
}
