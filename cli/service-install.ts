// `acc daemon install-service` — write a systemd user unit (Linux) or launchd
// plist (macOS) so the daemon survives shell logout + reboot. The file is
// written; the operator is given the load command. We do NOT auto-load (the
// system-level path requires sudo, and we keep the surface user-respectful).
//
// Per Architecture.md, the daemon is the always-on substrate. This module is
// purely operator-side scaffolding — it does not touch the running daemon or
// the substrate; the load step is a manual operator action so they can audit
// the file before enabling it.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type ServiceInstallEnv = {
  platform: NodeJS.Platform;
  homedir: () => string;
  bunPath: string;        // absolute path to `bun` (process.execPath in production)
  daemonScript: string;   // absolute path to runtime/daemon.ts
  env: Record<string, string | undefined>;
  writer: (path: string, contents: string) => void;
};

export type ServiceInstallResult = {
  exitCode: number;
  outputs: string[];      // every line the CLI printed (for tests)
  unitPath?: string;
  unitContents?: string;
  loadCommand?: string;
};

const ENV_KEYS_TO_PROPAGATE = [
  "OPENAI_API_KEY",
  "ACC2_BRIDGE_MODE",
  "ACC2_STATE_DIR",
  "ACC2_DB_PATH",
  "ACC2_SOCKET_FILE",
  "ACC2_TOKEN_FILE",
  "V2_DAEMON_PORT",
  "V2_DAEMON_AUX_PORT",
  "CAMOUFOX_BINARY_PATH",
  "PATH",
];

const escapeSystemd = (v: string): string => v.replace(/[\\"]/g, "\\$&");
const escapePlist = (v: string): string => v
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export const defaultServiceInstallEnv = (): ServiceInstallEnv => ({
  platform: process.platform,
  homedir,
  bunPath: process.execPath,
  daemonScript: resolve(import.meta.dirname ?? ".", "..", "runtime", "daemon.ts"),
  env: process.env,
  writer: (path, contents) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, { mode: 0o644 });
  },
});

// ── Unit / plist builders ─────────────────────────────────────────────────

export const buildSystemdUnit = (env: ServiceInstallEnv, scope: "user" | "system"): string => {
  const envLines: string[] = [];
  for (const k of ENV_KEYS_TO_PROPAGATE) {
    const v = env.env[k];
    if (v !== undefined && v.length > 0) envLines.push(`Environment="${k}=${escapeSystemd(v)}"`);
  }
  const userBlock = scope === "system" ? `User=%i\n` : "";
  return `# AccInt v2 daemon — written by \`acc daemon install-service --${scope}\`
# Edit this file, then run:
#   ${scope === "user" ? "systemctl --user daemon-reload && systemctl --user enable --now accint" : "sudo systemctl daemon-reload && sudo systemctl enable --now accint"}

[Unit]
Description=AccInt v2 substrate daemon
After=network.target

[Service]
Type=simple
${userBlock}ExecStart=${env.bunPath} ${env.daemonScript}
Restart=on-failure
RestartSec=5
${envLines.join("\n")}

[Install]
WantedBy=${scope === "user" ? "default.target" : "multi-user.target"}
`;
};

export const buildLaunchdPlist = (env: ServiceInstallEnv): string => {
  const envEntries: string[] = [];
  for (const k of ENV_KEYS_TO_PROPAGATE) {
    const v = env.env[k];
    if (v !== undefined && v.length > 0) {
      envEntries.push(`        <key>${escapePlist(k)}</key>`);
      envEntries.push(`        <string>${escapePlist(v)}</string>`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.accint.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapePlist(env.bunPath)}</string>
    <string>${escapePlist(env.daemonScript)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapePlist(join(env.homedir(), "Library", "Logs", "accint.daemon.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(join(env.homedir(), "Library", "Logs", "accint.daemon.err.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries.join("\n")}
  </dict>
</dict>
</plist>
`;
};

// ── Driver ────────────────────────────────────────────────────────────────

export const installService = (argv: string[], envOverride?: ServiceInstallEnv): ServiceInstallResult => {
  const env = envOverride ?? defaultServiceInstallEnv();
  const outputs: string[] = [];
  const print = (s: string) => outputs.push(s);

  const scope: "user" | "system" = argv.includes("--system") ? "system" : "user";

  if (env.platform === "linux") {
    const unit = buildSystemdUnit(env, scope);
    const unitPath = scope === "user"
      ? join(env.homedir(), ".config", "systemd", "user", "accint.service")
      : "/etc/systemd/system/accint.service";
    try {
      env.writer(unitPath, unit);
    } catch (err) {
      print(`acc daemon install-service: failed to write ${unitPath}: ${(err as Error).message}`);
      if (scope === "system") {
        print("hint: --system writes to /etc/systemd/system and may require sudo; rerun under sudo or use --user");
      }
      return { exitCode: 1, outputs };
    }
    const loadCmd = scope === "user"
      ? "systemctl --user daemon-reload && systemctl --user enable --now accint"
      : "sudo systemctl daemon-reload && sudo systemctl enable --now accint";
    print(`wrote systemd ${scope} unit: ${unitPath}`);
    print(`load with:`);
    print(`  ${loadCmd}`);
    return { exitCode: 0, outputs, unitPath, unitContents: unit, loadCommand: loadCmd };
  }

  if (env.platform === "darwin") {
    const plist = buildLaunchdPlist(env);
    const plistPath = join(env.homedir(), "Library", "LaunchAgents", "com.accint.daemon.plist");
    try {
      env.writer(plistPath, plist);
    } catch (err) {
      print(`acc daemon install-service: failed to write ${plistPath}: ${(err as Error).message}`);
      return { exitCode: 1, outputs };
    }
    const loadCmd = `launchctl load ${plistPath}`;
    print(`wrote launchd plist: ${plistPath}`);
    print(`load with:`);
    print(`  ${loadCmd}`);
    return { exitCode: 0, outputs, unitPath: plistPath, unitContents: plist, loadCommand: loadCmd };
  }

  print(`acc daemon install-service: platform '${env.platform}' is not supported.`);
  print("The daemon survives shell logout via nohup or your preferred process manager.");
  return { exitCode: 1, outputs };
};

export const runServiceInstall = async (argv: string[]): Promise<number> => {
  const result = installService(argv);
  for (const line of result.outputs) console.log(line);
  return result.exitCode;
};

if (import.meta.main) {
  void runServiceInstall(process.argv.slice(2)).then((code) => process.exit(code));
}
