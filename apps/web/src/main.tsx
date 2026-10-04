import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";
import "./card-design.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Hooktry web root is missing");
}

createRoot(root).render(<App />);
