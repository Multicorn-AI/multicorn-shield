/**
 * Package metadata from the root manifest (single source of truth for version strings).
 *
 * @module package-meta
 */

import packageJson from "../package.json" with { type: "json" };

export const PACKAGE_VERSION: string = packageJson.version;
