/**
 * React bindings for the WebRTC peer mesh. A separate entrypoint so apps that
 * never use WebRTC do not ship it.
 *
 * ```tsx
 * <SyncProvider client={client}>
 *   <PeerMeshProvider>
 *     <Cursors />   // useEphemeral frames now go peer-to-peer
 *     <Huddle />    // useCall()
 *   </PeerMeshProvider>
 * </SyncProvider>
 * ```
 */

import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { createPeerMesh } from "../client/webrtc.ts";
import type {
	CallState,
	PeerInfo,
	PeerMesh,
	PeerMeshConfig,
	PeerMeshSnapshot,
} from "../client/webrtc.ts";
import { useSyncClient } from "./context.tsx";

const PeerMeshContext = createContext<PeerMesh | null>(null);

export interface PeerMeshProviderProps extends PeerMeshConfig {
	children: ReactNode;
}

/**
 * Attaches a peer mesh to the surrounding `SyncProvider`'s client for as long
 * as it is mounted. Config is read once, at mount.
 */
export function PeerMeshProvider({ children, ...config }: PeerMeshProviderProps): ReactNode {
	const client = useSyncClient();
	const [mesh, setMesh] = useState<PeerMesh | null>(null);

	useEffect(() => {
		// No RTCPeerConnection during SSR or in an old browser: stay on the server path.
		if (!config.RTCPeerConnection && typeof globalThis.RTCPeerConnection === "undefined") return;
		const created = createPeerMesh(client, config);
		setMesh(created);
		return () => {
			created.destroy();
			setMesh(null);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [client]);

	return <PeerMeshContext.Provider value={mesh}>{children}</PeerMeshContext.Provider>;
}

/** The mesh, or null before it attaches (first render, SSR, no WebRTC support). */
export function usePeerMesh(): PeerMesh | null {
	return useContext(PeerMeshContext);
}

const EMPTY: PeerMeshSnapshot = { peers: [], call: null };
const noop = () => () => {};

function useMeshSnapshot(): PeerMeshSnapshot {
	const mesh = usePeerMesh();
	return useSyncExternalStore(
		mesh ? mesh.subscribe : noop,
		() => mesh?.getSnapshot() ?? EMPTY,
		() => EMPTY,
	);
}

/** Every peer announcing in this client's rooms, and how each is reached. */
export function usePeers(): PeerInfo[] {
	return useMeshSnapshot().peers;
}

export interface UseCallResult {
	/** Null until joined. */
	call: CallState | null;
	/** How many peers are in the call, whether or not this client has joined. */
	inCall: number;
	join(source?: MediaStreamConstraints | MediaStream): Promise<void>;
	leave(): void;
	shareScreen(source?: MediaStream): Promise<void>;
	stopScreen(): void;
	setMuted(muted: { audio?: boolean; video?: boolean }): void;
}

const unavailable = () => Promise.reject(new Error("reflectdb webrtc: no peer mesh is attached"));

/** The room's call: join, leave, mute, share a screen, and the participants' streams. */
export function useCall(): UseCallResult {
	const mesh = usePeerMesh();
	const snapshot = useMeshSnapshot();
	return {
		call: snapshot.call,
		inCall: snapshot.peers.filter((peer) => peer.inCall).length,
		join: mesh ? mesh.call : unavailable,
		leave: mesh ? mesh.leave : () => {},
		shareScreen: mesh ? mesh.shareScreen : unavailable,
		stopScreen: mesh ? mesh.stopScreen : () => {},
		setMuted: mesh ? mesh.setMuted : () => {},
	};
}

export type {
	CallParticipant,
	CallState,
	PeerInfo,
	PeerMesh,
	PeerMeshConfig,
	PeerState,
	StreamKind,
} from "../client/webrtc.ts";
