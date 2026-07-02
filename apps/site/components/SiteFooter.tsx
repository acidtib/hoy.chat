import Link from "next/link";
import { REPO_URL, LICENSE } from "@/lib/site";

export function SiteFooter({ version }: { version: string }) {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <span className="footer-brand">
          <span className="mark mark-sm" aria-hidden="true" />
          Hoy v{version} &middot; {LICENSE} License
        </span>
        <div className="footer-links">
          <Link href="/changelog">Changelog</Link>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href={`${REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
            License
          </a>
        </div>
      </div>
    </footer>
  );
}
