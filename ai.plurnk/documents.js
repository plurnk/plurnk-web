import { STATUS_CODES } from "node:http";
import { directoryPath } from "./directory-addresses.js";
import { escapeHtml } from "./http.js";

/** {§web-directory-documents} One compiled document supplies the complete HTML/OTM substrate. */
export default class Documents {
    #beforeTitle;
    #beforeMain;
    #afterMain;
    #home;
    #yolo;
    #reasoningPreviewChars;

    /** {§web-authorization-style} Read the stylesheet declaration from our compiled head, not unrelated lazy assets.
     * @param {string} document
     */
    static stylesheet(document) {
        const links = [...document.split("</head>")[0].matchAll(/<link\b(?=[^>]*\brel="stylesheet")[^>]*>/gu)];
        if (links.length !== 1) throw new Error("The web document must declare exactly one application stylesheet.");
        const path = /\bhref="(\/[^"]+)"/u.exec(links[0][0])?.[1];
        if (!path || path.startsWith("//")) throw new Error("The application stylesheet must have an origin-relative path.");
        return path;
    }

    /** @param {string} document @param {boolean} yolo @param {number} reasoningPreviewChars */
    constructor(document, yolo, reasoningPreviewChars) {
        this.#yolo = yolo;
        this.#reasoningPreviewChars = reasoningPreviewChars;
        const parts = document.split(/<main\b[^>]*>|<\/main>/u);
        if (parts.length !== 3) throw new Error("The web document must contain exactly one main element.");
        const title = parts[0].split(/<title\b[^>]*>|<\/title>/u);
        if (title.length !== 3) throw new Error("The web document must contain exactly one title element before main.");
        this.#beforeTitle = title[0];
        const navigation = title[2].split(/<template id="session-navigation"[^>]*>|<\/template>/u);
        if (navigation.length !== 3) throw new Error("The web document must contain exactly one session-navigation template before main.");
        const header = navigation[2].split("</header>");
        if (header.length !== 2) throw new Error("The web document must close its header once after session navigation and before main.");
        this.#beforeMain = [navigation[0], navigation[1], ...header];
        this.#home = parts[1];
        this.#afterMain = parts[2];
    }

    /** @param {string} title @param {string} body @param {"home" | "daemon" | "workspace" | "worker" | "error" | "account"} kind @param {boolean} [authenticated] @param {string} [breadcrumb] */
    #render(title, body, kind, authenticated = false, breadcrumb = "") {
        const [before, navigation, afterNavigation, afterHeader] = this.#beforeMain;
        const label = kind === "home" ? title : `${title} — Plurnk`;
        return Buffer.from(`${this.#beforeTitle}<title data-text="page-title">${escapeHtml(label)}</title>${before}${authenticated ? navigation : ""}${afterNavigation}${breadcrumb}</header>${afterHeader}<main id="main" tabindex="-1" data-page="${kind}">${body}</main>${this.#afterMain}`);
    }

    /** @param {boolean} authenticated */
    home(authenticated) { return this.#render("Plurnk", this.#home, "home", authenticated); }

    /** {§web-page-shell} HTTP failures keep native navigation without disclosing request data.
     * @param {number} status @param {string} message @param {boolean} [authenticated]
     */
    error(status, message, authenticated = false) {
        const reason = STATUS_CODES[status];
        if (reason === undefined) throw new Error(`Unknown HTTP status: ${status}`);
        const title = `${status} ${reason}`;
        return this.#render(title, '<article aria-labelledby="error-title"><header><h1 id="error-title">'
            + `<span aria-hidden="true">⚠️</span> <span data-text="error-title">${escapeHtml(title)}</span></h1></header>`
            + `<p data-text="error-message">${escapeHtml(message)}</p>`
            + '<footer><a href="/" data-i18n="home">Home</a></footer></article>', "error", authenticated);
    }

    /** {§web-account} Account navigation stays separate from session management. */
    account() {
        return this.#render("Account", '<article aria-labelledby="account-title"><header><h1 id="account-title" data-i18n="account">Account</h1></header>'
            + '<nav aria-label="Account"><ul><li><a href="/account/sessions/" data-i18n="sessions">Sessions</a></li></ul></nav></article>', "account", true);
    }

    /** {§web-account} Only authority-supplied facts are presented as session information.
     * @param {{ family: string, sessions: readonly import("@plurnk/plurnk-contracts").CredentialSession[] }} account
     */
    sessions({ family, sessions }) {
        const time = (/** @type {number} */ timestamp) => {
            const iso = new Date(timestamp).toISOString();
            return `<time datetime="${iso}" data-text="session-time">${iso.replace("T", " ").replace(/\.\d{3}Z$/u, " UTC")}</time>`;
        };
        const entries = sessions.map((entry) => {
            const current = entry.family === family;
            const action = current ? "/auth/logout" : `/account/sessions/${encodeURIComponent(entry.family)}/revoke`;
            return `<tr data-session="${escapeHtml(entry.family)}"><th scope="row"><span data-i18n="${current ? "this-session" : "another-session"}">${current ? "This session" : "Another session"}</span>`
                + `<br><small data-text="session-clients">${entry.clients.map(escapeHtml).join(", ")}</small></th>`
                + `<td>${time(entry.createdAt)}</td><td>${time(entry.expiresAt)}</td>`
                + `<td><form method="post" action="${escapeHtml(action)}"><button type="submit" data-i18n="${current ? "end-this-session" : "revoke-session"}">${current ? "End this session" : "Revoke session"}</button></form></td></tr>`;
        }).join("");
        const others = sessions.some((entry) => entry.family !== family)
            ? '<form method="post" action="/account/sessions/revoke-others"><button type="submit" data-i18n="revoke-others">Revoke other sessions</button></form>' : "";
        const breadcrumb = '<nav aria-label="breadcrumb"><ul><li><a href="/account/" data-i18n="account">Account</a></li>'
            + '<li><span aria-current="page" data-i18n="sessions">Sessions</span></li></ul></nav>';
        return this.#render("Sessions", '<article aria-labelledby="sessions-title"><header><h1 id="sessions-title" data-i18n="sessions">Sessions</h1></header>'
            + '<figure><table><thead><tr><th scope="col" data-i18n="session">Session</th><th scope="col" data-i18n="started">Started</th>'
            + '<th scope="col" data-i18n="expires">Expires</th><th scope="col" data-i18n="actions">Actions</th></tr></thead>'
            + `<tbody>${entries}</tbody></table></figure>${others ? `<footer>${others}</footer>` : ""}</article>`, "account", true, breadcrumb);
    }

    /** @param {string} label @param {import("./directory-addresses.js").Directory} directory @param {boolean} [current] */
    #link(label, directory, current = false) {
        const path = directoryPath(directory);
        return path === null ? `<span data-text="name">${escapeHtml(label)}</span>`
            : `<a href="${escapeHtml(path)}" data-text="name"${directory.kind === "worker" ? ` data-worker-name="${escapeHtml(directory.worker)}" data-bind="href:worker-path"` : ""}${current ? ' aria-current="page"' : ""}>${escapeHtml(label)}</a>`;
    }

    /** @param {string | null} projectRoot */
    #workspaceMarker(projectRoot) {
        const folder = projectRoot !== null;
        return `<span role="img" aria-label="${folder ? "Project workspace" : "Folderless workspace"}">${folder ? "📁" : "☁️"}</span>`;
    }

    /** @param {import("./directory-addresses.js").Directory} directory @param {string} marker */
    #breadcrumbs(directory, marker) {
        const current = (/** @type {string} */ name) => `<span aria-current="page" data-text="name">${escapeHtml(name)}</span>`;
        const items = [directory.kind === "daemon" ? current("Workspaces") : this.#link("Workspaces", { kind: "daemon" })];
        if (directory.kind === "workspace") items.push(`${marker} ${current(directory.workspace)}`);
        if (directory.kind === "worker") {
            const path = directoryPath({ kind: "workspace", workspace: directory.workspace });
            if (path === null) throw new Error("An admitted worker must have a workspace directory address.");
            items.push(`<span id="worker-workspace">${marker} <a href="${escapeHtml(path)}" data-bind="href:workspace-path" data-text="workspace-name">${escapeHtml(directory.workspace)}</a></span>`, current(directory.worker));
        }
        return `<nav aria-label="breadcrumb"><ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul></nav>`;
    }

    /** {§web-worker-directory}
     * @param {import("@plurnk/plurnk-contracts").ApplicationWorkerProjection} worker
     * @param {ReadonlyMap<number, import("@plurnk/plurnk-contracts").ApplicationWorkerProjection>} workers
     */
    #parent(worker, workers) {
        if (worker.parentWorkerId === null) return null;
        const parent = workers.get(worker.parentWorkerId);
        if (parent === undefined) throw new Error(`Worker ${worker.id} has an absent parent ${worker.parentWorkerId}.`);
        return parent;
    }

    /** {§web-worker-directory}
     * @param {string} workspace
     * @param {ReadonlyMap<number, import("@plurnk/plurnk-contracts").ApplicationWorkerProjection>} workers
     * @param {import("@plurnk/plurnk-contracts").ApplicationWorkerProjection} [selected]
     */
    #workerTree(workspace, workers, selected) {
        const models = [...workers.values()].filter(({ origin }) => origin === "model");
        if (models.length === 0) return '<p data-i18n="no-workers">No workers.</p>';
        const children = Map.groupBy(models, ({ parentWorkerId }) => parentWorkerId);
        const lineage = new Set();
        for (let worker = selected ?? null; worker !== null; worker = this.#parent(worker, workers)) {
            if (lineage.has(worker.id)) throw new Error("Worker directory contains cyclic model parentage.");
            lineage.add(worker.id);
        }
        const background = models.filter((worker) => {
            const parent = this.#parent(worker, workers);
            return parent !== null && parent.origin !== "model";
        });
        let rendered = 0;
        /** @param {readonly import("@plurnk/plurnk-contracts").ApplicationWorkerProjection[]} entries @returns {string} */
        const list = (entries) => entries.length === 0 ? ""
            : `<ul>${entries.map((worker) => {
                rendered++;
                const descendants = children.get(worker.id) ?? [];
                const link = this.#link(worker.name, { kind: "worker", workspace, worker: worker.name }, worker.id === selected?.id);
                const facts = ` <small><span data-text="worker-kind">${escapeHtml(worker.kind)}</span> · <span data-text="worker-lifecycle">${escapeHtml(worker.lifecycle)}</span></small>`;
                const disclosure = descendants.length === 0 ? "" : `<details${lineage.has(worker.id) ? " open" : ""}><summary data-text="child-workers">`
                    + `${descendants.length} child worker${descendants.length === 1 ? "" : "s"}</summary>${list(descendants)}</details>`;
                return `<li>${link}${facts}${disclosure}</li>`;
            }).join("")}</ul>`;
        const roots = list(children.get(null) ?? []);
        const other = background.length === 0 ? "" : `<details${background.some(({ id }) => lineage.has(id)) ? " open" : ""}><summary data-i18n="background-work">Background work</summary>`
            + `${list(background)}</details>`;
        if (rendered !== models.length) throw new Error("Worker directory contains cyclic model parentage.");
        return roots + other;
    }

    /** {§web-worker-observer} Identity and navigation belong to the document; status arrives through AG-UI.
     * @param {import("./directory-addresses.js").Directory & {kind: "worker"}} directory @param {number} workspaceId @param {boolean} authenticated
     */
    #workerStatus(directory, workspaceId, authenticated) {
        const path = directoryPath(directory);
        if (path === null) throw new Error("An admitted worker must have a directory address.");
        const fields = [["lifecycle", "State"], ["model", "Model"], ["effort", "Effort"], ["loop", "Loop"], ["turns", "Turns"], ["elapsed", "Elapsed"],
            ["children", "Active direct children"], ["gated", "Descendants awaiting input"], ["context", "Context tokens / capacity"], ["curation", "Curation weight / budget"],
            ["requests", "Requests"], ["input", "Input tokens"], ["output", "Output tokens"], ["cost", "Cost (USD)"]];
        const accounting = [["input", "Input tokens"], ["output", "Output tokens"], ["total", "Total tokens"],
            ["uncached", "Uncached input"], ["cache-read", "Cache-read input"], ["cache-write", "Cache-write input"],
            ["text", "Text output"], ["reasoning", "Reasoning output"], ["cost", "Cost (USD)"]];
        return `<section id="worker-status" aria-label="Worker status" data-thread-id="${workspaceId}#${escapeHtml(directory.worker)}"`
            + ` data-worker-name="${escapeHtml(directory.worker)}" data-auth="${authenticated ? "session" : "none"}" data-yolo="${this.#yolo ? "1" : "0"}" data-reasoning-preview-chars="${this.#reasoningPreviewChars}" data-connection="initial">`
            + '<p role="status" data-text="connection-label">Not connected.</p><noscript><p data-i18n="live-status-needs-js">Live status requires JavaScript.</p></noscript>'
            + `<p><span data-i18n="approval-mode">Approvals:</span> <span data-text="approval-mode">${this.#yolo ? "Automatic" : "Manual"}</span></p>`
            + `<dl>${fields.map(([key, label]) => `<div><dt data-i18n="worker-${key}">${label}</dt><dd data-text="${key}">Unknown</dd></div>`).join("")}`
            + '<div><dt data-i18n="worker-wait">WAIT remaining</dt><dd><span data-text="wait">Unknown</span> <time data-text="wait-at" data-bind="datetime:wait-at"></time></dd></div></dl>'
            + '<details id="worker-descendants"><summary><span data-i18n="worker-descendants">Descendants:</span> <span data-text="descendants">Unknown</span></summary>'
            + '<p data-no-descendants data-i18n="no-descendants">No descendants.</p><ul></ul></details>'
            + '<details id="worker-accounting"><summary data-i18n="accounting-details">Accounting details</summary>'
            + '<p data-i18n="accounting-scope">Worker and descendants, cumulative since this worker began. Unknown totals remain unknown; known subtotals are incomplete evidence.</p>'
            + '<figure><table><thead><tr><th scope="col" data-i18n="quantity">Quantity</th><th scope="col" data-i18n="complete-total">Complete total</th><th scope="col" data-i18n="known-subtotal">Known subtotal</th></tr></thead><tbody>'
            + accounting.map(([key, label]) => `<tr><th scope="row" data-i18n="usage-${key}">${label}</th><td data-text="usage-${key}">Unknown</td><td data-text="known-${key}">Unknown</td></tr>`).join("") + '</tbody></table></figure></details>'
            + '<details id="workspace-activity"><summary data-i18n="workspace-activity">Workspace activity</summary>'
            + '<p><span data-i18n="preparing-capabilities">Capabilities preparing:</span> <span data-text="preparation-count">Unknown</span></p><ul data-preparation></ul>'
            + '<section data-derivation><dl><div><dt data-i18n="indexing-phase">Indexing</dt><dd data-text="activity-phase">Unknown</dd></div>'
            + '<div><dt data-i18n="indexing-completed">Completed / total</dt><dd data-text="activity-counts">Unknown</dd></div>'
            + '<div><dt data-i18n="indexing-percent">Percent</dt><dd data-text="activity-percent">Unknown</dd></div></dl><p data-text="activity-message"></p></section></details>'
            + '<details id="worker-inbox"><summary><span data-i18n="unobserved-messages">Unobserved messages:</span> <span data-text="inbox">Unknown</span></summary>'
            + '<p data-i18n="inbox-scope">Accepted messages the worker has not observed. Each retains the lifecycle of its receiving loop.</p><ol></ol></details>'
            + '<article role="alert"><header><span aria-hidden="true">⚠️</span> <span data-text="connection-label">Not connected.</span></header>'
            + '<p data-text="connection-detail">Displayed values are no longer live.</p>'
            + `<form id="worker-reconnect" action="${escapeHtml(path)}" data-bind="action:worker-path" data-reconnect><button type="submit" data-i18n="reconnect">Reconnect</button></form><p>`
            + `<a data-sign-in href="${escapeHtml(`/auth/login?return=${encodeURIComponent(path)}`)}" data-bind="href:sign-in-path" data-i18n="sign-in">Sign in</a>`
            + '</p></article></section>'
            + '<section id="worker-streams" aria-label="Executor streams">'
            + '<details><summary><span data-i18n="open-streams">Open streams:</span> <span data-text="stream-count">Unknown</span></summary>'
            + '<p data-no-streams data-i18n="no-open-streams">No open streams.</p><ul data-open-streams></ul></details>'
            + '<details data-stream-outcomes><summary data-i18n="stream-outcomes">Observed stream outcomes</summary>'
            + '<p data-i18n="stream-outcomes-scope">Conclusions observed on this page, not a complete execution history.</p><ol></ol></details></section>'
            + '<section id="worker-diagnostics" aria-label="Observed diagnostics"><p data-i18n="observed-diagnostics">Observed diagnostics</p><ol></ol></section>'
            + '<details id="worker-activity"><summary data-i18n="observed-activity">Observed activity</summary>'
            + '<p data-i18n="activity-scope">Non-conversation evidence observed on this page, not a complete history.</p><ol></ol></details>'
            + '<section id="worker-conversation" aria-label="Conversation">'
            + '<p data-empty-conversation data-i18n="no-messages">No messages.</p>'
            + '<noscript><p data-i18n="conversation-needs-js">Conversation requires JavaScript.</p></noscript>'
            + '<ol data-messages></ol></section>';
    }

    /**
     * @param {import("./directory-addresses.js").Directory} directory
     * @param {Pick<import("@plurnk/plurnk-contracts/port").ApplicationPort, "listWorkspaces" | "listWorkers">} port
     * @param {boolean} authenticated
     */
    async read(directory, port, authenticated) {
        const render = (/** @type {string} */ title, /** @type {string} */ body, marker = "") =>
            this.#render(title, body, directory.kind, authenticated, this.#breadcrumbs(directory, marker));
        const workspaces = await port.listWorkspaces();
        if (directory.kind === "daemon") {
            const items = workspaces.map(({ name, project_root }) =>
                `<li>${this.#workspaceMarker(project_root)} ${this.#link(name, { kind: "workspace", workspace: name })}</li>`).join("");
            return render("Workspaces", items ? `<ul>${items}</ul>` : '<p data-i18n="no-workspaces">No workspaces.</p>');
        }
        const workspace = workspaces.find(({ name }) => name === directory.workspace);
        if (workspace === undefined) return null;
        const workers = await port.listWorkers(workspace.id);
        const byId = new Map(workers.map((worker) => [worker.id, worker]));
        if (byId.size !== workers.length) throw new Error("Worker directory contains duplicate identities.");
        if (directory.kind === "workspace") {
            // {§web-workspace-folder}
            const separateFolder = workspace.project_label !== null && workspace.project_label !== workspace.name;
            const folder = separateFolder ? '<p><span role="img" aria-label="Project folder">📁</span> '
                + `<span data-text="project-label">${escapeHtml(workspace.project_label)}</span></p>` : "";
            const marker = separateFolder ? '<span role="img" aria-label="Workspace">☁️</span>' : this.#workspaceMarker(workspace.project_root);
            return render(workspace.name, folder + this.#workerTree(workspace.name, byId), marker);
        }
        const worker = workers.find(({ name, origin }) => name === directory.worker && origin === "model");
        if (worker === undefined) return null;
        const parent = this.#parent(worker, byId);
        const label = parent === null ? "" : parent.origin === "model"
            ? this.#link(parent.name, { kind: "worker", workspace: workspace.name, worker: parent.name })
            : `<span data-text="name">${escapeHtml(parent.name)}</span>`;
        const title = `${workspace.name}@${directory.worker}`;
        const tree = '<details id="worker-directory"><summary data-i18n="workers-at-page-load">Workers at page load</summary>'
            + `<nav aria-label="Workers">${this.#workerTree(workspace.name, byId, worker)}</nav></details>`;
        const folder = workspace.project_label !== null && workspace.project_label !== workspace.name ? workspace.project_label : "";
        const iconLabel = workspace.project_label === null ? "Folderless workspace" : folder ? "Workspace" : "Project workspace";
        const marker = `<span role="img" aria-label="${iconLabel}" data-bind="aria-label:workspace-icon-label" data-text="workspace-icon">${workspace.project_label !== null && !folder ? "📁" : "☁️"}</span>`;
        return render(title, `<p id="worker-folder" data-project-label="${escapeHtml(folder)}"><span role="img" aria-label="Project folder">📁</span> <span data-text="project-label">${escapeHtml(folder)}</span></p>`
            + (parent === null ? "" : `<p><span data-i18n="parent-worker">Parent:</span> ${label}</p>`)
            + tree + this.#workerStatus(directory, workspace.id, authenticated), marker);
    }
}
