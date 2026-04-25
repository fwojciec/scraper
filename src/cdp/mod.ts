// Adapter: Chrome DevTools Protocol.
export {
  buildBrowserWsUrl,
  type CdpBrowserService,
  type CdpPageService,
  createBrowserConnection,
  createPageConnection,
  discoverWsUrl,
} from "./connection.ts";
export { defaultUserDataDir, readDevToolsActivePort } from "./attach.ts";
export { resolveTarget } from "./resolve.ts";
export {
  canonicalizeTargetId,
  type HttpTab,
  listBrowserTargets,
  matchTabByPrefix,
  type TargetLister,
} from "./tabs.ts";
