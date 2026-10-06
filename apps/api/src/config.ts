export interface Config {
  databaseUrl: string;
  rpcUrl: string;
  network: string;
  host: string;
  port: number;
  workerTickMs: number;
  workerId: string;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env
): Config {
  const [host = "127.0.0.1", port = "3002"] = (
    env.FORGE_API_ADDR ?? "127.0.0.1:3002"
  ).split(":");
  return {
    databaseUrl:
      env.FORGE_DATABASE_URL ?? "postgres://forge@127.0.0.1:54329/forge",
    host,
    network: env.FORGE_NETWORK ?? "localnet",
    port: Number(port),
    rpcUrl: env.FORGE_RPC_URL ?? "http://127.0.0.1:8899",
    workerId: env.FORGE_WORKER_ID ?? `worker-${process.pid}`,
    workerTickMs: Number(env.FORGE_WORKER_TICK_MS ?? 1000),
  };
}
