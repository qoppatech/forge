import { createInstitution } from "./auth";
import { loadConfig } from "./config";
import { connect, migrate } from "./db";

const [command, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const db = connect(loadConfig().databaseUrl);
try {
  if (command === "migrate") {
    const applied = await migrate(db);
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
  } else if (command === "create-institution") {
    const name = flag("name");
    if (!name) throw new Error("--name is required");
    await migrate(db);
    const { institution, apiKey } = await createInstitution(db, name, flag("webhook-url"));
    // The API key is shown once; only its hash is stored.
    console.log(JSON.stringify({ institutionId: institution.id, apiKey, webhookSecret: institution.webhook_secret }));
  } else {
    console.error("usage: bun src/cli.ts migrate | create-institution --name <name> [--webhook-url <url>]");
    process.exitCode = 2;
  }
} finally {
  await db.close();
}
