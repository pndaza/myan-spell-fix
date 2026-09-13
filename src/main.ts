import App from "./App.svelte";
import { mount } from "svelte";
import "@fontsource/padauk/400.css";
import "@fontsource/padauk/700.css";
import "./app.css";
import { currentTheme, resolveTheme } from "./theme";

// index.html's inline script already resolved the theme pre-paint; this
// re-applies it for the reactive state (harmless no-op on the DOM).
document.documentElement.dataset.theme = resolveTheme(currentTheme());

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
