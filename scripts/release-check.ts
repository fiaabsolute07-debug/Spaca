import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { checkClientFunding, checkDevRouteGuards, checkExampleSecrets, checkFeeConstraints,
  formatReleaseReport, parseReleaseGates, type SourceFile } from './lib/release-rules';

const root = fileURLToPath(new URL('../', import.meta.url));
async function read(path: string): Promise<SourceFile> {
  return { path, content: await readFile(resolve(root, path), 'utf8') };
}
async function sourceFiles(directory: string): Promise<SourceFile[]> {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  const files = await Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async (entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error('Source symlink requires review');
    return entry.isDirectory() ? sourceFiles(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [await read(path)] : [];
  }));
  return files.flat();
}

try {
  const [migrations, sources, example, checklist] = await Promise.all([
    readdir(resolve(root, 'drizzle')).then((names) => Promise.all(names.filter((name) => name.endsWith('.sql')).sort().map((name) => read(`drizzle/${name}`)))),
    sourceFiles('src'), read('.env.example'), read('docs/RELEASE_CHECKLIST.md'),
  ]);
  const checks = [checkFeeConstraints(migrations), checkClientFunding(sources), checkDevRouteGuards(sources), checkExampleSecrets(example.content)];
  console.log(formatReleaseReport(checks, parseReleaseGates(checklist.content)));
  process.exitCode = checks.some((check) => check.status === 'FAIL') ? 1 : 0;
} catch {
  // Error objects can contain paths, input snippets or credentials. Do not echo them.
  console.error('FAIL | unable to read or inspect required release inputs');
  process.exitCode = 1;
}
