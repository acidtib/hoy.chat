import Link from "next/link";
import { REPO_URL } from "@/lib/site";

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="wrap">
        <Link href="/" className="wordmark">
          <span className="dot" aria-hidden="true" />
          Hoy
        </Link>
        <nav className="nav">
          <Link href="/changelog">Changelog</Link>
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>
      </div>
    </header>
  );
}
