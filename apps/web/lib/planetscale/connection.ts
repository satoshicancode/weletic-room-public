import { connect } from "@planetscale/database";

const rawUrl = process.env.PLANETSCALE_DATABASE_URL || process.env.DATABASE_URL;
const validUrl =
  rawUrl && (rawUrl.startsWith("http://") || rawUrl.startsWith("https://") || rawUrl.startsWith("pscale://"))
    ? rawUrl
    : "http://unused:unused@localhost:3900/planetscale";

export const conn = connect({
  url: validUrl,
});
