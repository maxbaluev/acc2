import type { Database } from "bun:sqlite";
import type { JsonValue } from "../substrate/types";
import { emitEvent } from "./events";

export type PeerKind = "opencode" | "claude_terminal" | "claude_agent";
export type PeerSpawnability = "substrate_spawnable" | "externally_launched";

export type PeerRegistration = {
  peer_id: string;
  kind: PeerKind;
  spawnability: PeerSpawnability;
  directive_id?: string | null;
  task_id?: string | null;
  current_act_id?: string | null;
  scope?: JsonValue;
  git_head?: string | null;
  metadata?: JsonValue;
};

export type PeerActivity = {
  peer_id: string;
  kind?: PeerKind;
  spawnability?: PeerSpawnability;
  directive_id?: string | null;
  task_id?: string | null;
  current_act_id?: string | null;
  scope?: JsonValue;
  git_head?: string | null;
  metadata?: JsonValue;
};

const originForPeer = (kind?: PeerKind): string => {
  if (kind === "opencode") return "opencode";
  if (kind === "claude_agent") return "claude_agent";
  return "claude_root";
};

export const registerPeer = (db: Database, registration: PeerRegistration): { id: string; ts: string } => {
  const emitted = emitEvent(db, {
    kind: "peer_registered",
    substrate_origin: originForPeer(registration.kind),
    directive_id: registration.directive_id ?? undefined,
    task_id: registration.task_id ?? undefined,
    payload: {
      ...registration,
      id: registration.peer_id,
      scope: registration.scope ?? {},
    } as JsonValue,
    invoker: originForPeer(registration.kind),
  });
  return { id: emitted.id, ts: emitted.ts };
};

export const peerActivity = (db: Database, activity: PeerActivity): { id: string; ts: string } => {
  const emitted = emitEvent(db, {
    kind: "peer_liveness",
    substrate_origin: originForPeer(activity.kind),
    directive_id: activity.directive_id ?? undefined,
    task_id: activity.task_id ?? undefined,
    payload: {
      ...activity,
      id: activity.peer_id,
      scope: activity.scope ?? {},
    } as JsonValue,
    invoker: originForPeer(activity.kind),
  });
  return { id: emitted.id, ts: emitted.ts };
};

export const heartbeatPeer = peerActivity;
