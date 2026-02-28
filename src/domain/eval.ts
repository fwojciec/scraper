/** Request to evaluate a JS expression in the browser context. */
export interface EvalRequest {
  expression: string;
}

/** Result of evaluating a JS expression. */
export interface EvalResult {
  result: unknown;
}
