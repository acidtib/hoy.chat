import type { MetadataRoute } from "next";
import { IS_PRODUCTION, PRODUCTION_URL } from "@/lib/site";

// Generated as a static robots.txt at build time (output: export). The beta and
// any preview origin disallow everything so only the production apex is crawled;
// the apex allows all and advertises the sitemap.
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  if (!IS_PRODUCTION) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${PRODUCTION_URL}/sitemap.xml`,
    host: PRODUCTION_URL,
  };
}
