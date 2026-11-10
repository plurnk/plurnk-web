import { test } from "node:test";
import createModule from "../src/module.js";
import verifyRouteSettlement from "./route-settlement.js";

test("{§web-route-settlement} admitted route work precedes resource release", { timeout: 20_000 },
    (t) => verifyRouteSettlement(t, createModule));
