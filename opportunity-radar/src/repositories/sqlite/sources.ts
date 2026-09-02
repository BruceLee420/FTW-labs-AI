/**
 * SQLite OpportunitySourceRepository — one row per sighting of a listing.
 * Why: dedupe keeps a single opportunity but records every source it was seen
 * at, so the UI can show provenance and the sync can skip known listings.
 */
import type { Db } from "../../db/client.ts";
import type { OpportunitySource } from "../../types/entities.ts";
import type { OpportunitySourceRepository } from "../interfaces.ts";
import { defineColumns, insertEntity, selectMany, selectOne, type TableSpec } from "./rows.ts";

const c = defineColumns<OpportunitySource>();

export const OPPORTUNITY_SOURCES: TableSpec<OpportunitySource> = {
  name: "opportunity_sources",
  columns: [
    c.text("id"), c.text("opportunityId"), c.text("sourceName"), c.text("sourceType"), c.text("sourceUrl"),
    c.text("externalId"), c.text("seenAt"), c.text("descriptionHash"),
  ],
};

export function createSourceRepository(db: Db): OpportunitySourceRepository {
  return {
    insert(source) {
      insertEntity(db, OPPORTUNITY_SOURCES, source);
      return selectOne(db, OPPORTUNITY_SOURCES, "WHERE id = ?", [source.id]) ?? source;
    },
    listByOpportunity(opportunityId) {
      return selectMany(db, OPPORTUNITY_SOURCES, "WHERE opportunity_id = ? ORDER BY seen_at DESC, id ASC", [
        opportunityId,
      ]);
    },
  };
}
