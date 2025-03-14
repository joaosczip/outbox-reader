module.exports = {
	parser: "@typescript-eslint/parser",
	parserOptions: {
		project: "tsconfig.json",
		tsconfigRootDir: __dirname,
		sourceType: "module",
	},
	plugins: ["@typescript-eslint/eslint-plugin"],
	extends: [
		"plugin:@typescript-eslint/recommended",
		"plugin:prettier/recommended",
	],
	root: true,
	env: {
		node: true,
		jest: true,
	},
	ignorePatterns: ["**/node_modules/*", "**/dist/*", ".eslintrc.js"],
	rules: {
		"@typescript-eslint/interface-name-prefix": "on",
		"@typescript-eslint/explicit-function-return-type": "on",
		"@typescript-eslint/explicit-module-boundary-types": "on",
		"@typescript-eslint/no-explicit-any": "on",
	},
};
