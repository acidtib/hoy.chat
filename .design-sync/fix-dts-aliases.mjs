// Rewrites `@/...` path-alias imports in the generated dist/types/**/*.d.ts
// tree to relative paths. tsc's declaration emitter preserves import
// specifiers as written in source — it does not resolve tsconfig `paths`.
// design-sync's own ts-morph prop-extraction project has no baseUrl/paths
// config either, so an unrewritten `@/components/ui/dialog` import resolves
// to nothing there, silently collapsing that component's emitted props to
// `[key: string]: unknown`. Run after `tsc -p .design-sync/dts.tsconfig.json`,
// before `package-build.mjs`.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const root = resolve('dist/types');

function walk(dir, acc) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (f.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

const files = walk(root, []);
let changed = 0;
for (const file of files) {
  const content = readFileSync(file, 'utf8');
  const dir = dirname(file);
  const next = content.replace(/from (["'])@\/([^"']+)\1/g, (_m, q, sub) => {
    const target = join(root, sub);
    let rel = relative(dir, target).split(sep).join('/');
    if (!rel.startsWith('.')) rel = './' + rel;
    return `from ${q}${rel}${q}`;
  });
  if (next !== content) {
    writeFileSync(file, next);
    changed++;
  }
}
console.error(`[fix-dts-aliases] rewrote ${changed} of ${files.length} files`);

// Regenerate the dist/types/index.d.ts barrel from whatever component
// declarations exist under components/ — the entry pj.types points to.
// Without a barrel re-export, design-sync's prop-extraction fallback (for
// components with no named <Name>Props export) can't see a component's
// call signature. Keeps pace with componentSrcMap automatically: add/remove
// a .tsx under src/components/{ui,ai-elements}, rerun buildCmd, done.
const componentFiles = walk(join(root, 'components'), [])
  .map((f) => './' + relative(root, f).replace(/\.d\.ts$/, '').split(sep).join('/'))
  .sort();
writeFileSync(
  join(root, 'index.d.ts'),
  componentFiles.map((p) => `export * from "${p}";`).join('\n') + '\n',
);
console.error(`[fix-dts-aliases] regenerated index.d.ts barrel (${componentFiles.length} modules)`);
