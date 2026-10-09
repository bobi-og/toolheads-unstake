// Node runner for the same self-test the page offers: npm test
import { selfTest } from "../src/selftest.js";
await selfTest((m) => console.log(m));
console.log("ALL TESTS PASSED");
