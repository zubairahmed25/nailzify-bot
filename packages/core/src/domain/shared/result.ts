/**
 * Result — an explicit success/failure value.
 *
 * WHY NOT JUST THROW? Because in this system some failures are *expected inputs
 * to the next step*, not emergencies.
 *
 * The clearest case is tool execution (docs/07-backend.md §7.6). When the Shopify
 * API is down, that is not an application error — it is information the *model*
 * needs so it can tell the customer "I can't check stock right now." Throwing
 * would abort the turn. Returning a value lets the conversation continue
 * gracefully, which is the whole point.
 *
 * WHEN TO THROW INSTEAD: programmer errors — a null that should be impossible, a
 * malformed constant, an exhaustiveness violation. Those are bugs, and bugs
 * should be loud.
 *
 * RULE OF THUMB: if a caller can sensibly *do something* about it, return a
 * Result. If the only sensible response is "fix the code", throw.
 */

export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

/** Transform the success value, leaving a failure untouched. */
export const map = <T, U, E>(r: Result<T, E>, fn: (value: T) => U): Result<U, E> =>
  r.ok ? ok(fn(r.value)) : r;

/** Transform the failure, leaving a success untouched. */
export const mapErr = <T, E, F>(r: Result<T, E>, fn: (error: E) => F): Result<T, F> =>
  r.ok ? r : err(fn(r.error));

/** Extract the value, or fall back. Use at the edge, where a decision is made. */
export const unwrapOr = <T, E>(r: Result<T, E>, fallback: T): T => (r.ok ? r.value : fallback);

/**
 * Exhaustiveness helper.
 *
 * Put this in the `default:` of a switch over a union. If someone later adds a
 * variant and forgets to handle it, the code stops COMPILING rather than
 * silently falling through at runtime. This is one of the highest-value
 * five-line utilities in a TypeScript codebase.
 */
export function assertNever(value: never, context = "value"): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`);
}
