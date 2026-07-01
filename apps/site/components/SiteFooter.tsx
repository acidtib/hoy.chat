import Link from "next/link";
import { REPO_URL, LICENSE } from "@/lib/site";

export function SiteFooter({ version }: { version: string }) {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <span>
          Hoy v{version} &middot; {LICENSE} License
        </span>
        <div className="footer-links">
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <a href={`${REPO_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
            License
          </a>
          <Link href="/changelog">Changelog</Link>
        </div>
      </div>
    </footer>
  );
}
