/**
 * `window.shopify` is created by the CDN script tag in index.html — there is
 * no npm package backing it (see the comment there for why). Only the one
 * method this app actually calls is declared; App Bridge exposes much more.
 */
declare global {
  interface Window {
    shopify?: {
      idToken(): Promise<string>;
    };
  }
}

export {};
