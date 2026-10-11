import { createRoot } from "react-dom/client";

import { App } from "./app";
import { storedTheme } from "./ui";

document.documentElement.dataset.theme = storedTheme();

const root = document.querySelector("#root");
if (!root) {
  throw new Error("Missing #root element");
}
createRoot(root).render(<App />);
