/** UI pages and static assets served from public/. */
import type { AppDeps } from "../../deps.ts";
import type { Router } from "../router.ts";
import { redirect } from "../respond.ts";
import { publicDirFrom, serveStatic } from "../static.ts";
import { notFound } from "../../utils/errors.ts";

export function registerPageRoutes(router: Router, deps: AppDeps): void {
  const publicDir = publicDirFrom(deps.config.baseDir);
  const page = (file: string) => async () => (await serveStatic(publicDir, file)) ?? (() => { throw notFound("Page not found."); })();

  // The router ignores trailing slashes, so "/opportunity-radar" and "/opportunity-radar/" are one route.
  router.get("/", () => redirect("/opportunity-radar/"));
  router.get("/opportunity-radar/", page("index.html"));
  router.get("/opportunity-radar/index.html", page("index.html"));
  router.get("/opportunity-radar/resumes", page("resumes.html"));
  router.get("/opportunity-radar/settings", page("settings.html"));
  router.get("/opportunity-radar/public/:file", async (ctx) => {
    const served = await serveStatic(publicDir, ctx.params.file ?? "");
    if (!served) throw notFound("Asset not found.");
    return served;
  });
}
