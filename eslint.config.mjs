import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default tseslint.config(
  // 1. 全局忽略的文件或目录
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**", ".history/**"]
  },

  // 2. JS 推荐规则
  js.configs.recommended,

  // 3. TS 推荐规则（如需类型检查支持可使用 ...tseslint.configs.recommendedTypeChecked）
  ...tseslint.configs.recommended,

  // 4. 自定义规则 / 特定文件规则
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      // 可以在此覆盖或补充规则，例如：
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }]
    }
  },

  // 5. 必须放在最后，用于关闭与 Prettier 冲突的格式规则
  prettierConfig
);
