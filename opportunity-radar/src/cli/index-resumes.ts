/** `npm run index-resumes` — index the private résumé folder from the terminal. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.ts";
import { openDatabase } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { createSqliteRepositories } from "../repositories/sqlite/index.ts";
import { createLogger } from "../logger.ts";
import { nowIso } from "../utils/time.ts";
import { indexResumeFolder } from "../services/resumes/indexer.ts";

const moduleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const config = loadConfig(process.env, moduleRoot);
const db = openDatabase(config.dbPath);
migrate(db);
const deps = { config, repos: createSqliteRepositories(db), logger: createLogger("index"), now: nowIso };
const force = process.argv.includes("--force");
const result = await indexResumeFolder(deps, { force }, "cli");
console.log(`Indexed ${result.indexed}, skipped ${result.skipped}, failed ${result.failed}, needs OCR ${result.needsOcr}, missing ${result.removed}.`);
for (const m of result.messages) console.log(` - ${m}`);
for (const r of result.items) console.log(`   ${r.extractionStatus.padEnd(12)} q=${String(r.extractionQuality).padStart(3)}  ${r.filename}  [${r.label}]`);
db.close();
