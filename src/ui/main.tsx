import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";

import "@fontsource/sora/latin-400.css";
import "@fontsource/sora/latin-600.css";
import "@fontsource/sora/latin-700.css";
import "@fontsource/chivo-mono/latin-400.css";
import "@fontsource/chivo-mono/latin-700.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/board.css";
import "./styles/pages.css";

const mount = document.getElementById("deck");
if (mount === null) {
  throw new Error("the document has no #deck to mount the dashboard into");
}

createRoot(mount).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
