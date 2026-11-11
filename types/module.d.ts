import type { CredentialAuthority } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { DaemonModule } from "@plurnk/plurnk-modules";

export interface WebSetupPort {
    readonly credentials?: Pick<CredentialAuthority, "registerClient"> | null;
}

export type WebStartPort = Pick<
    ApplicationPort,
    | "registerHttpRoute"
    | "listWorkspaces"
    | "listSessions"
    | "createWorkspace"
    | "renameWorkspace"
    | "createSession"
    | "setWorkspaceArchived"
    | "setSessionArchived"
> & {
    readonly credentials?: Pick<
        CredentialAuthority,
        "verify" | "issue" | "revokeFamily" | "sessions" | "onRevoked" | "face"
    > | null;
    readonly readSessionOverview?: ApplicationPort["readSessionOverview"];
};

export default function createModule(): DaemonModule<WebSetupPort, WebStartPort>;
