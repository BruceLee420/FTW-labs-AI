import { z } from "zod";
import { ShortText, StringList } from "./enums.ts";

export const ResumePatchSchema = z
  .object({
    label: ShortText.min(1),
    targetRoles: StringList,
    skills: StringList,
    industries: StringList,
    isActive: z.boolean(),
  })
  .partial()
  .strict();
export type ResumePatch = z.infer<typeof ResumePatchSchema>;

export const IndexResumesInputSchema = z.object({
  /** Re-parse even when the content hash is unchanged. */
  force: z.boolean().default(false),
});
