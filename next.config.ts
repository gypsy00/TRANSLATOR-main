import { networkInterfaces } from "os";
import type { NextConfig } from "next";

/**
 * Dev-server origins allowed to make cross-origin requests.
 *
 * This used to be a single hardcoded IP — a fossil of one particular Wi-Fi
 * network, which broke the moment the laptop joined a different one. Detect
 * the current LAN address instead, and allow extra origins via env.
 */
function devOrigins(): string[] {
  const fromEnv = (process.env.ALLOWED_DEV_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const lan = Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .filter((net) => net.family === "IPv4" && !net.internal)
    .map((net) => net.address);

  return [...new Set([...fromEnv, ...lan])];
}

const nextConfig: NextConfig = {
  allowedDevOrigins: devOrigins(),
};

export default nextConfig;
