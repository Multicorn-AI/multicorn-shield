/**
 * Ensures dist/server.js exists after tsup build.
 *
 * When the multicorn-proxy sibling repo is present, tsup bundles src/server.ts into
 * dist/server.js and refreshes vendor/local-proxy-server.js. On shield-only checkouts
 * (CI, npm publish without the sibling), the vendored copy is staged into dist/.
 */

import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(new URL(".", import.meta.url)));
const distServer = join(packageRoot, "dist", "server.js");
const vendorServer = join(packageRoot, "vendor", "local-proxy-server.js");

if (existsSync(distServer)) {
  copyFileSync(distServer, vendorServer);
  process.stderr.write("Updated vendor/local-proxy-server.js from dist/server.js\n");
} else if (existsSync(vendorServer)) {
  copyFileSync(vendorServer, distServer);
  process.stderr.write("Staged vendor/local-proxy-server.js to dist/server.js\n");
} else {
  throw new Error(
    "Local proxy server bundle missing. Build with multicorn-proxy checked out as a sibling, " +
      "or commit vendor/local-proxy-server.js.",
  );
}
