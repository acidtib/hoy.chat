// Next 16's eslint-config-next ships a native flat config array, so it is spread
// in directly. FlatCompat is not used; wrapping this config in FlatCompat hits a
// circular-structure error from the bundled react plugin.
import next from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  ...next,
  { ignores: [".next/**", "out/**"] },
];

export default eslintConfig;
