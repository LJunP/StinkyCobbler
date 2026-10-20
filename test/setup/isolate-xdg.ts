import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Tiered config reads $XDG_CONFIG_HOME/stinky-cobbler. Pin an empty directory
// so a developer config cannot change the suite. Tests may override it.
process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "stinky-xdg-"));
