import { defineWranglerConfig } from "wrangler/experimental-config";

/** Consumed by cf: the directory of static assets to upload. */
export default defineWranglerConfig({
	assetsDirectory: "./site",
});
