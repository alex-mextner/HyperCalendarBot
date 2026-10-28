// The coverage harness writes per-case results that stay private. Its output directory must be the
// repository's ignored `logs/` tree or a path outside the repository; anything else is refused so a
// run can never drop private results into tracked directories such as docs/ or test/.
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export function assertPrivateOutputDir(dir: string, repoRoot: string): string {
  const target = resolve(dir);
  const root = resolve(repoRoot);
  const inside = relative(root, target);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return target;
  if (inside === 'logs' || inside.startsWith(`logs${sep}`)) return target;
  throw new Error(
    `Refusing output directory ${target}: private results go under ${join(root, 'logs')} or outside ${root}`,
  );
}
