import { test } from "node:test";
import createModule from "../ai.plurnk/module.js";
import verifyRouteSettlement from "./route-settlement.js";

test("{§web-route-settlement} admitted route work precedes resource release", { timeout: 20_000 },
    (t) => verifyRouteSettlement(t, createModule));
