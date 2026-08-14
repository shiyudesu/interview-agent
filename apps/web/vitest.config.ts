import { createVitestConfig } from "../../vitest.shared.ts";

export default createVitestConfig("jsdom", {
  include: ["test/**/*.test.{ts,tsx}"],
});
