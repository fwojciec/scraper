/** Request to evaluate a JS expression in a page's browser context. */
export interface EvalRequest {
  name?: string;
  expression: string;
}

/** Result of evaluating a JS expression. */
export interface EvalResult {
  result: unknown;
}
