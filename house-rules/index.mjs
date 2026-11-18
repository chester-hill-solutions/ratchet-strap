import { enabledProfiles, goldenProfiles } from "./golden.mjs";
import { qualityPolicy } from "./quality.mjs";

/**
 * The starter composition. Copy this directory into your repository, change
 * the thresholds and enabled profiles, and keep it under review with your code.
 */
export const houseRules = {
  policy: qualityPolicy,
  goldenProfiles,
};

export { enabledProfiles };

export default houseRules;
