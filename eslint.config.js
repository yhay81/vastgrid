// ESLint runs only the rules of React (Biome lints everything else): `eslint-plugin-react-hooks` with React
// Compiler's rules, on the v2 React package (v2-react.md §11).
import babelParser from "@babel/eslint-parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    files: ["packages/grid/src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: { babelrc: false, configFile: false, presets: ["@babel/preset-typescript"] },
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.flat["recommended-latest"].rules,
  },
];
