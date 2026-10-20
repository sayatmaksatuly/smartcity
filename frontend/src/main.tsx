import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import { AccountProvider } from "./account/AccountProvider";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AccountProvider><App /></AccountProvider>
  </StrictMode>,
);
