/** Identifier for a browser page/tab. */
export type PageId = string;

/** Request to navigate the browser to a URL. */
export interface NavigateRequest {
  url: string;
}

/** Info about an open browser page/tab. */
export interface PageInfo {
  pageId: PageId;
  url: string;
  title: string;
  active: boolean;
}
