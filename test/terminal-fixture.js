import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import pty from "node-pty";
import headless from "@xterm/headless";

// {§web-package} Drive the installed client through a real terminal, not its private transport.
export default async function startTerminal({ consumer, base, workspace, secret, yolo }) {
    const home = await mkdtemp(join(tmpdir(), "plurnk-web-terminal-"));
    const url = new URL(base);
    const cols = 120;
    const rows = 36;
    let term;
    try {
        term = pty.spawn(process.execPath, [join(consumer, "node_modules", ".bin", "plurnk"),
            "--workspace", workspace, "--worker", "user", "--project-root", ""], {
            name: "xterm-256color", cols, rows, cwd: consumer,
            env: {
                PATH: process.env.PATH,
                HOME: home,
                XDG_CONFIG_HOME: join(home, ".config"),
                XDG_DATA_HOME: join(home, ".local", "share"),
                XDG_STATE_HOME: join(home, ".local", "state"),
                XDG_CACHE_HOME: join(home, ".cache"),
                PLURNK_HOST: url.hostname,
                PLURNK_PORT: url.port,
                PLURNK_AGUI_URL: "",
                PLURNK_SECRET: secret,
                PLURNK_CLIENT_AUTOSTART: "0",
                PLURNK_CLIENT_YOLO: yolo ? "1" : "0",
                NO_COLOR: "1",
            },
        });
    } catch (error) {
        await rm(home, { recursive: true, force: true });
        throw error;
    }
    const screen = new headless.Terminal({ cols, rows, allowProposedApi: true });
    const waiters = new Set();
    const exited = Promise.withResolvers();
    let exit;
    let output = "";
    const visible = () => {
        const buffer = screen.buffer.active;
        return Array.from({ length: rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "").join("\n");
    };
    const check = () => {
        for (const waiter of waiters) {
            const value = waiter.read();
            if (waiter.matches(value)) waiter.settle(null, value);
            else if (exit) waiter.settle(new Error(`Terminal exited ${exit.exitCode} before the expected output.\n${output.slice(-4000)}`));
        }
    };
    term.onData((chunk) => {
        output += chunk;
        screen.write(chunk, check);
    });
    term.onExit((result) => {
        exit = result;
        screen.write("", () => { check(); exited.resolve(result); });
    });
    const waitFor = (matches, read) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => waiter.settle(new Error(`Terminal did not reach the expected state.\n${read().slice(-4000)}`)), 5000);
        const waiter = {
            matches, read,
            settle(error, value) {
                clearTimeout(timer);
                waiters.delete(waiter);
                if (error) reject(error);
                else resolve(value);
            },
        };
        waiters.add(waiter);
        check();
    });
    return {
        write: (value) => term.write(value),
        output: () => stripVTControlCharacters(output),
        waitFor: (pattern) => waitFor((value) => pattern.test(value), () => stripVTControlCharacters(output)),
        waitForScreen: (matches) => waitFor(matches, visible),
        async close() {
            if (!exit) term.kill();
            const timer = setTimeout(() => term.kill("SIGKILL"), 5000);
            try {
                await exited.promise;
                assert.equal(waiters.size, 0, "no terminal wait outlives its test");
            } finally {
                clearTimeout(timer);
                screen.dispose();
                await rm(home, { recursive: true, force: true });
            }
        },
    };
}
