const segment = (value: string): string => encodeURIComponent(value);

export const sessionHref = (workspace: string, threadId: string): string =>
  `/${segment(workspace)}/${segment(threadId)}`;

export const workspaceHref = (
  workspace: string,
  constrainedThreadId: string | undefined,
): string => constrainedThreadId === undefined
  ? `/${segment(workspace)}`
  : sessionHref(workspace, constrainedThreadId);

export const newWorkerHref = (workspace: string): string => `/${segment(workspace)}`;
