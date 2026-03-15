// Adapter: Chrome DevTools Protocol. Implements BrowserService.
export { type ChromeProcess, killChrome, launchChrome, type LaunchOptions } from "./chrome.ts";
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
