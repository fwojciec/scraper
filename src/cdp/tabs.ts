/** Stateless tab addressing: `--tab <input>` → canonical full targetId via CDP `Target.getTargets`. */

import { createBrowserConnection } from "./connection.ts";

/** A page tab, as the CLI thinks of it. */
export interface HttpTab {
  id: string;
  type: string;
  url: string;
  title: string;
}

/** Enumerate live page tabs from Chrome. */
export type TargetLister = (wsUrl: string) => Promise<HttpTab[]>;

/**
 * Enumerate Chrome's live page targets via CDP `Target.getTargets` over the
 * browser-level WebSocket. Replaces the older `/json/list` HTTP probe, which
 * Chrome's new MCP-server mode (chrome://inspect's "Remote debugging" toggle)
 * blocks. CDP-over-WebSocket works in both classic and MCP-hosting modes.
 */
export async function listBrowserTargets(wsUrl: string): Promise<HttpTab[]> {
  const browser = await createBrowserConnection(wsUrl);
  try {
    const pages = await browser.listPages();
    return pages.map((p) => ({
      id: p.pageId,
      type: "page",
      url: p.url,
      title: p.title,
    }));
  } finally {
    browser.close();
  }
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
  wsUrl: string,
  lister: TargetLister = listBrowserTargets,
): Promise<string> {
  if (!input) return matchTabByPrefix(input, []);
  const tabs = await lister(wsUrl);
  return matchTabByPrefix(input, tabs);
}
