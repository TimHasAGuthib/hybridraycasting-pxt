// model3d.ts
// ---------------------------------------------------------------------------
// Adds "3D model" sprites to the hybridraycasting-pxt engine: sprites that
// hold N pre-rendered view images spaced evenly around 360°, plus blocks to
// rotate and move them. Each frame, the correct view image is picked based
// on the angle between the model's own facing direction and the direction
// from the model to "myself" (the camera/player sprite) - the same
// technique classic raycasters (Doom, Wolf3D) use for rotating sprites,
// since the engine renders billboards, not true 3D meshes.
//
// DESIGN NOTE / WHY IT'S BUILT THIS WAY:
// The core engine already has a directional-image system
// (HybridRender.Animations / setSpriteAnimations), but it derives its
// "direction" from the sprite's *velocity vector*, meant for walk-cycle
// animations (facing the way you're walking). That's not usable for an
// object you want to spin in place independent of movement. Rather than
// reverse-engineer and hook into that internal, fixed-point-math code path,
// this file keeps its own independent facing state and only calls the
// engine's public, documented functions. That keeps this add-on isolated:
// if something's wrong, the bug is in this file, not in a misunderstanding
// of the core engine's internals.
//
// SETUP:
// 1. Add this file to your project (new file "model3d.ts", same folder as
//    main.ts / render_blocks.ts). If your project's pxt.json lists files
//    explicitly, add "model3d.ts" to its "files" array.
// 2. Call HybridRender's "set tilemap" block first, as usual, before
//    creating any model sprites.
// 3. Prepare your view images: use the built-in animation editor to draw N
//    images of your object as seen from N angles evenly spaced around a
//    full turn (N=8 is a good default: front, front-right, right,
//    back-right, back, back-left, left, front-left). Image[0] MUST be the
//    "front" view - the one visible when the object faces the camera.
// 4. TEST IN THE SIMULATOR. In particular check: the rotation direction
//    matches what you expect (see ROTATION_IS_CLOCKWISE below - flip it if
//    your model appears to rotate backwards), and that view images swap at
//    roughly the angle you'd expect as you walk around a stationary model.
// ---------------------------------------------------------------------------

/**
 * 3D-style rotatable/movable sprites for the raycasting engine.
 **/
//% color=#AA278D weight=1 icon="\uf1b3"
//% groups='["Create", "Rotate", "Move", "Info"]'
//% block="3D Model"
namespace Model3D {

    // Flip this to true if models appear to spin the wrong way once you
    // test it - depends on which way you drew your view images around the
    // object. Left as a single switch rather than guessed at, since I can't
    // see your source images.
    const ROTATION_IS_CLOCKWISE = true;

    class ModelState {
        views: Image[];
        facing: number = 0;      // radians, world space, 0 = pointing along +x
        spinSpeed: number = 0;   // radians / second, applied continuously
        lastIndex: number = -1;  // last view index shown, to skip redundant setImage calls
        constructor(views: Image[]) {
            this.views = views;
        }
    }

    // keyed by sprite.id
    const states: ModelState[] = [];

    function normalizeAngle(a: number): number {
        a = a % (Math.PI * 2);
        if (a < 0) a += Math.PI * 2;
        return a;
    }

    function degToRad(d: number): number { return d * Math.PI / 180; }
    function radToDeg(r: number): number { return r * 180 / Math.PI; }

    function getState(sprite: Sprite): ModelState {
        const s = states[sprite.id];
        if (!s) {
            // Sprite wasn't created with createModel / never had views set -
            // return a harmless default so blocks don't crash, but it won't
            // actually rotate visually until setModelViews is used.
            const fallback = new ModelState([sprite.image]);
            states[sprite.id] = fallback;
            return fallback;
        }
        return s;
    }

    /**
     * Create a new 3D model sprite with a set of rotation view images.
     * Image 1 (the first frame) must be the "front" view of the model.
     * Provide the views evenly spaced around a full turn - 8 is a good
     * default (every 45°); the minimum useful amount is 4.
     * @param x starting x position
     * @param y starting y position
     * @param views the rotation view images, front view first
     * @param kind sprite kind, defaults to the same as sprites.create()
     */
    //% blockId=model3d_create
    //% block="create 3D model at x $x y $y views $views=animation_editor||kind $kind=spritekind"
    //% expandableArgumentMode=toggle
    //% group="Create"
    //% weight=100
    export function createModel(x: number, y: number, views: Image[], kind?: number): Sprite {
        if (!views || views.length == 0) views = [image.create(16, 16)];
        const sprite = sprites.create(views[0], kind);
        sprite.setPosition(x, y);
        sprite.setScale(0.5);
        states[sprite.id] = new ModelState(views);
        sprite.onDestroyed(() => {
            states[sprite.id] = undefined;
        });
        // Register the sprite with the raycasting render right away, so it
        // doesn't draw at the wrong (2D) spot for up to 400ms while waiting
        // for the engine's own periodic takeover - this mirrors the pattern
        // documented on HybridRender's "takeover sprites in scene" block.
        HybridRender.takeoverSceneSprites();
        return sprite;
    }

    /**
     * Attach or replace the rotation view images on an existing sprite
     * (e.g. one made with the normal "create sprite" block).
     * Image 1 (the first frame) must be the "front" view of the model.
     * @param sprite the sprite to turn into a rotating 3D model
     * @param views the rotation view images, front view first
     */
    //% blockId=model3d_setViews
    //% block="set 3D model $sprite=variables_get(mySprite) views $views=animation_editor"
    //% group="Create"
    //% weight=90
    export function setModelViews(sprite: Sprite, views: Image[]) {
        if (!sprite || !views || views.length == 0) return;
        const existing = states[sprite.id];
        const state = new ModelState(views);
        if (existing) state.facing = existing.facing, state.spinSpeed = existing.spinSpeed;
        states[sprite.id] = state;
        sprite.onDestroyed(() => {
            states[sprite.id] = undefined;
        });
    }

    /**
     * Set the model's facing direction (absolute), in degrees. 0 = facing
     * along +x (screen right on an unrotated tilemap), increasing counter-
     * clockwise, matching Arcade's usual angle convention.
     * @param sprite the model sprite
     * @param degrees absolute facing angle, 0-360
     */
    //% blockId=model3d_setRotation
    //% block="set 3D model $sprite=variables_get(mySprite) rotation to $degrees °"
    //% degrees.min=0 degrees.max=360 degrees.defl=0
    //% group="Rotate"
    //% weight=100
    export function setModelRotation(sprite: Sprite, degrees: number) {
        const state = getState(sprite);
        state.facing = normalizeAngle(degToRad(degrees));
    }

    /**
     * Turn the model by a relative amount, in degrees. Positive turns
     * counter-clockwise.
     * @param sprite the model sprite
     * @param degrees amount to turn by, can be negative
     */
    //% blockId=model3d_rotate
    //% block="rotate 3D model $sprite=variables_get(mySprite) by $degrees °"
    //% degrees.defl=45
    //% group="Rotate"
    //% weight=90
    export function rotateModel(sprite: Sprite, degrees: number) {
        const state = getState(sprite);
        state.facing = normalizeAngle(state.facing + degToRad(degrees));
    }

    /**
     * Make the model spin continuously. Set to 0 to stop spinning.
     * @param sprite the model sprite
     * @param degreesPerSecond spin speed, positive = counter-clockwise
     */
    //% blockId=model3d_spin
    //% block="spin 3D model $sprite=variables_get(mySprite) at $degreesPerSecond °/s"
    //% degreesPerSecond.defl=90
    //% group="Rotate"
    //% weight=80
    export function spinModel(sprite: Sprite, degreesPerSecond: number) {
        const state = getState(sprite);
        state.spinSpeed = degToRad(degreesPerSecond);
    }

    /**
     * Get the model's current facing direction, in degrees (0-360).
     * @param sprite the model sprite
     */
    //% blockId=model3d_getRotation
    //% block="3D model $sprite=variables_get(mySprite) rotation"
    //% group="Info"
    //% weight=100
    export function getModelRotation(sprite: Sprite): number {
        return radToDeg(getState(sprite).facing);
    }

    /**
     * Move the model forward in the direction it's currently facing.
     * Sets velocity once, like the engine's other move blocks - if you
     * rotate the model afterwards, call this again to update direction.
     * @param sprite the model sprite
     * @param speed pixels per second, negative moves backward
     */
    //% blockId=model3d_moveForward
    //% block="move 3D model $sprite=variables_get(mySprite) forward at $speed=spriteSpeedPicker"
    //% group="Move"
    //% weight=100
    export function moveModelForward(sprite: Sprite, speed: number) {
        const state = getState(sprite);
        sprite.setVelocity(Math.cos(state.facing) * speed, -Math.sin(state.facing) * speed);
    }

    /**
     * Move the model sideways relative to the direction it's facing.
     * @param sprite the model sprite
     * @param speed pixels per second, positive strafes to the model's right
     */
    //% blockId=model3d_strafe
    //% block="move 3D model $sprite=variables_get(mySprite) sideways at $speed=spriteSpeedPicker"
    //% group="Move"
    //% weight=90
    export function strafeModel(sprite: Sprite, speed: number) {
        const state = getState(sprite);
        const perp = state.facing - Math.PI / 2;
        sprite.setVelocity(Math.cos(perp) * speed, -Math.sin(perp) * speed);
    }

    /**
     * Stop the model's movement (velocity), without changing its rotation.
     * @param sprite the model sprite
     */
    //% blockId=model3d_stop
    //% block="stop 3D model $sprite=variables_get(mySprite) movement"
    //% group="Move"
    //% weight=80
    export function stopModel(sprite: Sprite) {
        sprite.setVelocity(0, 0);
    }

    // ---- per-frame update: advance spin, pick + apply the right view ----
    // Once the raycasting render "takes over" a sprite, it pulls it out of
    // Arcade's normal game.currentScene().allSprites list and keeps its own
    // tracked lists instead (`sprites` for 3D-rendered sprites, `sprites2D`
    // for camera-relative/HUD ones). Those are the authoritative source for
    // "every sprite the render currently knows about", regardless of kind,
    // so this reads directly from there rather than guessing at kinds.
    game.onUpdate(function () {
        const my = HybridRender.getRenderSpriteInstance();
        if (!my) return;
        const dt = game.eventContext().deltaTime;
        if (states.length == 0) return;

        const render = HybridRender.getRCRenderInstance();
        const allSprites = render.sprites.concat(render.sprites2D);

        for (const sprite of allSprites) {
            if (!sprite) continue;
            const state = states[sprite.id];
            if (!state) continue;

            if (state.spinSpeed != 0) {
                const delta = ROTATION_IS_CLOCKWISE ? -state.spinSpeed : state.spinSpeed;
                state.facing = normalizeAngle(state.facing + delta * dt / 1000);
            }

            const dx = sprite.x - my.x;
            const dy = sprite.y - my.y;
            // direction from the model TO the camera
            const angleToCamera = Math.atan2(-dy, dx);
            // 0 = camera looking straight at the model's front view
            let relative = normalizeAngle(state.facing - angleToCamera + Math.PI);
            if (!ROTATION_IS_CLOCKWISE) relative = normalizeAngle(-relative);

            const count = state.views.length;
            const index = Math.round((relative / (Math.PI * 2)) * count) % count;
            if (index != state.lastIndex) {
                sprite.setImage(state.views[index]);
                state.lastIndex = index;
            }
        }
    });
}
