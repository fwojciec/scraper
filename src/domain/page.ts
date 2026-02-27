/** A named browser page managed by the daemon. */
export interface Page {
  name: string;
  url: string;
  targetId: string;
}

/** Request to navigate a named page to a URL. */
export interface NavigateRequest {
  name?: string;
  url: string;
}

/** Info returned about a page after navigation. */
export interface PageInfo {
  name: string;
  url: string;
  targetId: string;
}
