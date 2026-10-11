import { RpcChain } from "./chain";
import { loadConfig } from "./config";
import { connect, migrate } from "./db";
import { createServer } from "./server";
import { Worker } from "./worker";

// `api` and `worker` share nothing but PostgreSQL; `all` runs both for local development.
const mode = process.argv[2] ?? "all";
if (!["api", "worker", "all"].includes(mode)) {
  console.error("usage: bun src/main.ts api|worker|all");
  process.exit(2);
}

const config = loadConfig();
const db = connect(config.databaseUrl);
const chain = new RpcChain(config.rpcUrl, config.network);
const applied = await migrate(db);
if (applied.length) {
  console.log(`migrations applied: ${applied.join(", ")}`);
}

if (mode === "api" || mode === "all") {
  const server = createServer({
    chain,
    db,
    host: config.host,
    port: config.port,
  });
  console.log(
    `forge api listening on http://${server.hostname}:${server.port} (${config.network})`
  );
}
if (mode === "worker" || mode === "all") {
  new Worker(db, chain, {
    tickMs: config.workerTickMs,
    workerId: config.workerId,
  }).start();
  console.log(
    `forge worker ${config.workerId} running every ${config.workerTickMs}ms`
  );
}
