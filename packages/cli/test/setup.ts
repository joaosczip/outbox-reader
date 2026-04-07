import { beforeAll } from "bun:test";

beforeAll(() => {
	console.log = () => {};
	console.warn = () => {};
});
