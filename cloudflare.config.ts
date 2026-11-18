import { defineConfig } from "cf/config";

/**
 * Static marketing site for RatchetStrap, served as Worker assets from ./site.
 * Deploy with `cf deploy` from the repository root.
 */
export default defineConfig({
	accountId: "ad5ec479b9a421faa2ed06c3d1c2b23a",
	worker: {
		name: "ratchetstrap",
		compatibilityDate: "2026-11-18",
		observability: { enabled: true },
		assets: {
			htmlHandling: "auto-trailing-slash",
			notFoundHandling: "404-page",
		},
		domains: ["ratchetstrap.chsolutions.ca"],
	},
});
