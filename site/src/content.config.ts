import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { z } from "astro/zod";

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    // `landing` marks the home pages, whose hero is the site's own (src/components/landing/Hero.astro).
    schema: docsSchema({ extend: z.object({ landing: z.boolean().default(false) }) }),
  }),
};
