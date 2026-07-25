import { inject } from "@vercel/analytics";

const localHosts = new Set(["", "localhost", "127.0.0.1", "0.0.0.0", "::1"]);
const isLocalPage = localHosts.has(window.location.hostname) || window.location.protocol === "file:";

if (!isLocalPage) {
  inject({ mode: "production" });
}
