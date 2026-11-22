import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { DaemonModule } from "@plurnk/plurnk-modules";

export interface MermaidCredentialVerifier {
    verify(token: string): Promise<unknown> | unknown;
    face(): unknown;
}

export interface WebModulePort {
    readonly registerHttpRoute: ApplicationPort["registerHttpRoute"];
    readonly credentials?: MermaidCredentialVerifier | null;
}

export default function createModule(): DaemonModule<unknown, WebModulePort>;
