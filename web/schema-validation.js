import { config } from "zod/v4/core";

// {§web-browser-security} Configure before any SDK object schemas probe dynamic code generation.
config({ jitless: true });
