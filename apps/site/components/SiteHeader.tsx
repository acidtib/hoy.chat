import Link from "next/link";
import { REPO_URL } from "@/lib/site";

export function SiteHeader({ version }: { version: string }) {
  return (
    <header className="site-header">
      <div className="wrap">
        <div className="header-brand">
          <Link href="/" className="wordmark">
            <span className="mark" aria-hidden="true" />
            Hoy Chat
          </Link>
          <Link className="header-version" href={`/changelog#${version}`}>
            v{version}
          </Link>
        </div>
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
