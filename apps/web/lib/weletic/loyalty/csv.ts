export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (
    str.includes(",") ||
    str.includes('"') ||
    str.includes("\n") ||
    str.includes("\r")
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function escapeCsvUntrustedTextCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  const neutralized = /^[=+\-@＝＋－＠\t\r\n]/.test(str) ? `'${str}` : str;
  return escapeCsvCell(neutralized);
}
