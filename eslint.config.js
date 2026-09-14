import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["node_modules", "dist", ".codegraph", "eslint.config.js"] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  // 类型级 lint:projectService 置于全局,让 recommendedTypeChecked 命中的每个文件都拿得到类型信息
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    files: ["src/**/*.ts"],
    rules: {
      // 本项目重点:异步正确性(loop/stream 全 async)—— 生产代码硬 error
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/await-thenable": "error",
      // 可读性/常见坑
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
    },
  },

  // 动态 JSON 边界(SSE / tool args / ajv)命中量大且非本项目重点 → 降 warn(可见但不阻断)
  // 未来收紧类型边界时,逐条改回 error 即可
  {
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      // 关掉:--fix 会删 `as X` 断言,而断言往往是某个 type import 的唯一用处 → 一删 import 即变未用 →
      // no-unused-vars(error) 第二趟报错 → lint-staged 回滚。二者耦合,故 off(纯样式,非本项目重点)。
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-base-to-string": "warn",
      "no-useless-assignment": "warn",
    },
  },

  // 测试替身:无 await 的 async mock 生成器 / run() 属按设计,生产侧仍保 error
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },

  prettier,
);
