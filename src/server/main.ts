import { readFile } from "node:fs/promises";
import { parseCommand, USAGE } from "./config.ts";

const version = async (): Promise<string> => {
  const body = await readFile(new URL("../../package.json", import.meta.url), "utf8");
  return (JSON.parse(body) as { version: string }).version;
};

export const main = async (argv: readonly string[] = process.argv.slice(2)): Promise<void> => {
  let command;
  try {
    command = parseCommand(argv);
  } catch (cause) {
    process.stderr.write(`plurnk-web: ${cause instanceof Error ? cause.message : String(cause)}\n\n${USAGE}`);
    process.exitCode = 64;
    return;
  }
  if (command.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (command.version) {
    process.stdout.write(`${await version()}\n`);
    return;
  }

  const { startPortal } = await import("./portal.ts");
  const portal = await startPortal(command.configuration);
  process.stderr.write(`plurnk-web: ${await version()} · ${portal.origin} · AG-UI ${command.configuration.upstream.origin}\n`);

  await new Promise<void>((resolveStop) => {
    const stop = () => resolveStop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await portal.close();
};
