# Crimson Banner

An original, standalone 3D musou-style crowd combat prototype inspired by the broad gameplay of Dynasty Warriors. Open `index.html` in a desktop browser with WebGL support. Keep `renderer3d.js` beside it. No dependencies, downloads, or build step. The previous overhead version is preserved in `prototype-2d.html`.

Move with WASD or arrow keys, relative to the camera. Q/E rotates the third-person camera; the mouse wheel zooms. J or left click performs a four-step sweeping combo; L performs a heavy attack; Space dodges; K or right click unleashes fury when its meter is full. P pauses. Attacks follow your last movement direction. Hold J to continue attacking.

Defeat the officer at each of three strongholds, then remain inside its circle to capture it. Officers telegraph their attacks with large orange circles. Defeated officers and captured strongholds restore health. The tactical map shows the player, enemies, and strongholds.

Implemented with a dependency-free WebGL renderer, Canvas 2D tactical map, and synthesized Web Audio. Features perspective projection, depth-tested low-poly soldiers and fortresses, animated strides and spear swings, distance fog, and 3D attack effects. Combat is ground-based, with procedural hit reactions. Original procedural art; no external assets. Desktop keyboard and mouse required.
