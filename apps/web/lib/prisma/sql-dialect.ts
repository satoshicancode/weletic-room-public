/**
 * SQLite / Cloudflare D1 dialect shims for raw SQL that was originally written
 * for MySQL (the project descends from Dub, which targets MySQL).
 *
 * Applied centrally through a Prisma client extension (see `./index.ts`) so
 * that upstream-style raw queries keep working without touching 100+ call sites:
 *
 *  - `FOR UPDATE [SKIP LOCKED | NOWAIT]` is removed. SQLite has no row locks;
 *    the native engine serializes writers (`BEGIN IMMEDIATE`) and D1 runs
 *    statements individually. Money flows must therefore not rely on row locks
 *    (use idempotency keys, append-only rows and optimistic version checks).
 *  - `CURRENT_TIMESTAMP`, `CURRENT_TIMESTAMP(n)` and `NOW()` become a bound
 *    `Date` parameter. Prisma serializes a `Date` parameter in the same format
 *    it uses to store `DateTime` columns on that engine (INTEGER ms on the
 *    native engine, ISO-8601 on the D1 adapter), so comparisons against
 *    Prisma-written columns are consistent. SQLite's own `CURRENT_TIMESTAMP`
 *    ('YYYY-MM-DD HH:MM:SS') is never comparable with either format.
 *  - `SELECT CURRENT_TIMESTAMP(3) AS now` is answered in-process (no round trip).
 *
 * DDL (CREATE/ALTER/DROP/PRAGMA) is never rewritten: `DEFAULT CURRENT_TIMESTAMP`
 * is valid SQLite.
 */
import { Prisma } from "@prisma/client";

const FOR_UPDATE_RE = /\s+FOR\s+UPDATE(?:\s+(?:SKIP\s+LOCKED|NOWAIT))?/gi;
const CLOCK_RE =
  /\bCURRENT_TIMESTAMP(?:\s*\(\s*\d*\s*\))?|\bNOW\s*\(\s*\)|__CLOCK_OFFSET_(MINUS|PLUS)_(\d+)__/gi;
const DDL_RE = /^\s*(?:CREATE|ALTER|DROP|PRAGMA)\b/i;
const MYSQL_CONSTRUCTS_RE =
  /\b(?:FOR\s+UPDATE|CURRENT_TIMESTAMP|NOW\s*\(|DATE_FORMAT|DATE_SUB|TIMESTAMPADD|CONVERT_TZ|__CLOCK_OFFSET_)\b/i;

// Stateless (non-global) variants for detection: global regexes keep
// `lastIndex` between `.test()` calls.
const HAS_FOR_UPDATE_RE = new RegExp(FOR_UPDATE_RE.source, "i");
const HAS_CLOCK_RE = new RegExp(CLOCK_RE.source, "i");
const HAS_MYSQL_RE = new RegExp(MYSQL_CONSTRUCTS_RE.source, "i");
const CLOCK_ONLY_RE =
  /^\s*SELECT\s+(?:CURRENT_TIMESTAMP(?:\s*\(\s*\d*\s*\))?|NOW\s*\(\s*\))\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)\s*;?\s*$/i;

export function isDdl(sql: string): boolean {
  return DDL_RE.test(sql);
}

/** Alias of a `SELECT CURRENT_TIMESTAMP(3) AS <alias>` statement, else null. */
export function matchClockOnlyQuery(sql: string): string | null {
  return CLOCK_ONLY_RE.exec(sql)?.[1] ?? null;
}

export function stripForUpdate(sql: string): string {
  return sql.replace(FOR_UPDATE_RE, "");
}

/**
 * Rewrites MySQL date/time manipulation functions into SQLite equivalents.
 */
export function rewriteConstructs(text: string): string {
  let res = text;

  // 1. DATE_SUB with CURRENT_TIMESTAMP / NOW() and INTERVAL
  res = res.replace(
    /DATE_SUB\s*\(\s*(?:CURRENT_TIMESTAMP(?:\s*\(\s*\d*\s*\))?|NOW\s*\(\s*\))\s*,\s*INTERVAL\s+(\d+)\s+([A-Za-z]+)\s*\)/gi,
    (_m, num, unit) => {
      const n = parseInt(num, 10);
      const u = unit.toUpperCase();
      let ms = 0;
      if (u === "SECOND") ms = n * 1000;
      else if (u === "MINUTE") ms = n * 60_000;
      else if (u === "HOUR") ms = n * 3_600_000;
      else if (u === "DAY") ms = n * 86_400_000;
      return `__CLOCK_OFFSET_MINUS_${ms}__`;
    },
  );

  // 2. TIMESTAMPADD with literal number interval and CURRENT_TIMESTAMP / NOW()
  res = res.replace(
    /TIMESTAMPADD\s*\(\s*(SECOND|MICROSECOND|MINUTE|HOUR|DAY)\s*,\s*(-?\d+)\s*,\s*(?:CURRENT_TIMESTAMP(?:\s*\(\s*\d*\s*\))?|NOW\s*\(\s*\))\s*\)/gi,
    (_m, unit, num) => {
      const n = parseInt(num, 10);
      const u = unit.toUpperCase();
      let ms = 0;
      if (u === "SECOND") ms = n * 1000;
      else if (u === "MICROSECOND") ms = Math.round(n / 1000);
      else if (u === "MINUTE") ms = n * 60_000;
      else if (u === "HOUR") ms = n * 3_600_000;
      else if (u === "DAY") ms = n * 86_400_000;
      if (ms < 0) {
        return `__CLOCK_OFFSET_MINUS_${Math.abs(ms)}__`;
      }
      return `__CLOCK_OFFSET_PLUS_${ms}__`;
    },
  );

  // 3. DATE_FORMAT(CONVERT_TZ(col, tz1, tz2), fmt)
  res = res.replace(
    /DATE_FORMAT\s*\(\s*CONVERT_TZ\s*\(\s*([^,]+?)\s*,\s*(?:'[^']+'|"[^"]+"|\?)\s*,\s*(\?|'[^']+'|"[^"]+")\s*\)\s*,\s*(\?|'[^']+'|"[^"]+")\s*\)/gi,
    (_m, col, tz, fmt) => {
      if (tz === "?" && fmt === "?") {
        return `CASE WHEN ? IS NOT NULL THEN strftime(?, CASE WHEN typeof(${col}) = 'integer' THEN datetime(${col} / 1000, 'unixepoch') ELSE ${col} END) ELSE '' END`;
      }
      return `strftime(${fmt}, CASE WHEN typeof(${col}) = 'integer' THEN datetime(${col} / 1000, 'unixepoch') ELSE ${col} END)`;
    },
  );

  // 4. DATE_FORMAT(col, fmt)
  res = res.replace(
    /DATE_FORMAT\s*\(\s*([^,]+?)\s*,\s*(\?|'[^']+'|"[^"]+")\s*\)/gi,
    "strftime($2, CASE WHEN typeof($1) = 'integer' THEN datetime($1 / 1000, 'unixepoch') ELSE $1 END)",
  );

  return res;
}

interface ClockPiece {
  text: string;
  clock: boolean;
  dateValue?: Date;
}

/**
 * Splits `text` into [literalOrCode, isClock] pieces, never matching inside
 * single-quoted string literals.
 */
function splitClock(text: string, now: Date): ClockPiece[] {
  const out: ClockPiece[] = [];
  let buf = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'") {
      // copy the whole literal ('' is an escaped quote)
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "'" && text[j + 1] === "'") j += 2;
        else if (text[j] === "'") break;
        else j++;
      }
      buf += text.slice(i, Math.min(j + 1, text.length));
      i = j + 1;
      continue;
    }
    CLOCK_RE.lastIndex = i;
    const m = CLOCK_RE.exec(text);
    if (m && m.index === i) {
      out.push({ text: buf, clock: false });
      if (m[1] && m[2]) {
        const sign = m[1] === "MINUS" ? -1 : 1;
        const offset = parseInt(m[2], 10);
        out.push({
          text: m[0],
          clock: true,
          dateValue: new Date(now.getTime() + sign * offset),
        });
      } else {
        out.push({ text: m[0], clock: true, dateValue: now });
      }
      buf = "";
      i += m[0].length;
      continue;
    }
    buf += ch;
    i++;
  }
  out.push({ text: buf, clock: false });
  return out;
}

/** Rewrites a `Prisma.Sql` (tagged-template) statement. */
export function rewriteSql(sql: Prisma.Sql, now: Date = new Date()): Prisma.Sql {
  const strings = [...sql.strings];
  const values = [...sql.values];
  if (isDdl(strings[0] ?? "")) return sql;

  const joined = strings.join("?");
  if (!HAS_MYSQL_RE.test(joined)) {
    return sql;
  }

  // Pre-process cross-boundary constructs between template parameters
  for (let i = 0; i < strings.length - 1; i++) {
    // Cross-boundary: TIMESTAMPADD(MICROSECOND, ${delta}, CURRENT_TIMESTAMP(3))
    if (
      /TIMESTAMPADD\s*\(\s*MICROSECOND\s*,\s*$/i.test(strings[i]) &&
      /^\s*,\s*(?:CURRENT_TIMESTAMP(?:\s*\(\s*\d*\s*\))?|NOW\s*\(\s*\))\s*\)/i.test(
        strings[i + 1],
      )
    ) {
      strings[i] = strings[i].replace(
        /TIMESTAMPADD\s*\(\s*MICROSECOND\s*,\s*$/i,
        `(${now.getTime()} + round(`,
      );
      strings[i + 1] = strings[i + 1].replace(
        /^\s*,\s*(?:CURRENT_TIMESTAMP(?:\s*\(\s*\d*\s*\))?|NOW\s*\(\s*\))\s*\)/i,
        " / 1000))",
      );
    }
    // Cross-boundary: DATE_FORMAT(CONVERT_TZ(col, "UTC", ${tz}), ${fmt})
    const convertTzMatch = strings[i].match(
      /DATE_FORMAT\s*\(\s*CONVERT_TZ\s*\(\s*([^,]+?)\s*,\s*(?:'[^']+'|"[^"]+")\s*,\s*$/i,
    );
    if (
      convertTzMatch &&
      i + 2 < strings.length &&
      /^\s*\)\s*,\s*$/i.test(strings[i + 1])
    ) {
      const col = convertTzMatch[1];
      strings[i] = strings[i].replace(
        /DATE_FORMAT\s*\(\s*CONVERT_TZ\s*\(\s*([^,]+?)\s*,\s*(?:'[^']+'|"[^"]+")\s*,\s*$/i,
        "CASE WHEN ",
      );
      strings[i + 1] = " IS NOT NULL THEN strftime(";
      strings[i + 2] = strings[i + 2].replace(
        /^\s*\)/,
        `, CASE WHEN typeof(${col}) = 'integer' THEN datetime(${col} / 1000, 'unixepoch') ELSE ${col} END) ELSE '' END`,
      );
    }
  }

  const newStrings: string[] = [];
  const newValues: unknown[] = [];
  let current = "";

  for (let i = 0; i < strings.length; i++) {
    const fragment = rewriteConstructs(stripForUpdate(strings[i]));
    for (const piece of splitClock(fragment, now)) {
      if (piece.clock) {
        newStrings.push(current);
        newValues.push(piece.dateValue ?? now);
        current = "";
      } else {
        current += piece.text;
      }
    }
    if (i < values.length) {
      newStrings.push(current);
      newValues.push(values[i]);
      current = "";
    }
  }
  newStrings.push(current);

  return Prisma.sql(newStrings as unknown as TemplateStringsArray, ...newValues);
}

/** Rewrites an `$queryRawUnsafe` / `$executeRawUnsafe` argument list. */
export function rewriteUnsafe(
  args: unknown[],
  now: Date = new Date(),
): unknown[] {
  const [query, ...params] = args;
  if (typeof query !== "string" || isDdl(query)) return args;

  const stripped = rewriteConstructs(stripForUpdate(query));
  const pieces = splitClock(stripped, now);
  if (stripped === query && !pieces.some((p) => p.clock)) return args;

  // Re-assemble, walking `?` placeholders (outside literals) so that inserted
  // clock parameters line up with the caller's positional values.
  let text = "";
  const values: unknown[] = [];
  let next = 0;
  for (const piece of pieces) {
    if (piece.clock) {
      text += "?";
      values.push(piece.dateValue ?? now);
      continue;
    }
    let inLiteral = false;
    for (let i = 0; i < piece.text.length; i++) {
      const ch = piece.text[i];
      if (ch === "'") inLiteral = !inLiteral;
      if (ch === "?" && !inLiteral) values.push(params[next++]);
    }
    text += piece.text;
  }
  // Any trailing, unconsumed caller params are preserved (driver will complain
  // exactly as it would have without the rewrite).
  while (next < params.length) values.push(params[next++]);

  return [text, ...values];
}
