import forgeIdl from "./generated/forge.json" with { type: "json" };

export { default as forgeIdl } from "./generated/forge.json" with { type: "json" };
export type { Forge } from "./generated/forge.js";
export const FORGE_PROGRAM_ID = forgeIdl.address;

export * from "./accounts.js";
export * from "./bytes.js";
export * from "./errors.js";
export { FORGE_PROGRAM_ADDRESS, idl } from "./idl.js";
export * from "./intents.js";
export * from "./json.js";
export * from "./pda.js";
export * from "./plan.js";
export * from "./views.js";
