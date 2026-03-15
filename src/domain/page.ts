/** Request to navigate the browser to a URL. */
export interface NavigateRequest {
  url: string;
}

/** Info about an open browser page/tab. */
export interface PageInfo {
  targetId: string;
  url: string;
  title: string;
  active: boolean;
}
