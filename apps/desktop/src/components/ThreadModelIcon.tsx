import { Sparkle } from "lucide-react";
import {
  ProviderGlyph,
  glyphSlugFor,
} from "@/components/settings/providerIcons";
import type { ModelRef } from "@/lib/types";

// Leading icon for a thread row: the thread model's provider glyph so rows are
// distinguishable at a glance instead of all sharing the same star (HOY-267).
// Falls back to the neutral Sparkle for session-less/new threads with no chosen
// model (or a provider with no mapped glyph). The caller owns size/color via
// className; both the glyph and the fallback render in currentColor.
export function ThreadModelIcon({
  model,
  className,
}: {
  model?: ModelRef | null;
  className?: string;
}) {
  const slug = model ? glyphSlugFor(model.provider) : undefined;
  if (slug) return <ProviderGlyph slug={slug} className={className} />;
  return <Sparkle className={className} />;
}
