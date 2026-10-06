import { createRoot } from "react-dom/client";

import { App } from "./app";

const root = document.querySelector("#root");
if (!root) {
  throw new Error("Missing #root element");
}
createRoot(root).render(<App />);
