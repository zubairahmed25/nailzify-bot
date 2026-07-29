/** Vite's `?inline` import returns the stylesheet as a string. */
declare module "*.css?inline" {
  const css: string;
  export default css;
}
