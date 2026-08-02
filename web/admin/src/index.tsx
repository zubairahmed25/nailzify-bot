/**
 * Admin page entry point.
 *
 * No shadow DOM here, unlike the storefront widget (web/widget/src/index.tsx)
 * — that isolation exists because the widget is a guest inside a theme it
 * does not control. This page IS the document; there is no host page's CSS
 * to leak into or be deformed by.
 */
import { render } from "preact";
import { App } from "./App.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element.");

render(<App />, root);
