// App bootstrap: grab the mount node, wire the api, and mount the shell which
// in turn starts the router.

import "./styles/tokens.css";
import "./styles/global.css";
import { api } from "./api";
import { mountShell } from "./shell";

const mount = document.getElementById("app");
if (!mount) {
  throw new Error("missing #app mount node");
}

mountShell(mount, api);
