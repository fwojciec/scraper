/** Identifier for a browser page/tab. */
export type PageId = string;

/** Info about an open browser page/tab. */
export interface PageInfo {
  pageId: PageId;
  url: string;
  title: string;
  active: boolean;
}
