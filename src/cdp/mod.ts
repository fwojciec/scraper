// Adapter: Chrome DevTools Protocol. Implements BrowserService.
export { type ChromeProcess, killChrome, launchChrome, type LaunchOptions } from "./chrome.ts";
export { type CdpBrowserService, createCdpConnection } from "./connection.ts";
