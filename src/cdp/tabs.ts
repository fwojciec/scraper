/** Stateless tab addressing: `--tab <input>` → canonical full targetId via /json/list. */

/** Raw entry shape from Chrome's /json/list endpoint. */
export interface HttpTab {
  id: string;
  type: string;
  url: string;
  title: string;
}

export type Fetcher = (url: string) => Promise<Response>;

/** Fetch tabs from Chrome's /json/list endpoint. */
export async function listHttpTabs(port: number, fetcher: Fetcher = fetch): Promise<HttpTab[]> {
  const res = await fetcher(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Chrome /json/list returned ${res.status}`);
  }
  return await res.json() as HttpTab[];
}

/**
 * Resolve a `--tab <input>` to the unique full targetId among live *page* tabs.
 * Throws with the exact error text specified by the Tier B design doc.
 */
export function matchTabByPrefix(input: string, tabs: readonly HttpTab[]): string {
  if (!input) {
    throw new Error(
      "--tab <targetId> is required. Run `scraper tabs` to list tabs, or `scraper navigate --new <url>` to open a new one.",
    );
  }
  const pages = tabs.filter((t) => t.type === "page");
  const matches = pages.filter((t) => t.id.startsWith(input));
  if (matches.length === 0) {
    throw new Error(
      `no tab with prefix \`${input}\`; run \`scraper tabs\` to see available tabs.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `ambiguous prefix \`${input}\`, matches ${matches.length} tabs; provide more characters (full IDs are printed by \`scraper tabs\`).`,
    );
  }
  return matches[0].id;
}

/**
 * Canonicalize `<input>` against Chrome's live page targets. Every command's
 * first step when it receives `--tab <input>`. The returned canonical targetId
 * drives file I/O, snapshot metadata, and user-facing output — never `<input>`.
 *
 * The empty-input (missing-flag) check short-circuits before any Chrome I/O so
 * `scraper snapshot` (etc.) without `--tab` reports the documented error even
 * when Chrome is unreachable.
 */
export async function canonicalizeTargetId(
  input: string,
  port: number,
  fetcher: Fetcher = fetch,
): Promise<string> {
  if (!input) return matchTabByPrefix(input, []);
  const tabs = await listHttpTabs(port, fetcher);
  return matchTabByPrefix(input, tabs);
}
