const SAFE_WINDOWS_NPM_ARGUMENT = /^[A-Za-z0-9@._/:=+\\-]+$/;

export function planNpmInvocation(platform, args, env = process.env) {
  if (platform !== "win32") {
    return { command: "npm", args: [...args] };
  }

  for (const value of args) {
    if (!SAFE_WINDOWS_NPM_ARGUMENT.test(value)) {
      throw new Error(`Unsafe npm argument for cmd.exe: ${value}`);
    }
  }
  return {
    command: env.ComSpec || env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", ["npm.cmd", ...args].join(" ")]
  };
}
