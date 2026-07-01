import * as THREE from "three";

export type JstConnectorModel = {
  /** The connector mesh group, built in its own local frame. */
  group: THREE.Group;
  /**
   * Socket entry positions in the group's local frame (the points the three
   * wires plug into), ordered along +X.
   */
  socketLocal: THREE.Vector3[];
  /**
   * Empty anchors parented to the group at each socket entry, ordered along +X.
   * Wires resolve their tip from these each frame so they follow the connector
   * when it is repositioned/rotated.
   */
  socketAnchors: THREE.Object3D[];
  /** Empty anchors just outside each socket (along −Y) so wires stem out straight. */
  emergeAnchors: THREE.Object3D[];
  /** Extent along +Y — the axis the connector mounts along (the link exit normal). */
  depth: number;
};

export type JstConnectorMaterials = {
  plastic: THREE.Material;
  socket: THREE.Material;
};

/**
 * Canonical SO-101 wire JST connector. A single definition used for every
 * connector so they are all identical.
 *
 * Local frame:
 *   X = row of the three sockets
 *   Y = outward / mounting axis (aligned to the link's exit normal when placed)
 *   Z = body height
 * The body extends from the origin out along +Y; the three sockets sit on the
 * −Y face (the face the wires plug into).
 */
export function createJstConnectorModel(
  materials: JstConnectorMaterials,
): JstConnectorModel {
  const width = 0.0085; // X — socket row
  const depth = 0.006; // Y — outward (halved from 0.0095)
  const height = 0.0055; // Z — body thickness
  const socketSpacing = 0.0026;
  const socketRadius = 0.0011;

  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(width, depth, height),
    materials.plastic,
  );
  body.castShadow = false;
  body.receiveShadow = false;
  group.add(body);

  const socketLocal: THREE.Vector3[] = [];
  const socketAnchors: THREE.Object3D[] = [];
  const emergeAnchors: THREE.Object3D[] = [];
  const emergeLen = 0.004;
  [-socketSpacing, 0, socketSpacing].forEach((x) => {
    const socket = new THREE.Mesh(
      new THREE.CylinderGeometry(socketRadius, socketRadius, 0.0016, 14),
      materials.socket,
    );
    // Cylinder axis is Y by default, so the round opening faces −Y (the wire face).
    socket.position.set(x, -depth * 0.5 + 0.0007, 0);
    socket.castShadow = false;
    group.add(socket);
    socketLocal.push(new THREE.Vector3(x, -depth * 0.5, 0));

    const socketAnchor = new THREE.Object3D();
    socketAnchor.position.set(x, -depth * 0.5, 0);
    group.add(socketAnchor);
    socketAnchors.push(socketAnchor);

    const emergeAnchor = new THREE.Object3D();
    emergeAnchor.position.set(x, -depth * 0.5 - emergeLen, 0);
    group.add(emergeAnchor);
    emergeAnchors.push(emergeAnchor);
  });

  const latch = new THREE.Mesh(
    new THREE.BoxGeometry(width * 0.48, depth * 0.4, 0.0012),
    materials.plastic,
  );
  latch.position.set(0, depth * 0.1, height * 0.56);
  latch.castShadow = false;
  group.add(latch);

  return { group, socketLocal, socketAnchors, emergeAnchors, depth };
}
