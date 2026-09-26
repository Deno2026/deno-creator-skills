import premierepro from "@adobe/eslint-plugin-premierepro";

export default [
  {
    ignores: ["node_modules/**", "dist/**", "renders/**", "tmp/**"],
  },
  {
    files: ["extensions/deno-premiere-uxp/handlers/**/*.js"],
    plugins: premierepro.configs.recommended.plugins,
    rules: premierepro.configs.recommended.rules,
  },
];
