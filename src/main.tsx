import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installDiagnostics } from "./lib/diagnostics";
import { useChat } from "./store/chat";
import "./styles.css";

// Before anything renders, so an exception on the way up is caught too.
installDiagnostics();

// Dev-only convenience for poking state from the console while iterating on
// design (e.g. `__chat.getState().join("someuser")`). Stripped from prod
// builds since `import.meta.env.DEV` is statically false there.
if (import.meta.env.DEV) {
  (window as unknown as { __chat: typeof useChat }).__chat = useChat;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
