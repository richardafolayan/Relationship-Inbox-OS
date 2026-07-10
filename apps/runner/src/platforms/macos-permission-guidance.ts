export function permissionRequesterName(env: NodeJS.ProcessEnv = process.env): string {
  return env.RIOS_DESKTOP === "1" ? "Relationship Inbox OS" : "your terminal app";
}

export function fullDiskAccessGuidance(env: NodeJS.ProcessEnv = process.env): string {
  const requester = permissionRequesterName(env);
  return `Cannot read the local Messages database. Open System Settings > Privacy & Security > Full Disk Access, turn on ${requester}, quit and reopen the app, then retry.`;
}

export function automationGuidance(env: NodeJS.ProcessEnv = process.env): string {
  const requester = permissionRequesterName(env);
  return `Messages did not allow Automation. Open System Settings > Privacy & Security > Automation, turn on Messages under ${requester}, return here, then retry the send.`;
}

export function accessibilityGuidance(env: NodeJS.ProcessEnv = process.env): string {
  const requester = permissionRequesterName(env);
  return `Sending this attachment needs Accessibility. Open System Settings > Privacy & Security > Accessibility, turn on ${requester}, return here, then retry the send.`;
}
