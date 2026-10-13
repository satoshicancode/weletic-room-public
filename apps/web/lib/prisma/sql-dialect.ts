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
  /\b(?:CURRENT_TIMESTAMP|UTC_TIMESTAMP)(?:\s*\(\s*\d*\s*\))?|\bNOW\s*\(\s*\d*\s*\)|__CLOCK_OFFSET_(MINUS|PLUS)_(\d+)__/gi;
const DDL_RE = /^\s*(?:CREATE|ALTER|DROP|PRAGMA)\b/i;
const MYSQL_CONSTRUCTS_RE =
  /\bNOW\s*\(\s*\d*\s*\)|\b(?:FOR\s+UPDATE|CURRENT_TIMESTAMP|UTC_TIMESTAMP|DATE_FORMAT|DATE_SUB|TIMESTAMPADD|CONVERT_TZ|__CLOCK_OFFSET_|BINARY|JSON_CONTAINS_PATH|JSON_UNQUOTE|JSON_ARRAYAGG|JSON_TYPE|FORCE\s+INDEX|STRAIGHT_JOIN|CHAR_LENGTH|REGEXP|STR_TO_DATE|LEAST)\b/i;

// Stateless (non-global) variants for detection: global regexes keep
// `lastIndex` between `.test()` calls.
const HAS_FOR_UPDATE_RE = new RegExp(FOR_UPDATE_RE.source, "i");
const HAS_CLOCK_RE = new RegExp(CLOCK_RE.source, "i");
const HAS_MYSQL_RE = new RegExp(MYSQL_CONSTRUCTS_RE.source, "i");
const CLOCK_ONLY_RE =
  /^\s*SELECT\s+(?:(?:CURRENT_TIMESTAMP|UTC_TIMESTAMP)(?:\s*\(\s*\d*\s*\))?|NOW\s*\(\s*\d*\s*\))\s+AS\s+([A-Za-z_][A-Za-z0-9_]*)\s*;?\s*$/i;

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

function rewriteNotRegexp(text: string): string {
  const notRegexpPattern =
    /\s+NOT\s+REGEXP\s*['"]\^\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}T\[0-9\]\{2\}:\[0-9\]\{2\}:\[0-9\]\{2\}\[\.\]\[0-9\]\{3\}Z\$['"]/gi;
  let match: RegExpExecArray | null;
  let result = "";
  let lastIndex = 0;

  while ((match = notRegexpPattern.exec(text)) !== null) {
    const matchStart = match.index;
    const matchEnd = match.index + match[0].length;

    let exprEnd = matchStart;
    while (exprEnd > lastIndex && /\s/.test(text[exprEnd - 1])) {
      exprEnd--;
    }

    let exprStart = exprEnd;
    if (text[exprEnd - 1] === ")") {
      let depth = 1;
      let i = exprEnd - 2;
      while (i >= lastIndex && depth > 0) {
        if (text[i] === ")") depth++;
        else if (text[i] === "(") depth--;
        i--;
      }
      let identEnd = i;
      while (identEnd >= lastIndex && /[A-Za-z0-9_.]/.test(text[identEnd])) {
        identEnd--;
      }
      exprStart = identEnd + 1;
    } else {
      let i = exprEnd - 1;
      while (i >= lastIndex && /[A-Za-z0-9_.]/.test(text[i])) {
        i--;
      }
      exprStart = i + 1;
    }

    const expr = text.slice(exprStart, exprEnd).trim();
    result += text.slice(lastIndex, exprStart);
    result += `(length(${expr}) <> 24 OR ${expr} NOT LIKE '____-__-__T__:__:__.___Z')`;

    lastIndex = matchEnd;
    notRegexpPattern.lastIndex = lastIndex;
  }

  result += text.slice(lastIndex);
  return result;
}

function rewriteJsonUnquote(text: string): string {
  const jsonUnquoteRe = /\bJSON_UNQUOTE\s*\(/gi;
  let match: RegExpExecArray | null;
  let result = "";
  let lastIndex = 0;

  while ((match = jsonUnquoteRe.exec(text)) !== null) {
    const start = match.index;
    const openParen = start + match[0].length - 1;
    let depth = 1;
    let closeParen = -1;
    for (let i = openParen + 1; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") {
        depth--;
        if (depth === 0) {
          closeParen = i;
          break;
        }
      }
    }
    if (closeParen === -1) {
      continue;
    }

    const inside = text.slice(openParen + 1, closeParen).trim();
    result += text.slice(lastIndex, start);

    const extractMatch = inside.match(
      /^(?:JSON_EXTRACT|json_extract)\s*\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)$/i,
    );
    if (extractMatch) {
      result += `json_extract(${extractMatch[1].trim()}, ${extractMatch[2].trim()})`;
    } else {
      result += inside;
    }

    lastIndex = closeParen + 1;
    jsonUnquoteRe.lastIndex = lastIndex;
  }

  result += text.slice(lastIndex);
  return result;
}

function rewriteJsonType(text: string): string {
  const jsonTypeRe = /\bJSON_TYPE\s*\(/gi;
  let match: RegExpExecArray | null;
  let result = "";
  let lastIndex = 0;

  while ((match = jsonTypeRe.exec(text)) !== null) {
    const start = match.index;
    const openParen = start + match[0].length - 1;
    let depth = 1;
    let closeParen = -1;
    for (let i = openParen + 1; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") {
        depth--;
        if (depth === 0) {
          closeParen = i;
          break;
        }
      }
    }
    if (closeParen === -1) {
      continue;
    }

    let inside = text.slice(openParen + 1, closeParen).trim();
    const after = text.slice(closeParen + 1);

    // If inside is JSON_EXTRACT(col, path), map to (col, path) for SQLite json_type(col, path)
    const extractMatch = inside.match(
      /^(?:JSON_EXTRACT|json_extract)\s*\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)$/i,
    );
    if (extractMatch) {
      inside = `${extractMatch[1].trim()}, ${extractMatch[2].trim()}`;
    }

    // Check if JSON_TYPE is inside COALESCE(JSON_TYPE(...), fallback) op 'TYPE'
    const beforeText = text.slice(lastIndex, start);
    const coalesceBeforeMatch = beforeText.match(/\bCOALESCE\s*\(\s*$/i);
    const coalesceAfterMatch = after.match(
      /^\s*,\s*(['"].*?['"])\s*\)\s*(=|<>|!=)\s*['"](STRING|INTEGER|OBJECT|ARRAY)['"]/i,
    );

    if (coalesceBeforeMatch && coalesceAfterMatch) {
      const op = coalesceAfterMatch[2];
      const type = coalesceAfterMatch[3].toUpperCase();
      const sqliteType =
        type === "STRING"
          ? "text"
          : type === "INTEGER"
            ? "integer"
            : type === "OBJECT"
              ? "object"
              : "array";
      const isIn = op === "=";
      const fallback = coalesceAfterMatch[1];
      const clause = isIn
        ? `COALESCE(json_type(${inside}), ${fallback}) IN ('${sqliteType}', '${type}')`
        : `COALESCE(json_type(${inside}), ${fallback}) NOT IN ('${sqliteType}', '${type}')`;

      result += beforeText.slice(0, coalesceBeforeMatch.index);
      result += clause;
      lastIndex = closeParen + 1 + coalesceAfterMatch[0].length;
      jsonTypeRe.lastIndex = lastIndex;
      continue;
    }

    result += text.slice(lastIndex, start);

    const opMatch = after.match(
      /^\s*(=|<>|!=)\s*['"](STRING|INTEGER|OBJECT|ARRAY)['"]/i,
    );
    if (opMatch) {
      const op = opMatch[1];
      const type = opMatch[2].toUpperCase();
      const sqliteType =
        type === "STRING"
          ? "text"
          : type === "INTEGER"
            ? "integer"
            : type === "OBJECT"
              ? "object"
              : "array";
      const isIn = op === "=";
      const clause = isIn
        ? `json_type(${inside}) IN ('${sqliteType}', '${type}')`
        : `json_type(${inside}) NOT IN ('${sqliteType}', '${type}')`;
      result += clause;
      lastIndex = closeParen + 1 + opMatch[0].length;
      jsonTypeRe.lastIndex = lastIndex;
    } else {
      result += `json_type(${inside})`;
      lastIndex = closeParen + 1;
      jsonTypeRe.lastIndex = lastIndex;
    }
  }

  result += text.slice(lastIndex);
  return result;
}

function rewriteLeast(text: string): string {
  const leastRe = /\bLEAST\s*\(/gi;
  let match: RegExpExecArray | null;
  let result = "";
  let lastIndex = 0;

  while ((match = leastRe.exec(text)) !== null) {
    const start = match.index;
    const openParen = start + match[0].length - 1;
    let depth = 1;
    let closeParen = -1;
    const commaIndices: number[] = [];

    for (let i = openParen + 1; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") {
        depth--;
        if (depth === 0) {
          closeParen = i;
          break;
        }
      } else if (text[i] === "," && depth === 1) {
        commaIndices.push(i);
      }
    }

    if (closeParen === -1 || commaIndices.length === 0) {
      continue;
    }

    const rawArgs: string[] = [];
    let prev = openParen + 1;
    for (const cIdx of commaIndices) {
      rawArgs.push(text.slice(prev, cIdx).trim());
      prev = cIdx + 1;
    }
    rawArgs.push(text.slice(prev, closeParen).trim());

    // Recursively rewrite arguments first
    const args = rawArgs.map((a) => rewriteLeast(a));

    const foldTwo = (a1: string, a2: string) => {
      if (/^\d+(?:\.\d+)?$/.test(a1)) {
        return `(CASE WHEN (${a2}) < ${a1} THEN (${a2}) ELSE ${a1} END)`;
      } else if (/^\d+(?:\.\d+)?$/.test(a2)) {
        return `(CASE WHEN (${a1}) < ${a2} THEN (${a1}) ELSE ${a2} END)`;
      } else {
        return `(CASE WHEN (${a2}) < (${a1}) THEN (${a2}) ELSE (${a1}) END)`;
      }
    };

    let folded = args[args.length - 1];
    for (let k = args.length - 2; k >= 0; k--) {
      folded = foldTwo(args[k], folded);
    }

    result += text.slice(lastIndex, start) + folded;
    lastIndex = closeParen + 1;
    leastRe.lastIndex = lastIndex;
  }

  result += text.slice(lastIndex);
  return result;
}

/**
 * Rewrites MySQL date/time manipulation functions into SQLite equivalents.
 */
export function rewriteConstructs(text: string): string {
  let res = text;

  // 1. DATE_SUB with CURRENT_TIMESTAMP / UTC_TIMESTAMP / NOW() and INTERVAL
  res = res.replace(
    /DATE_SUB\s*\(\s*(?:(?:CURRENT_TIMESTAMP|UTC_TIMESTAMP)(?:\s*\(\s*\d*\s*\))?|NOW\s*\(\s*\d*\s*\))\s*,\s*INTERVAL\s+(\d+)\s+([A-Za-z]+)\s*\)/gi,
    (_m, num, unit) => {
      const n = parseInt(num, 10);
      const u = unit.toUpperCase();
      let ms = 0;
      if (u === "SECOND" || u === "SECONDS") ms = n * 1000;
      else if (u === "MINUTE" || u === "MINUTES") ms = n * 60_000;
      else if (u === "HOUR" || u === "HOURS") ms = n * 3_600_000;
      else if (u === "DAY" || u === "DAYS") ms = n * 86_400_000;
      return `__CLOCK_OFFSET_MINUS_${ms}__`;
    },
  );

  // 2. TIMESTAMPADD with literal number interval and CURRENT_TIMESTAMP / UTC_TIMESTAMP / NOW()
  res = res.replace(
    /TIMESTAMPADD\s*\(\s*(SECOND|MICROSECOND|MINUTE|HOUR|DAY)\s*,\s*(-?\d+)\s*,\s*(?:(?:CURRENT_TIMESTAMP|UTC_TIMESTAMP)(?:\s*\(\s*\d*\s*\))?|NOW\s*\(\s*\d*\s*\))\s*\)/gi,
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

  // 5. STR_TO_DATE(CONCAT(col, '-01'), '%Y-%m-%d')
  res = res.replace(
    /STR_TO_DATE\s*\(\s*CONCAT\s*\(\s*([^,]+?)\s*,\s*['"]-01['"]\s*\)\s*,\s*['"]%Y-%m-%d['"]\s*\)/gi,
    "($1 || '-01T00:00:00.000Z')",
  );

  // 6. Static JSON_CONTAINS_PATH(col, 'one'|'all', path)
  res = res.replace(
    /JSON_CONTAINS_PATH\s*\(\s*([^,]+?)\s*,\s*['"](?:one|all)['"]\s*,\s*([^)]+?)\s*\)/gi,
    "(CASE WHEN json_type($1, $2) IS NOT NULL THEN 1 ELSE 0 END)",
  );

  // 7. Static JSON_UNQUOTE
  res = rewriteJsonUnquote(res);

  // 8. ISO-8601 NOT REGEXP
  res = rewriteNotRegexp(res);

  // 9. JSON_TYPE normalization
  res = rewriteJsonType(res);

  // 10. LEAST
  res = rewriteLeast(res);

  // 11. CAST(... AS BINARY) and BINARY operator
  res = res.replace(
    /CAST\s*\(\s*(.+?)\s+AS\s+BINARY(?:\s*\(\s*\d+\s*\))?\s*\)/gi,
    "CAST($1 AS BLOB)",
  );
  res = res.replace(/\bBINARY\s+/gi, "");

  // 12. FORCE INDEX (...) and STRAIGHT_JOIN
  res = res.replace(/\bFORCE\s+INDEX\s*\([^)]*\)/gi, "");
  res = res.replace(/\bSTRAIGHT_JOIN\b/gi, "JOIN");

  // 13. CHAR_LENGTH( -> length(
  res = res.replace(/\bCHAR_LENGTH\s*\(/gi, "length(");

  // 14. JSON_ARRAYAGG( -> json_group_array(
  res = res.replace(/\bJSON_ARRAYAGG\s*\(/gi, "json_group_array(");

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
export function rewriteSql(
  sql: Prisma.Sql,
  now: Date = new Date(),
): Prisma.Sql {
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
      /^\s*,\s*(?:(?:CURRENT_TIMESTAMP|UTC_TIMESTAMP)(?:\s*\(\s*\d*\s*\))?|NOW\s*\(\s*\d*\s*\))\s*\)/i.test(
        strings[i + 1],
      )
    ) {
      strings[i] = strings[i].replace(
        /TIMESTAMPADD\s*\(\s*MICROSECOND\s*,\s*$/i,
        `(${now.getTime()} + round(`,
      );
      strings[i + 1] = strings[i + 1].replace(
        /^\s*,\s*(?:(?:CURRENT_TIMESTAMP|UTC_TIMESTAMP)(?:\s*\(\s*\d*\s*\))?|NOW\s*\(\s*\d*\s*\))\s*\)/i,
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

    // Cross-boundary: JSON_CONTAINS_PATH(col, 'one', ${path}) -> (CASE WHEN json_type(col, ${path}) IS NOT NULL THEN 1 ELSE 0 END)
    const jsonContainsMatch = strings[i].match(
      /JSON_CONTAINS_PATH\s*\(\s*([^,]+?)\s*,\s*['"](?:one|all)['"]\s*,\s*$/i,
    );
    if (jsonContainsMatch && /^\s*\)/i.test(strings[i + 1])) {
      const col = jsonContainsMatch[1].trim();
      strings[i] = strings[i].replace(
        /JSON_CONTAINS_PATH\s*\(\s*([^,]+?)\s*,\s*['"](?:one|all)['"]\s*,\s*$/i,
        `(CASE WHEN json_type(${col}, `,
      );
      strings[i + 1] = strings[i + 1].replace(
        /^\s*\)/i,
        ") IS NOT NULL THEN 1 ELSE 0 END)",
      );
    }

    // Cross-boundary: JSON_UNQUOTE(JSON_EXTRACT(col, ${path})) -> json_extract(col, ${path})
    const jsonUnquoteExtractMatch = strings[i].match(
      /JSON_UNQUOTE\s*\(\s*JSON_EXTRACT\s*\(\s*([^,]+?)\s*,\s*$/i,
    );
    if (jsonUnquoteExtractMatch && /^\s*\)\s*\)/i.test(strings[i + 1])) {
      const col = jsonUnquoteExtractMatch[1].trim();
      strings[i] = strings[i].replace(
        /JSON_UNQUOTE\s*\(\s*JSON_EXTRACT\s*\(\s*([^,]+?)\s*,\s*$/i,
        `json_extract(${col}, `,
      );
      strings[i + 1] = strings[i + 1].replace(/^\s*\)\s*\)/i, ")");
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

  return Prisma.sql(
    newStrings as unknown as TemplateStringsArray,
    ...newValues,
  );
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
