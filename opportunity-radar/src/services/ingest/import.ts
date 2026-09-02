/** JSON and CSV batch import through the same create path as manual entry. */
import type { AppDeps } from "../../deps.ts";
import type { JsonImport } from "../../schemas/import.ts";
import { ManualOpportunityInputSchema } from "../../schemas/opportunity.ts";
import { csvToObjects } from "../../utils/csv.ts";
import { unprocessable } from "../../utils/errors.ts";
import { createOpportunity } from "../opportunities.ts";

type Deps = Pick<AppDeps, "repos" | "now" | "logger">;

export interface ImportResult {
  created: number;
  duplicates: number;
  items: { id: string; duplicate: boolean; title: string }[];
  errors: string[];
}

export function importJson(deps: Deps, batch: JsonImport, actor = "import"): ImportResult {
  const result: ImportResult = { created: 0, duplicates: 0, items: [], errors: [] };
  for (const item of batch.items) {
    const r = createOpportunity(deps, { ...item, sourceName: item.sourceName === "manual" ? batch.sourceName : item.sourceName, evaluate: batch.evaluate }, actor);
    if (r.duplicate) result.duplicates++;
    else result.created++;
    result.items.push({ id: r.opportunity.id, duplicate: r.duplicate, title: r.opportunity.title });
  }
  return result;
}

/** Accepts the export column names (case-insensitive) or camelCase field names. */
const CSV_ALIASES: Record<string, string> = {
  "company name": "companyName",
  company: "companyName",
  "position title": "title",
  title: "title",
  position: "title",
  "employment type": "employmentType",
  "work mode": "workMode",
  location: "locationText",
  "location / eligibility": "locationText",
  "source name": "sourceName",
  source: "sourceName",
  "source type": "sourceType",
  "source url": "sourceUrl",
  url: "sourceUrl",
  "application url": "applicationUrl",
  "date posted": "postedAt",
  description: "rawDescription",
  notes: "notes",
  "company website": "companyWebsite",
  "official career url": "officialCareerUrl",
  "external id": "externalId",
};

const ENUM_FIELDS = new Set(["employmentType", "workMode", "sourceType"]);

export function importCsv(deps: Deps, csv: string, sourceName: string, evaluate: boolean, actor = "import"): ImportResult {
  const rows = csvToObjects(csv);
  if (!rows.length) throw unprocessable("The CSV has no data rows.");
  const result: ImportResult = { created: 0, duplicates: 0, items: [], errors: [] };
  rows.forEach((row, i) => {
    const mapped: Record<string, unknown> = { sourceName, evaluate };
    for (const [key, value] of Object.entries(row)) {
      const field = CSV_ALIASES[key.toLowerCase()] ?? (key in ManualOpportunityInputSchema.shape ? key : null);
      if (!field || value === "") continue;
      mapped[field] = ENUM_FIELDS.has(field) ? value.toUpperCase().replace(/[\s-]+/g, "_") : value;
    }
    if (mapped.sourceType && !["OFFICIAL_ATS", "JOB_BOARD", "MANUAL_URL", "RSS", "REFERRAL"].includes(String(mapped.sourceType))) delete mapped.sourceType;
    const parsed = ManualOpportunityInputSchema.safeParse(mapped);
    if (!parsed.success) {
      result.errors.push(`Row ${i + 2}: ${parsed.error.issues.map((x) => `${x.path.join(".")} ${x.message}`).join("; ")}`);
      return;
    }
    const r = createOpportunity(deps, parsed.data, actor);
    if (r.duplicate) result.duplicates++;
    else result.created++;
    result.items.push({ id: r.opportunity.id, duplicate: r.duplicate, title: r.opportunity.title });
  });
  return result;
}
