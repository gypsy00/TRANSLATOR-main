// Minimal Upstash Redis REST client.
//
// Deliberately dependency-free: the REST API is a single POST, and adding a
// package for that would be more moving parts on the night before a launch.
//
// Returns null from getRedis() when no credentials are configured, which is the
// signal for broadcast-store to fall back to in-process memory.

const url =
  process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? "";
const token =
  process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN ?? "";

export type RedisArg = string | number;

export type Redis = {
  pipeline(commands: RedisArg[][]): Promise<unknown[]>;
  cmd(command: RedisArg[]): Promise<unknown>;
};

let cached: Redis | null | undefined;

export function getRedis(): Redis | null {
  if (cached !== undefined) return cached;

  if (!url || !token) {
    cached = null;
    return cached;
  }

  async function pipeline(commands: RedisArg[][]): Promise<unknown[]> {
    const res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
      cache: "no-store",
    });

    if (!res.ok) {
      throw new Error(`Redis ${res.status}: ${await res.text()}`);
    }

    const payload = (await res.json()) as Array<{
      result?: unknown;
      error?: string;
    }>;

    return payload.map((entry) => {
      if (entry.error) throw new Error(`Redis: ${entry.error}`);
      return entry.result ?? null;
    });
  }

  cached = {
    pipeline,
    async cmd(command: RedisArg[]) {
      const [result] = await pipeline([command]);
      return result;
    },
  };

  return cached;
}

export const isRedisConfigured = Boolean(url && token);
