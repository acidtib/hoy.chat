import type { MetadataRoute } from "next";
import { PRODUCTION_URL } from "@/lib/site";

// Generated as a static sitemap.xml at build time (output: export). URLs use the
// production apex so the sitemap is valid no matter which deploy renders it.
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${PRODUCTION_URL}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${PRODUCTION_URL}/changelog`, changeFrequency: "weekly", priority: 0.6 },
    { url: `${PRODUCTION_URL}/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${PRODUCTION_URL}/terms`, changeFrequency: "yearly", priority: 0.3 },
  ];
}
