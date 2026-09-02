import { loadConfig } from "../config.ts";
import { openDatabase } from "./client.ts";
import { migrate } from "./migrate.ts";

const config = loadConfig(process.env);
const db = openDatabase(config.dbPath);
const result = migrate(db);
console.log(
  result.applied.length ? `Applied: ${result.applied.join(", ")}` : "Database already up to date.",
  `(latest: ${result.current ?? "none"})`,
);
db.close();
