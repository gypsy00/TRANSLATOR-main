import { networkInterfaces } from "os";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/** First non-internal IPv4 address — the one phones on the same Wi-Fi can reach. */
function lanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const net of addresses ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return null;
}

/**
 * Returns the URL the QR code should encode.
 *
 * The old version always returned `os.networkInterfaces()` plus a hardcoded
 * port 3000 — right on a laptop, but on Vercel it handed out the container's
 * private IP, producing a QR code no phone could ever reach.
 *
 * Now: if the preacher reached us over a real hostname, that hostname is by
 * definition reachable, so reuse it. Only rewrite when they are on localhost,
 * where the LAN address is the useful substitution.
 */
export async function GET(req: NextRequest) {
  const host = req.headers.get("host") ?? "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") ?? "http";

  const [hostname, port] = host.startsWith("[")
    ? [host.slice(0, host.indexOf("]") + 1), host.split("]:")[1]]
    : host.split(":");

  const isLocalhost = LOCAL_HOSTNAMES.has(hostname);

  if (!isLocalhost) {
    return Response.json({
      listenUrl: `${proto}://${host}/listen`,
      secure: proto === "https",
      rewritten: false,
    });
  }

  const lan = lanAddress();

  if (!lan) {
    return Response.json({
      listenUrl: `${proto}://${host}/listen`,
      secure: proto === "https",
      rewritten: false,
      warning: "No LAN address found — phones cannot reach localhost.",
    });
  }

  return Response.json({
    listenUrl: `http://${lan}${port ? `:${port}` : ""}/listen`,
    secure: false,
    rewritten: true,
  });
}
