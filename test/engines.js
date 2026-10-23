import { chromium, firefox, webkit } from "playwright";

// {§web-build} The supported browser compliance matrix is Chromium and Firefox.
// WebKit joins only behind an explicit opt-in because its local automation host is recorded-flaky (#29).
const optional = process.env.PLURNK_WEB_TEST_WEBKIT === "1" ? [webkit] : [];

export const engines = [chromium, firefox, ...optional];