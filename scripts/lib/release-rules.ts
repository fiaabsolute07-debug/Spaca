export type SourceFile = { path: string; content: string };
export type ReleaseCheck = { name: string; status: 'PASS' | 'FAIL'; findings: string[] };
export type ReleaseGate = { gate: string; status: 'NOT_RUN' | 'BLOCKED' };
const result = (name: string, findings: string[]): ReleaseCheck => ({ name, status: findings.length ? 'FAIL' : 'PASS', findings });
const normalizePath = (path: string) => path.replaceAll('\\', '/').replace(/^\.\//, '');

/** Strip SQL comments without interpreting comment markers inside quoted strings. */
function sqlCode(source: string): string {
  return source.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\//g,
    (token) => token.startsWith('--') || token.startsWith('/*') ? ' ' : token).replace(/"([a-z_][a-z0-9_]*)"/gi, '$1');
}

function closingParen(source: string, start: number): number {
  let depth = 0;
  let quote = false;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (char === "'") {
      if (quote && source[i + 1] === "'") { i++; continue; }
      quote = !quote;
    }
    if (!quote && char === '(') depth++;
    if (!quote && char === ')' && --depth === 0) return i;
  }
  return -1;
}

function commaParts(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '(') { const end = closingParen(source, i); if (end < 0) return []; i = end; }
    if (source[i] === "'") { for (i++; i < source.length; i++) { if (source[i] === "'") { if (source[i + 1] === "'") i++; else break; } } }
    if (source[i] === ',') { parts.push(source.slice(start, i)); start = i + 1; }
  }
  return [...parts, source.slice(start)];
}

/** Conservative static migration lint, not execution or a general PostgreSQL parser. */
export function checkFeeConstraints(migrations: readonly SourceFile[]): ReleaseCheck {
  const findings: string[] = [];
  const fees = ['platform_fee_minor', 'platform_fee_bps'];
  const seen = new Set<string>();
  const protectedTables = new Set<string>();
  const protectedConstraints = new Set<string>();
  const ordered = [...migrations].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of ordered) {
    const source = sqlCode(file.content).toLowerCase();
    const definitions: { table: string; body: string }[] = [];
    for (const match of source.matchAll(/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([\w.]+)\s*\(/g)) {
      const start = match.index! + match[0].length - 1;
      const end = closingParen(source, start);
      if (end < 0) { findings.push(`${file.path}: unparseable table definition`); continue; }
      definitions.push({ table: match[1]!, body: source.slice(start + 1, end) });
    }
    for (const match of source.matchAll(/\balter\s+table\s+(?:only\s+)?([\w.]+)\s+([^;]+)/g)) {
      for (const part of commaParts(match[2]!)) {
        const add = part.trim().match(/^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?(platform_fee_(?:minor|bps))\b([\s\S]*)/);
        if (add) definitions.push({ table: match[1]!, body: `${add[1]}${add[2]}` });
      }
    }
    for (const { table, body } of definitions) {
      const fields = commaParts(body);
      for (const fee of fees) {
        const field = fields.find((part) => new RegExp(`^\\s*${fee}\\s`).test(part));
        if (!field) continue;
        protectedTables.add(table);
        const checks = [...body.matchAll(/\bcheck\s*\(/g)].map((match) => {
          const start = match.index! + match[0].length - 1;
          const end = closingParen(body, start);
          return { expression: body.slice(start + 1, end).replace(/[()\s]/g, ''), index: match.index! };
        });
        const zero = checks.filter((check) => check.expression === `${fee}=0` || check.expression === `0=${fee}`);
        if (!zero.length || !/\bnot\s+null\b/.test(field)) {
          findings.push(`${file.path}: ${table}.${fee} requires NOT NULL and an exact zero CHECK`);
        } else {
          seen.add(fee);
          for (const check of zero) {
            const prefix = body.slice(0, check.index);
            const name = prefix.match(/\bconstraint\s+(\w+)\s*$/)?.[1] ?? `${table.split('.').at(-1)}_${fee}_check`;
            protectedConstraints.add(name);
          }
        }
      }
    }
    // Also reject unsafe CHECKs added later, even if another zero constraint still exists.
    for (const match of source.matchAll(/\bcheck\s*\(/g)) {
      const start = match.index! + match[0].length - 1;
      const expression = source.slice(start + 1, closingParen(source, start)).replace(/[()\s]/g, '');
      for (const fee of fees) {
        if (expression.includes(fee) && expression !== `${fee}=0` && expression !== `0=${fee}`) {
          findings.push(`${file.path}: nonzero or weakened platform fee CHECK`);
        }
      }
    }
    for (const statement of source.split(';')) {
      if (/\bdrop\s+schema\b/.test(statement)) findings.push(`${file.path}: schema removal needs manual review`);
      if (/\bdrop\s+table\b/.test(statement) && [...protectedTables].some((table) => new RegExp(`\\b${table.replace('.', '\\.')}\\b`).test(statement))) {
        findings.push(`${file.path}: protected fee table removed`);
      }
      if (/\balter\s+table\b/.test(statement)) {
        if (/\b(?:drop|alter|rename)\s+(?:column\s+)?(?:if\s+exists\s+)?platform_fee_(?:minor|bps)\b/.test(statement)) {
          findings.push(`${file.path}: platform fee column altered or removed`);
        }
        for (const match of statement.matchAll(/\b(?:drop|rename|alter)\s+constraint\s+(?:if\s+exists\s+)?(\w+)/g)) {
          if (protectedConstraints.has(match[1]!) || /platform_fee/.test(match[1]!)) findings.push(`${file.path}: platform fee constraint altered or removed`);
        }
      }
    }
  }
  for (const fee of fees) if (!seen.has(fee)) findings.push(`migration chain: missing ${fee} zero CHECK`);
  return result('platform fee remains zero in every migration', [...new Set(findings)]);
}

/** Blank out comments while keeping string/template contents and line numbers (TypeScript 7 ships no JS compiler API). */
function stripComments(source: string): string {
  return source.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (token) => (token.startsWith('//') || token.startsWith('/*') ? token.replace(/[^\n]/g, ' ') : token));
}
const lineOf = (source: string, index: number) => source.slice(0, index).split('\n').length;
/** Replace string/template contents with spaces so code-level patterns never match SQL text. */
function blankStrings(source: string): string {
  return source.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g,
    (token) => token[0] + token.slice(1, -1).replace(/[^\n]/g, ' ') + token.at(-1));
}

export function checkClientFunding(files: readonly SourceFile[]): ReleaseCheck {
  const findings: string[] = [];
  for (const file of files) {
    const path = normalizePath(file.path);
    if (!path.startsWith('src/') || path === 'src/modules/payments/funding.ts') continue;
    const source = stripComments(file.content);
    const lines = new Set<number>();
    for (const match of source.matchAll(/\bmarkPaid\b/g)) lines.add(lineOf(source, match.index!));
    // Object-literal or assignment writes of funded/succeeded payment state in TypeScript code (not SQL text).
    const code = blankStrings(source);
    for (const match of code.matchAll(/\b(payment_status|status)\s*(?::|=(?!=))\s*['"`]/g)) {
      const literal = source.slice(match.index! + match[0].length - 1).match(/^['"`]([A-Z_]*)['"`]/)?.[1];
      if ((match[1] === 'payment_status' && literal === 'SUCCEEDED') || (match[1] === 'status' && literal === 'FUNDED')) lines.add(lineOf(source, match.index!));
    }
    // SQL SET clauses inside template literals (WHERE predicates and CASE comparisons are not writes).
    for (const match of source.matchAll(/\b(?:update\b[\s\S]*?\bset|do\s+update\s+set)\s+([\s\S]*?)(?:\bwhere\b|\breturning\b|`|;)/gi)) {
      const assignments = commaParts(match[1]!);
      if (assignments.some((assignment) => /^\s*(?:\w+\.)?(?:payment_status\s*=\s*'SUCCEEDED'|status\s*=\s*'FUNDED')/i.test(assignment))) {
        lines.add(lineOf(source, match.index!));
      }
    }
    for (const match of source.matchAll(/\binsert\s+into\s+[\w.]+\s*\(([^)]+)\)\s*values\s*\(([^)]+)\)/gi)) {
      const columns = commaParts(match[1]!);
      const values = commaParts(match[2]!);
      if (columns.some((column, i) => (column.trim() === 'payment_status' && values[i]?.trim() === "'SUCCEEDED'") ||
        (column.trim() === 'status' && values[i]?.trim() === "'FUNDED'"))) lines.add(lineOf(source, match.index!));
    }
    for (const line of [...lines].sort((a, b) => a - b)) findings.push(`${path}:${line}: direct funding mutation or markPaid`);
  }
  return result('no client markPaid or direct funding writes outside funding.ts', findings);
}

/** Body text of `export async function METHOD(...) { ... }` handlers, brace-matched outside strings/comments. */
function handlerBodies(source: string): { method: string; body: string }[] {
  const bodies: { method: string; body: string }[] = [];
  for (const match of source.matchAll(/\bexport\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\([^)]*\)\s*(?::[^{]+)?\{/g)) {
    let depth = 0;
    const open = match.index! + match[0].length - 1;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++;
      if (source[i] === '}' && --depth === 0) { bodies.push({ method: match[1]!, body: source.slice(open + 1, i) }); break; }
    }
  }
  return bodies;
}

export function checkDevRouteGuards(files: readonly SourceFile[]): ReleaseCheck {
  const findings: string[] = [];
  for (const file of files.filter((candidate) => /^src\/app\/api\/dev\/.*\/route\.[cm]?[jt]s$/.test(normalizePath(candidate.path)))) {
    const source = stripComments(file.content);
    if (/\bexport\s+(?:const|let|var)\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|\bexport\s*\{/.test(source)) {
      findings.push(`${file.path}: non-function or re-exported route requires guard review`);
    }
    const bodies = handlerBodies(source);
    if (!bodies.length) findings.push(`${file.path}: no inspectable HTTP handler`);
    for (const { method, body } of bodies) {
      // The first executable statement (after optional `const url = new URL(request.url)`) must be a rejecting guard.
      const trimmed = body.replace(/^\s*(?:const\s+\w+\s*=\s*new\s+URL\([^;]*\);\s*)*/, '');
      const guard = trimmed.match(/^if\s*\(([\s\S]*?)\)\s*\{?\s*return\s+NextResponse\.json\([^;]*status:\s*(\d{3})/);
      const deniesProduction = !!guard && (/process\.env\.(?:NODE_ENV|APP_ENV)\s*===\s*'production'/.test(guard[1]!) || /!\s*mockPaymentsEnabled\(\)/.test(guard[1]!));
      if (!guard || !deniesProduction || !['403', '404'].includes(guard[2]!)) {
        findings.push(`${file.path}: ${method} handler missing an early production/mock rejection guard`);
      }
    }
  }
  return result('dev routes reject production/non-mock requests', findings);
}

export function checkExampleSecrets(content: string): ReleaseCheck {
  const findings: string[] = [];
  content.split(/\r?\n/).forEach((line, index) => {
    const tokens = line.match(/\b(?:sk_|whsec_)[A-Za-z0-9_-]+/g) ?? [];
    if (tokens.some((token) => token !== 'whsec_local_dev_only_fixture') ||
      /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\bsb_secret_[A-Za-z0-9_-]+|\bre_[A-Za-z0-9]{20,}/.test(line)) {
      findings.push(`.env.example:${index + 1}: secret-looking value`);
    }
  });
  return result('.env.example contains no secret-looking values', findings);
}

/** Only the status column of gate rows counts; narrative NOT_RUN mentions do not change a gate. */
export function parseReleaseGates(markdown: string): ReleaseGate[] {
  const gates: ReleaseGate[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.replace(/[*`]/g, '').trim());
    const gate = cells[0]?.match(/^(G\d+)\b/)?.[1];
    const status = cells[2];
    if (gate && (status === 'NOT_RUN' || status === 'BLOCKED')) gates.push({ gate, status });
  }
  return gates;
}

export function formatReleaseReport(checks: readonly ReleaseCheck[], gates: readonly ReleaseGate[]): string {
  return [...checks.flatMap((check) => [`${check.status} | ${check.name}`, ...check.findings.map((finding) => `  ${finding}`)]),
    'INFO | checklist gates (informational; static PASS does not establish release readiness)',
    ...gates.map((gate) => `${gate.status} | ${gate.gate}`)].join('\n');
}

/**
 * P4-10 / CRY-14: mainnet crypto stays blocked. Migrations must keep the CHECK that refuses an enabled MAINNET network,
 * no migration may enable one, and production must refuse the per-process release signer.
 */
export function checkMainnetCryptoBlocked(migrations: readonly SourceFile[], sources: readonly SourceFile[]): ReleaseCheck {
  const findings: string[] = [];
  const sql = migrations.map((file) => stripComments(file.content)).join('\n');
  if (!/chain_networks_mainnet_blocked\s+CHECK\s*\(\s*mode\s*<>\s*'MAINNET'\s+OR\s+NOT\s+enabled\s*\)/i.test(sql)) findings.push('drizzle: chain_networks_mainnet_blocked CHECK is missing');
  if (/DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?chain_networks_mainnet_blocked/i.test(sql)) findings.push('drizzle: a migration drops chain_networks_mainnet_blocked');
  for (const file of migrations) {
    const statements = stripComments(file.content).split(';');
    if (statements.some((statement) => /(?:insert\s+into|update)\s+app\.chain_networks/i.test(statement) && /'MAINNET'/i.test(statement) && /\btrue\b/i.test(statement))) {
      findings.push(`${file.path}: migration writes an enabled MAINNET network`);
    }
  }
  const signer = sources.find((file) => normalizePath(file.path) === 'src/modules/crypto/authorization.ts');
  if (!signer || !/process\.env\.NODE_ENV\s*===\s*'production'\)\s*throw/.test(signer.content)) findings.push('src/modules/crypto/authorization.ts: production must refuse the local release signer');
  return result('mainnet crypto blocked (no enabled MAINNET, no local signer in production)', findings);
}

