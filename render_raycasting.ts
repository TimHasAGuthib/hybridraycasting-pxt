//% shim=pxt::updateScreen
function updateScreen(img: Image) { }

enum ViewMode {
    //% block="TileMap Mode"
    tilemapView,
    //% block="Raycasting Mode"
    raycastingView,
}

namespace HybridRender {
    const SH = screen.height, SHHalf = SH / 2
    const SW = screen.width, SWHalf = SW / 2
    const fpx = 8
    const fpx_scale = 2 ** fpx
    function tofpx(n: number) { return (n * fpx_scale) | 0 }
    const one = 1 << fpx
    const one2 = 1 << (fpx + fpx)
    const FPX_MAX = (1 << fpx) - 1

    class MotionSet1D {
        p: number
        v: number = 0
        a: number = 0
        constructor(public offset: number) {
            this.p = offset
        }
    }

    export const defaultFov = SW / SH / 2  //Wall just fill screen height when standing 1 tile away

    // Default Arcade palette RGB values, used to compute physically correct darkened
    // colors. If your project uses a custom palette (Project Settings > Colors),
    // update these to match, or multi-colored textures will darken toward the wrong hues.
    const paletteRGB: number[][] = [
        [0, 0, 0],
        [255, 255, 255],
        [255, 33, 33],
        [255, 147, 196],
        [255, 129, 53],
        [255, 246, 9],
        [36, 156, 163],
        [120, 220, 82],
        [0, 63, 173],
        [135, 242, 255],
        [142, 46, 196],
        [164, 131, 159],
        [92, 64, 108],
        [229, 205, 196],
        [145, 70, 61],
        [0, 0, 0]
    ]

    // Number of discrete brightness steps between pitch black and full brightness.
    // Higher = smoother gradient, at the cost of a slightly larger one-time lookup table.
    const DARK_LEVELS = 24

    // darkLevelTable[level][originalColorIndex] = best-matching palette index for that
    // color at that brightness level. Built once by blending each palette color toward
    // black and snapping to the closest real palette entry, so hues stay correct instead
    // of drifting to unrelated colors the way shifting the raw index number would.
    function buildDarkLevelTable(): number[][] {
        const table: number[][] = []
        for (let level = 0; level < DARK_LEVELS; level++) {
            const brightness = level / (DARK_LEVELS - 1)
            const row: number[] = []
            for (let c = 0; c < 16; c++) {
                const src = paletteRGB[c]
                const targetR = src[0] * brightness
                const targetG = src[1] * brightness
                const targetB = src[2] * brightness
                let best = c
                let bestDist = 1e9
                for (let p = 1; p < 16; p++) { // never remap onto index 0 (transparent)
                    const cand = paletteRGB[p]
                    const dr = cand[0] - targetR
                    const dg = cand[1] - targetG
                    const db = cand[2] - targetB
                    const d = dr * dr + dg * dg + db * db
                    if (d < bestDist) {
                        bestDist = d
                        best = p
                    }
                }
                row.push(best)
            }
            table.push(row)
        }
        return table
    }

    let darkLevelTable: number[][] = null

    // 4x4 ordered (Bayer) dither matrix, values 0..15. Used to blend between two
    // adjacent brightness levels pixel-by-pixel, so darkness appears to fade smoothly
    // instead of snapping the whole surface to one flat palette color at a time.
    const bayer4x4 = [
        0, 8, 2, 10,
        12, 4, 14, 6,
        3, 11, 1, 9,
        15, 7, 13, 5
    ]

    // Safety cap on how many walls a single ray is allowed to march through when
    // punching through transparent tiles (fences, windows...). Bounds worst-case
    // cost per column if someone builds a corridor entirely out of see-through tiles.
    const MAX_HITS_PER_COLUMN = 4

    // ===================== 3D models as sprites =====================
    //
    // A lightweight flat-shaded polygon mesh that can be attached to a
    // normal Sprite so it renders as a real, rotatable solid instead of a
    // flat billboard image - think low-poly PS1/N64-era props (crates,
    // pillars, trees...) sitting inside the raycast world.
    //
    // Coordinate convention (all plain numbers, in pixels):
    //   x - left(-) / right(+), rotated by the model's yaw
    //   y - down(-) / up(+), NOT affected by yaw (vertical axis)
    //   z - back(-) / forward(+), rotated by the model's yaw
    // The origin (0,0,0) sits at the sprite's horizontal center, at ground
    // height - the same point a normal billboard sprite's bottom edge
    // would occupy. This mirrors how sprite width/height are already
    // pixel-based in this engine, while horizontal *position* is tile-based.
    //
    // Faces must be planar and convex (triangles or quads are the common
    // case) and are simply flat-filled - there are no per-pixel normals or
    // texture-mapped faces, matching the resolution/perf budget of the
    // rest of this renderer.
    export interface ModelVertex {
        x: number
        y: number
        z: number
    }

    export interface ModelFace {
        // indices into the model's vertices array; 3 for a triangle, 4 for
        // a quad, etc. Winding order does not matter - faces are drawn with
        // a painter's algorithm (farthest first) rather than backface culled.
        indices: number[]
        color: number
        // optional extra multiplier (0..1) applied on top of the normal
        // distance-based darkening, to fake per-face lighting - e.g. give a
        // box's top face a higher shade than its sides.
        shade?: number
    }

    export class Model3D {
        constructor(
            public vertices: ModelVertex[],
            public faces: ModelFace[]
        ) { }
    }

    // A couple of ready-made low-poly primitives so you don't have to
    // hand-type vertex lists to get started.
    export namespace Model3DBuilder {
        // Axis-aligned box centered horizontally on the sprite anchor,
        // sitting on the ground (y=0 is the bottom face, y=height is the top).
        export function box(width: number, depth: number, height: number, color: number): Model3D {
            const hw = width / 2, hd = depth / 2
            const v: ModelVertex[] = [
                { x: -hw, y: 0, z: -hd }, { x: hw, y: 0, z: -hd }, { x: hw, y: 0, z: hd }, { x: -hw, y: 0, z: hd },
                { x: -hw, y: height, z: -hd }, { x: hw, y: height, z: -hd }, { x: hw, y: height, z: hd }, { x: -hw, y: height, z: hd },
            ]
            const f: ModelFace[] = [
                { indices: [4, 5, 6, 7], color: color, shade: 1 },     // top
                { indices: [1, 0, 3, 2], color: color, shade: 0.55 },  // bottom
                { indices: [0, 1, 5, 4], color: color, shade: 0.85 },  // front (-z)
                { indices: [2, 3, 7, 6], color: color, shade: 0.85 },  // back (+z)
                { indices: [3, 0, 4, 7], color: color, shade: 0.7 },   // left (-x)
                { indices: [1, 2, 6, 5], color: color, shade: 0.7 },   // right (+x)
            ]
            return new Model3D(v, f)
        }

        // 4-sided pyramid, base centered on the sprite anchor at y=0, apex at y=height.
        export function pyramid(base: number, height: number, color: number): Model3D {
            const h = base / 2
            const v: ModelVertex[] = [
                { x: -h, y: 0, z: -h }, { x: h, y: 0, z: -h }, { x: h, y: 0, z: h }, { x: -h, y: 0, z: h },
                { x: 0, y: height, z: 0 },
            ]
            const f: ModelFace[] = [
                { indices: [1, 0, 3, 2], color: color, shade: 0.55 },
                { indices: [0, 1, 4], color: color, shade: 0.9 },
                { indices: [1, 2, 4], color: color, shade: 0.8 },
                { indices: [2, 3, 4], color: color, shade: 0.9 },
                { indices: [3, 0, 4], color: color, shade: 0.7 },
            ]
            return new Model3D(v, f)
        }
    }
    // =================== end 3D models as sprites ===================

    export class RayCastingRender {
        private tempScreen: Image = image.create(SW, SH)
        public darknessMod = 1
        public textureVisibility = 1

        velocityAngle: number = 2
        velocity: number = 3
        protected _viewMode = ViewMode.raycastingView
        protected dirXFpx: number
        protected dirYFpx: number
        protected planeX: number
        protected planeY: number
        protected _angle: number
        protected _fov: number
        protected _wallZScale: number = 1
        cameraSway = 0
        protected isWalking = false
        protected cameraOffsetX = 0
        protected cameraOffsetZ_fpx = 0

        //sprites & accessories
        sprSelf: Sprite
        protected hasCustomSelfImage = false
        sprites: Sprite[] = []
        sprites2D: Sprite[] = []
        spriteParticles: particles.ParticleSource[] = []
        spriteLikes: SpriteLike[] = []
        spriteAnimations: Animations[] = []
        protected spriteMotionZ: MotionSet1D[] = []

        // 3D models attached to sprites (see "3D models as sprites" above),
        // indexed by sprite id, same pattern as spriteAnimations/spriteMotionZ.
        protected spriteModels: Model3D[] = []
        protected spriteModelScale: number[] = []
        protected spriteModelYaw: number[] = []
        // scratch buffers reused every model draw to avoid per-frame GC churn;
        // sized on demand in drawModel3D, indexed by vertex index within
        // whichever model is currently being drawn
        private modelScreenX: number[] = []
        private modelScreenY: number[] = []
        private modelDepth: number[] = []
        private modelFaceOrder: number[] = []
        protected sayRederers: sprites.BaseSpriteSayRenderer[] = []
        protected sayEndTimes: number[] = []

        //reference
        protected tilemapScaleSize = 1 << TileScale.Sixteen
        map: tiles.TileMapData
        bg: Image
        textures: Image[]
        ceilingTextures: Image[]
        protected oldRender: scene.Renderable
        protected myRender: scene.Renderable
        protected _ceilingMap: tiles.TileMapData

        // Cache of whether each texture index contains any transparent (index 0)
        // pixel. Populated lazily, per tile, the first time that tile is actually hit
        // by a ray (see textureHasTransparency) — never precomputed for the whole
        // tileset up front, so it can't have stale/missing entries for tiles that
        // weren't part of the tileset yet at load time.
        hasTransparency: boolean[] = []

        // Returns (and caches) whether the given texture index has any transparent
        // pixel. Used by wall marching to decide whether to keep looking for what's
        // behind a hit.
        private textureHasTransparency(color: number): boolean {
            let flag = this.hasTransparency[color]
            if (flag === undefined) {
                const t = this.textures[color]
                flag = false
                if (t) {
                    for (let ty = 0; ty < t.height && !flag; ty++) {
                        for (let tx = 0; tx < t.width && !flag; tx++) {
                            if (t.getPixel(tx, ty) == 0) {
                                flag = true
                            }
                        }
                    }
                }
                this.hasTransparency[color] = flag
            }
            return flag
        }

        // preallocated, reused every column: the stack of wall hits found while
        // marching a ray past transparent tiles, nearest hit stored at index 0
        private hitMapX: number[] = []
        private hitMapY: number[] = []
        private hitSide: boolean[] = []
        private hitColor: number[] = []

        //render
        protected wallHeightInView: number
        protected wallWidthInView: number
        protected dist: number[] = []
        protected tilemapRows: number
        protected tilemapCols: number

        //render perf const
        cameraRangeAngle: number
        viewZPos: number
        selfXFpx: number
        selfYFpx: number

        //for drawing sprites
        protected invDet: number //required for correct matrix multiplication
        camera: scene.Camera
        tempSprite: Sprite = sprites.create(img`0`)
        protected transformX: number[] = []
        protected transformY: number[] = []
        protected angleSelfToSpr: number[] = []

        onSpriteDirectionUpdateHandler: (spr: Sprite, dir: number) => void

        get xFpx(): number {
            return Fx.add(this.sprSelf._x, Fx.div(this.sprSelf._width, Fx.twoFx8)) as any as number / this.tilemapScaleSize
        }

        // set xFpx(v: number) {
        //     this.sprSelf._x = v * this.tilemapScaleSize as any as Fx8
        // }

        get yFpx(): number {
            return Fx.add(this.sprSelf._y, Fx.div(this.sprSelf._height, Fx.twoFx8)) as any as number / this.tilemapScaleSize
        }

        // set yFpx(v: number) {
        //     this.sprSelf._y = v * this.tilemapScaleSize as any as Fx8
        // }

        get dirX(): number {
            return this.dirXFpx / fpx_scale
        }

        get dirY(): number {
            return this.dirYFpx / fpx_scale
        }

        set dirX(v: number) {
            this.dirXFpx = v * fpx_scale
        }

        set dirY(v: number) {
            this.dirYFpx = v * fpx_scale
        }

        sprXFx8(spr: Sprite) {
            return Fx.add(spr._x, Fx.div(spr._width, Fx.twoFx8)) as any as number / this.tilemapScaleSize
        }

        sprYFx8(spr: Sprite) {
            return Fx.add(spr._y, Fx.div(spr._height, Fx.twoFx8)) as any as number / this.tilemapScaleSize
        }

        get fov(): number {
            return this._fov
        }

        set fov(fov: number) {
            this._fov = fov
            this.wallHeightInView = (SW << (fpx - 1)) / this._fov
            this.wallWidthInView = this.wallHeightInView >> fpx // not fpx  // wallSize / this.fov * 4 / 3 * 2
            this.cameraRangeAngle = Math.atan(this.fov) + .1 //tolerance for spr center just out of camera

            this.setVectors()
        }

        get viewAngle(): number {
            return this._angle
        }
        set viewAngle(angle: number) {
            this._angle = angle
            this.setVectors()
            this.updateSelfImage()
        }

        get wallZScale(): number {
            return this._wallZScale
        }
        set wallZScale(v: number) {
            this._wallZScale = v
        }

        get ceilingMap(): tiles.TileMapData {
            return this._ceilingMap
        }
        set ceilingMap(ceilingMap: tiles.TileMapData) {
            this._ceilingMap = ceilingMap
        }

        // Converts a distance into a 0..1 brightness value. Clamped to 1 at dis=0, so
        // close-up surfaces never appear brighter than the original texture.
        brightnessAt(dis: number): number {
            return Math.constrain((1 - dis / this.darknessMod) * this.textureVisibility, 0, 1)
        }

        // Darkens a single color for a given brightness, dithered against the screen
        // pixel it's being drawn to. Rather than snapping the whole surface to one flat
        // palette color per distance, this blends between the two nearest brightness
        // levels using a Bayer pattern, so darkness fades smoothly pixel-by-pixel
        // instead of banding in hard steps. Hue is preserved via the precomputed
        // nearest-palette-color table (see buildDarkLevelTable).
        ditheredColor(rawColor: number, brightness: number, screenX: number, screenY: number): number {
            if (rawColor == 0) return 0 // never darken transparency itself
            if (!darkLevelTable) darkLevelTable = buildDarkLevelTable()
            const level = brightness * (DARK_LEVELS - 1)
            const levelLow = level | 0 // floor
            const frac = level - levelLow
            const levelHigh = levelLow + 1 < DARK_LEVELS ? levelLow + 1 : levelLow
            const threshold = bayer4x4[(screenY & 3) * 4 + (screenX & 3)] / 16
            const chosenLevel = frac > threshold ? levelHigh : levelLow
            return darkLevelTable[chosenLevel][rawColor]
        }

        getMotionZ(spr: Sprite, offsetZ: number = 0) {
            let motionZ = this.spriteMotionZ[spr.id]
            if (!motionZ) {
                motionZ = new MotionSet1D(tofpx(offsetZ))
                this.spriteMotionZ[spr.id] = motionZ
            }
            return motionZ
        }

        getZOffset(spr: Sprite) {
            return this.getMotionZ(spr).offset / fpx_scale
        }

        setZOffset(spr: Sprite, offsetZ: number, duration: number = 500) {
            const motionZ = this.getMotionZ(spr, offsetZ)

            motionZ.offset = tofpx(offsetZ)
            if (motionZ.p != motionZ.offset) {
                if (duration === 0)
                    motionZ.p = motionZ.offset
                else if (motionZ.v == 0)
                    this.move(spr, (motionZ.offset - motionZ.p) / fpx_scale * 1000 / duration, 0)
            }
        }

        getMotionZPosition(spr: Sprite) {
            return this.getMotionZ(spr).p / fpx_scale
        }

        //todo, use ZHeight(set from sprite.Height when takeover, then sprite.Height will be replace with width)
        isOverlapZ(sprite1: Sprite, sprite2: Sprite): boolean {
            const p1 = this.getMotionZPosition(sprite1)
            const p2 = this.getMotionZPosition(sprite2)
            if (p1 < p2) {
                if (p1 + sprite1.height > p2) return true
            } else {
                if (p2 + sprite2.height > p1) return true
            }
            return false
        }

        move(spr: Sprite, v: number, a: number) {
            const motionZ = this.getMotionZ(spr)

            motionZ.v = tofpx(v)
            motionZ.a = tofpx(a)
        }

        jump(spr: Sprite, v: number, a: number) {
            const motionZ = this.getMotionZ(spr)
            if (motionZ.p != motionZ.offset)
                return

            motionZ.v = tofpx(v)
            motionZ.a = tofpx(a)
        }

        jumpWithHeightAndDuration(spr: Sprite, height: number, duration: number) {
            const motionZ = this.getMotionZ(spr)
            if (motionZ.p != motionZ.offset)
                return

            // height= -v*v/a/2
            // duration = -v/a*2 *1000
            const v = height * 4000 / duration
            const a = -v * 2000 / duration
            motionZ.v = tofpx(v)
            motionZ.a = tofpx(a)
        }

        get viewMode(): ViewMode {
            return this._viewMode
        }

        set viewMode(v: ViewMode) {
            this._viewMode = v
        }

        updateViewZPos() {
            this.viewZPos = this.spriteMotionZ[this.sprSelf.id].p + (this.sprSelf._height as any as number) - (2 << fpx)
        }

        takeoverSceneSprites() {
            const sc_allSprites = game.currentScene().allSprites
            for (let i = 0; i < sc_allSprites.length;) {
                const spr = sc_allSprites[i]
                if (spr instanceof Sprite) {
                    const sprList = (spr.flags & sprites.Flag.RelativeToCamera) ? this.sprites2D : this.sprites
                    if (sprList.indexOf(spr) < 0) {
                        sprList.push(spr as Sprite)
                        this.getMotionZ(spr, 0)
                        spr.onDestroyed(() => {
                            this.sprites.removeElement(spr as Sprite)   //can be in one of 2 lists
                            this.sprites2D.removeElement(spr as Sprite) //can be in one of 2 lists
                            const sayRenderer = this.sayRederers[spr.id]
                            if (sayRenderer) {
                                this.sayRederers.removeElement(sayRenderer)
                                sayRenderer.destroy()
                            }
                            this.spriteModels[spr.id] = undefined
                        })
                    }
                } else if (spr instanceof particles.ParticleSource) {
                    const particle = (spr as particles.ParticleSource)
                    if (this.spriteParticles.indexOf(particle) < 0) {
                        this.spriteParticles[(particle.anchor as Sprite).id] = particle
                        particle.anchor = this.tempSprite
                    }
                } else {
                    if (this.spriteLikes.indexOf(spr) < 0)
                        this.spriteLikes.push(spr)
                }
                sc_allSprites.removeElement(spr)
            }
            this.sprites.forEach((spr) => {
                if (spr)
                    this.takeoverSayRenderOfSprite(spr)
            })
        }
        takeoverSayRenderOfSprite(sprite: Sprite) {
            const sprite_as_any = (sprite as any)
            if (sprite_as_any.sayRenderer) {
                this.sayRederers[sprite.id] = sprite_as_any.sayRenderer
                this.sayEndTimes[sprite.id] = sprite_as_any.sayEndTime;
                sprite_as_any.sayRenderer = undefined
                sprite_as_any.sayEndTime = undefined
            }
        }

        tilemapLoaded() {
            const sc = game.currentScene()
            this.map = sc.tileMap.data
            this.textures = sc.tileMap.data.getTileset()
            this.hasTransparency = [] // reset lazy transparency cache for the new tileset
            this.tilemapScaleSize = 1 << sc.tileMap.data.scale
            this.oldRender = sc.tileMap.renderable
            this.spriteLikes.removeElement(this.oldRender)
            sc.allSprites.removeElement(this.oldRender)

            let frameCallback_update = sc.eventContext.registerFrameHandler(scene.PRE_RENDER_UPDATE_PRIORITY + 1, () => {
                const dt = sc.eventContext.deltaTime;
                // sc.camera.update();  // already did in scene
                for (const s of this.sprites)
                    s.__update(sc.camera, dt);
                this.sprSelf.__update(sc.camera, dt)
            })

            let frameCallback_draw = sc.eventContext.registerFrameHandler(scene.RENDER_SPRITES_PRIORITY + 1, () => {
                if (this._viewMode == ViewMode.tilemapView) {
                    // screen.drawImage(sc.background.image, 0, 0)
                    this.oldRender.__drawCore(sc.camera)
                    this.sprites.forEach(spr => spr.__draw(sc.camera))
                    this.sprSelf.__draw(sc.camera)
                } else {
                    //   this.tempScreen.drawImage(sc.background.image, 0, 0)
                    //debug
                    // const ms=control.micros()
                    this.render()
                    // info.setScore(control.micros()-ms)
                    screen.fill(0)
                }
                this.sprites2D.forEach(spr => spr.__draw(sc.camera))
                this.spriteLikes.forEach(spr => spr.__draw(sc.camera))
                if (this._viewMode == ViewMode.raycastingView)
                    this.tempScreen.drawTransparentImage(screen, 0, 0)
            })

            sc.tileMap.addEventListener(tiles.TileMapEvent.Unloaded, data => {
                sc.eventContext.unregisterFrameHandler(frameCallback_update)
                sc.eventContext.unregisterFrameHandler(frameCallback_draw)
            })

            // this.myRender = scene.createRenderable(
            //     scene.TILE_MAP_Z,
            //     (t, c) => this.trace(t, c)
            // )
            this.getTilemapDimensions()
        }

        constructor() {
            this._angle = 0
            this.fov = defaultFov
            this.camera = new scene.Camera()

            const sc = game.currentScene()
            if (!sc.tileMap) {
                sc.tileMap = new tiles.TileMap();
            } else {
                this.tilemapLoaded()
            }
            game.currentScene().tileMap.addEventListener(tiles.TileMapEvent.Loaded, data => this.tilemapLoaded())

            //self sprite
            this.sprSelf = sprites.create(image.create(this.tilemapScaleSize >> 1, this.tilemapScaleSize >> 1), SpriteKind.Player)
            this.takeoverSceneSprites()
            this.sprites.removeElement(this.sprSelf)
            this.updateViewZPos()
            scene.cameraFollowSprite(this.sprSelf)
            this.updateSelfImage()

            game.onUpdate(function () {
                this.updateControls()
            })

            game.onUpdateInterval(400, () => {
                for (let i = 0; i < this.sprites.length;) {
                    const spr = this.sprites[i]
                    if (spr.flags & sprites.Flag.RelativeToCamera) {
                        this.sprites.removeElement(spr)
                        this.sprites2D.push(spr)
                    } else { i++ }
                }
                for (let i = 0; i < this.sprites2D.length;) {
                    const spr = this.sprites2D[i]
                    if (!(spr.flags & sprites.Flag.RelativeToCamera)) {
                        this.sprites2D.removeElement(spr)
                        this.sprites.push(spr)
                    } else { i++ }
                }
                this.takeoverSceneSprites() // in case some one new
            })


            game.onUpdateInterval(25, () => {
                if (this.cameraSway && this.isWalking) {
                    this.cameraOffsetX = (Math.sin(control.millis() / 150) * this.cameraSway * 3) | 0
                    this.cameraOffsetZ_fpx = tofpx(Math.cos(control.millis() / 75) * this.cameraSway) | 0
                }
            });
            control.__screen.setupUpdate(() => {
                if (this.viewMode == ViewMode.raycastingView)
                    updateScreen(this.tempScreen)
                else
                    updateScreen(screen)
            })

            game.addScenePushHandler((oldScene) => {
                control.__screen.setupUpdate(() => { updateScreen(screen) })
            })
            game.addScenePopHandler((oldScene) => {
                control.__screen.setupUpdate(() => {
                    if (this.viewMode == ViewMode.raycastingView)
                        updateScreen(this.tempScreen)
                    else
                        updateScreen(screen)
                })
            })
        }

        private getTilemapDimensions(): void {
            let tm = game.currentScene().tileMap;

            this.tilemapCols = tm.areaWidth() >> tm.scale;
            this.tilemapRows = tm.areaHeight() >> tm.scale;
        }

        private setVectors() {
            const sin = Math.sin(this._angle)
            const cos = Math.cos(this._angle)
            this.dirXFpx = tofpx(cos)
            this.dirYFpx = tofpx(sin)
            this.planeX = tofpx(sin * this._fov)
            this.planeY = tofpx(cos * -this._fov)
        }

        //todo, pre-drawn dirctional image
        public updateSelfImage() {
            if (this.hasCustomSelfImage) return // don't overwrite a custom image the user set
            const img = this.sprSelf.image
            img.fill(6)
            const arrowLength = img.width / 2
            img.drawLine(arrowLength, arrowLength, arrowLength + this.dirX * arrowLength, arrowLength + this.dirY * arrowLength, 2)
            img.fillRect(arrowLength - 1, arrowLength - 1, 2, 2, 2)
        }

        // Sets a custom image for "myself sprite" (the player). Once called, the
        // built-in auto-drawn arrow icon is no longer redrawn over it every frame.
        setSelfImage(img: Image) {
            this.sprSelf.setImage(img)
            this.hasCustomSelfImage = true
        }

        // Reverts to the built-in auto-drawn arrow icon.
        clearCustomSelfImage() {
            this.hasCustomSelfImage = false
            this.updateSelfImage()
        }

        updateControls() {
            if (this.velocityAngle !== 0) {
                const dx = controller.dx(this.velocityAngle)
                if (dx) {
                    this.viewAngle += dx
                }
            }
            if (this.velocity !== 0) {
                this.isWalking = true
                const dy = controller.dy(this.velocity)
                if (dy) {
                    const nx = this.xFpx - Math.round(this.dirXFpx * dy)
                    const ny = this.yFpx - Math.round(this.dirYFpx * dy)
                    this.sprSelf.setPosition((nx * this.tilemapScaleSize / fpx_scale), (ny * this.tilemapScaleSize / fpx_scale))
                } else {
                    this.isWalking = false
                }
            }

            for (const spr of this.sprites) {
                this.updateMotionZ(spr)
            }
            this.updateMotionZ(this.sprSelf)
        }

        updateMotionZ(spr: Sprite) {
            const dt = game.eventContext().deltaTime
            const motionZ = this.spriteMotionZ[spr.id]
            //if (!motionZ) continue

            if (motionZ.v != 0 || motionZ.p != motionZ.offset) {
                motionZ.v += motionZ.a * dt, motionZ.p += motionZ.v * dt
                //landing
                if ((motionZ.a >= 0 && motionZ.v > 0 && motionZ.p > motionZ.offset) ||
                    (motionZ.a <= 0 && motionZ.v < 0 && motionZ.p < motionZ.offset)) { motionZ.p = motionZ.offset, motionZ.v = 0 }
                if (spr === this.sprSelf)
                    this.updateViewZPos()
            }

        }


        blitRowBreak(screenX: number, screenUp: number, screenDown: number, source: Image, sourceX: number, sourceYBreak: number, brightness: number) {

            let stepY = (sourceYBreak) / (SHHalf - screenUp)
            let sourceY = sourceYBreak - stepY
            let y = SHHalf - 1
            if (screenUp < 0)
                screenUp = 0
            while (y >= Math.ceil(screenUp) - 1) {
                if (sourceY < 0)
                    sourceY = 0
                const raw = source.getPixel(sourceX, sourceY)
                const c = this.ditheredColor(raw, brightness, screenX, y)
                if (c) this.tempScreen.setPixel(screenX, y, c)
                y--
                sourceY -= stepY
            }
            // from screen half  going down
            stepY = (source.height - sourceYBreak) / (screenDown - SHHalf)
            sourceY = sourceYBreak
            y = SHHalf
            if (screenDown > SH)
                screenDown = SH
            while (y < Math.round(screenDown)) {
                const raw = source.getPixel(sourceX, sourceY)
                const c = this.ditheredColor(raw, brightness, screenX, y)
                if (c) this.tempScreen.setPixel(screenX, y, c)
                y++
                sourceY += stepY
            }

        }

        render() {
            // based on https://lodev.org/cgtutor/raycasting.html
            this.selfXFpx = this.xFpx
            this.selfYFpx = this.yFpx

            this.viewZPos = this.spriteMotionZ[this.sprSelf.id].p + (this.sprSelf._height as any as number) - (2 << fpx) + this.cameraOffsetZ_fpx
            let cameraRangeAngle = Math.atan(this.fov) + .1 //tolerance for spr center just out of camera
            //debug
            // const ms=control.millis()

            const tex = this.textures[1]
            let rayDirX0 = this.dirXFpx / fpx_scale + (this.planeX / fpx_scale)
            let rayDirY0 = this.dirYFpx / fpx_scale + (this.planeY / fpx_scale)
            let rayDirX1 = this.dirXFpx / fpx_scale - (this.planeX / fpx_scale)
            let rayDirY1 = this.dirYFpx / fpx_scale - (this.planeY / fpx_scale)
            let fmapX = this.selfXFpx / fpx_scale
            let fmapY = this.selfYFpx / fpx_scale

            const sc = game.currentScene()
            // clear each frame so transparent floor/ceiling pixels reveal a clean
            // background instead of the previous frame's leftover pixels
            this.tempScreen.fill(scene.backgroundColor())
            // background
            const speed = 2 // 2: normal speed
            let backgroundOffset = (this._angle / Math.PI * speed) % 1  // range -1..1
            if (backgroundOffset < 0) backgroundOffset++  // range 0..1
            backgroundOffset *= SW    // range 0..screenwidth

            //floor
            for (let y = 60; y < SH; y++) {
                let p = y - SHHalf;
                let posZ = SH * this.viewZPos / this.tilemapScaleSize / fpx_scale;
                let rowDistance = posZ / p;
                let floorStepX = rowDistance * (rayDirX1 - rayDirX0) / SW;
                let floorStepY = rowDistance * (rayDirY1 - rayDirY0) / SW;

                let floorX = fmapX + rowDistance * rayDirX0;
                let floorY = fmapY + rowDistance * rayDirY0;

                // every pixel in a row shares the same camera distance, so brightness
                // only needs computing once per row; dithering still varies per pixel
                const rowBrightness = this.brightnessAt(Math.abs(rowDistance))

                for (let x = 0; x < SW; x++) {
                    let cellX = Math.floor(floorX);
                    let cellY = Math.floor(floorY);
                    let tx = (16 * (floorX - cellX)) & 15;
                    let ty = (16 * (floorY - cellY)) & 15;

                    let mapX = Math.floor(floorX);
                    if (mapX < 0) mapX = (mapX % this.tilemapCols + this.tilemapCols) % this.tilemapCols;
                    else mapX = mapX % this.tilemapCols;

                    let mapY = Math.floor(floorY);
                    if (mapY < 0) mapY = (mapY % this.tilemapRows + this.tilemapRows) % this.tilemapRows;
                    else mapY = mapY % this.tilemapRows;

                    let tileType = this.map.getTile(mapX, mapY);
                    let floorTex = this.textures[tileType];
                    floorX += floorStepX;
                    floorY += floorStepY;
                    if (!floorTex)
                        continue

                    let raw = floorTex.getPixel(tx, ty);
                    let c = this.ditheredColor(raw, rowBrightness, x, y);
                    if (c) this.tempScreen.setPixel(x, y, c);
                }
            }

            // Ceiling
            if (this.ceilingMap) {
                for (let y = 0; y < SHHalf; y++) {
                    let p = y;
                    // let posZ = SH * this.viewZPos / this.tilemapScaleSize / fpx_scale;
                    let posZ = SH * this.viewZPos / this.tilemapScaleSize / fpx_scale;
                    posZ = 125 - posZ
                    let rowDistance = posZ / (SHHalf - p);
                    let ceilingStepX = rowDistance * (rayDirX1 - rayDirX0) / SW;
                    let ceilingStepY = rowDistance * (rayDirY1 - rayDirY0) / SW;

                    let ceilingX = fmapX + rowDistance * rayDirX0;
                    let ceilingY = fmapY + rowDistance * rayDirY0;

                    // same per-row brightness as the floor loop above; dithering varies per pixel
                    const rowBrightness = this.brightnessAt(Math.abs(rowDistance))

                    for (let x = 0; x < SW; x++) {
                        let cellX = Math.floor(ceilingX);
                        let cellY = Math.floor(ceilingY);

                        // cellY = (cellY + this.tilemapRows / 2) % this.tilemapRows;

                        let tx = (16 * (ceilingX - cellX)) & 15;
                        let ty = (16 * (ceilingY - cellY)) & 15;

                        let tileType = this.ceilingMap.getTile(cellX, cellY);
                        let ceilingTex = this.ceilingTextures[tileType];
                        ceilingX += ceilingStepX;
                        ceilingY += ceilingStepY;
                        if (!ceilingTex) {
                            // no tile painted here on the ceiling map: show sky instead
                            // of leaving the pixel at whatever the frame was cleared to
                            let backX = (backgroundOffset + x) % SW
                            let backC = sc.background.image.getPixel(backX, y)
                            if (backC) this.tempScreen.setPixel(x, y, backC)
                            continue
                        }

                        let raw = ceilingTex.getPixel(tx, ty);
                        let c = this.ditheredColor(raw, rowBrightness, x, y);
                        if (c) this.tempScreen.setPixel(x, y, c);
                    }
                }
            } else {
                // No ceiling tilemap: paint the scrolling sky across the whole upper
                // half up front (same as floor/ceiling above), so any transparent gap
                // in a wall reveals sky instead of an empty/black hole. Previously this
                // was only ever painted in the sliver strictly above a wall's rectangle,
                // never behind the wall itself.
                for (let y = 0; y < SHHalf; y++) {
                    for (let x = 0; x < SW; x++) {
                        let backX = (backgroundOffset + x) % SW
                        let c = sc.background.image.getPixel(backX, y)
                        this.tempScreen.setPixel(x, y, c)
                    }
                }
            }

            // walls

            for (let x = 0; x < SW; x++) {
                const cameraX: number = one - Math.idiv(((x + this.cameraOffsetX) << fpx) << 1, SW)
                let rayDirX = this.dirXFpx + (this.planeX * cameraX >> fpx)
                let rayDirY = this.dirYFpx + (this.planeY * cameraX >> fpx)

                // avoid division by zero
                if (rayDirX == 0) rayDirX = 1
                if (rayDirY == 0) rayDirY = 1

                let mapX = this.selfXFpx >> fpx
                let mapY = this.selfYFpx >> fpx

                // length of ray from current position to next x or y-side
                let sideDistX = 0, sideDistY = 0

                // length of ray from one x or y-side to next x or y-side
                const deltaDistX = Math.abs(Math.idiv(one2, rayDirX));
                const deltaDistY = Math.abs(Math.idiv(one2, rayDirY));

                let mapStepX = 0, mapStepY = 0

                let sideWallHit = false;

                //calculate step and initial sideDist
                if (rayDirX < 0) {
                    mapStepX = -1;
                    sideDistX = ((this.selfXFpx - (mapX << fpx)) * deltaDistX) >> fpx;
                } else {
                    mapStepX = 1;
                    sideDistX = (((mapX << fpx) + one - this.selfXFpx) * deltaDistX) >> fpx;
                }
                if (rayDirY < 0) {
                    mapStepY = -1;
                    sideDistY = ((this.selfYFpx - (mapY << fpx)) * deltaDistY) >> fpx;
                } else {
                    mapStepY = 1;
                    sideDistY = (((mapY << fpx) + one - this.selfYFpx) * deltaDistY) >> fpx;
                }

                let color = 0
                let hitCount = 0

                while (true) {
                    //jump to next map square, OR in x-direction, OR in y-direction
                    if (sideDistX < sideDistY) {
                        sideDistX += deltaDistX;
                        mapX += mapStepX;
                        sideWallHit = false;
                    } else {
                        sideDistY += deltaDistY;
                        mapY += mapStepY;
                        sideWallHit = true;
                    }

                    if (this.map.isOutsideMap(mapX, mapY))
                        break
                    color = this.map.getTile(mapX, mapY)
                    if (this.map.isWall(mapX, mapY)) {
                        // record this hit; only keep marching past it if its texture
                        // actually has transparent pixels worth looking through
                        this.hitMapX[hitCount] = mapX
                        this.hitMapY[hitCount] = mapY
                        this.hitSide[hitCount] = sideWallHit
                        this.hitColor[hitCount] = color
                        hitCount++
                        if (hitCount >= MAX_HITS_PER_COLUMN || !this.textureHasTransparency(color))
                            break; // hit!
                    }
                }

                if (hitCount == 0)
                    continue

                // draw farthest hit first, nearest hit last, so a nearer transparent
                // gap reveals the farther wall that was already drawn underneath it
                for (let hi = hitCount - 1; hi >= 0; hi--) {
                    mapX = this.hitMapX[hi]
                    mapY = this.hitMapY[hi]
                    sideWallHit = this.hitSide[hi]
                    color = this.hitColor[hi]

                    let perpWallDist = 0
                    let wallX = 0
                    if (!sideWallHit) {
                        perpWallDist = Math.idiv(((mapX << fpx) - this.selfXFpx + (1 - mapStepX << fpx - 1)) << fpx, rayDirX)
                        wallX = this.selfYFpx + (perpWallDist * rayDirY >> fpx);
                    } else {
                        perpWallDist = Math.idiv(((mapY << fpx) - this.selfYFpx + (1 - mapStepY << fpx - 1)) << fpx, rayDirY)
                        wallX = this.selfXFpx + (perpWallDist * rayDirX >> fpx);
                    }
                    wallX &= FPX_MAX

                    let tex = this.textures[color]
                    if (!tex)
                        continue

                    const dis = Math.abs(perpWallDist) / fpx_scale
                    const brightness = this.brightnessAt(dis)

                    let texX = (wallX * tex.width) >> fpx;

                    const lineHeight = (this.wallHeightInView / perpWallDist)
                    const drawEnd = lineHeight * this.viewZPos / this.tilemapScaleSize / fpx_scale;
                    const horizontBreak = 1 - this.viewZPos / this.tilemapScaleSize / fpx_scale;

                    this.blitRowBreak(x, SHHalf + drawEnd - lineHeight, SHHalf + drawEnd, tex, texX, tex.height * horizontBreak, brightness)

                    if (hi == 0)
                        this.dist[x] = perpWallDist
                }
            }
            //debug
            // info.setScore(control.millis()-ms)
            // this.tempScreen.print(backgroundOffset.toString(), 0,0,7 )
            // this.tempScreen.print([Math.roundWithPrecision(this._angle, 3)].join(), 20, 5)

            this.drawSprites()
        }

        drawSprites() {
            //debug
            // let msSprs=control.millis()
            /////////////////// sprites ///////////////////

            //for sprite
            const invDet = one2 / (this.planeX * this.dirYFpx - this.dirXFpx * this.planeY); //required for correct matrix multiplication

            this.sprites
                .filter((spr, i) => {
                    const spriteX = this.sprXFx8(spr) - this.xFpx // this.selfXFpx
                    const spriteY = this.sprYFx8(spr) - this.yFpx // this.selfYFpx
                    this.angleSelfToSpr[spr.id] = Math.atan2(spriteX, spriteY)
                    this.transformX[spr.id] = invDet * (this.dirYFpx * spriteX - this.dirXFpx * spriteY) >> fpx;
                    this.transformY[spr.id] = invDet * (-this.planeY * spriteX + this.planeX * spriteY) >> fpx; //this is actually the depth inside the screen, that what Z is in 3D
                    const angleInCamera = Math.atan2(this.transformX[spr.id] * this.fov, this.transformY[spr.id])
                    return angleInCamera > -this.cameraRangeAngle && angleInCamera < this.cameraRangeAngle //(this.transformY[spr.id] > 0
                }).sort((spr1, spr2) => {   // far to near
                    return (this.transformY[spr2.id] - this.transformY[spr1.id])
                }).forEach((spr, index) => {
                    //debug
                    // this.tempScreen.print([spr.id,Math.roundWithPrecision(angle[spr.id],3)].join(), 0, index * 10 + 10,9)
                    this.drawSprite(spr, index, this.transformX[spr.id], this.transformY[spr.id], this.angleSelfToSpr[spr.id])
                })

            //debug
            // info.setLife(control.millis() - msSprs+1)
            //this.tempScreen.print([Math.roundWithPrecision(this._angle,3)].join(), 20,  0)

        }

        registerOnSpriteDirectionUpdate(handler: (spr: Sprite, dir: number) => void) {
            this.onSpriteDirectionUpdateHandler = handler
        }

        // Attaches a Model3D to a sprite so it renders as a real, rotatable
        // solid instead of the sprite's flat billboard image. While a model
        // is attached, the sprite's own `image` is no longer drawn - say
        // bubbles and particles anchored to the sprite keep working as before.
        // `scale` multiplies every model coordinate (1 = the model's own
        // pixel units); `yaw` is the model's initial rotation in radians.
        setSpriteModel(spr: Sprite, model: Model3D, scale: number = 1, yaw: number = 0) {
            this.getMotionZ(spr) // ensure motion/height bookkeeping exists for this sprite
            this.spriteModels[spr.id] = model
            this.spriteModelScale[spr.id] = scale
            this.spriteModelYaw[spr.id] = yaw
        }

        // Removes a previously attached model, reverting the sprite back to
        // drawing its normal flat billboard image.
        clearSpriteModel(spr: Sprite) {
            this.spriteModels[spr.id] = undefined
        }

        hasSpriteModel(spr: Sprite): boolean {
            return !!this.spriteModels[spr.id]
        }

        // Sets a sprite's attached model to an absolute yaw (radians, rotation
        // around the vertical axis).
        setSpriteModelYaw(spr: Sprite, yaw: number) {
            this.spriteModelYaw[spr.id] = yaw
        }

        // Rotates a sprite's attached model by a relative amount (radians) -
        // handy to call every frame/tick to make props spin in place.
        rotateSpriteModel(spr: Sprite, deltaYaw: number) {
            this.spriteModelYaw[spr.id] = (this.spriteModelYaw[spr.id] || 0) + deltaYaw
        }

        getSpriteModelYaw(spr: Sprite): number {
            return this.spriteModelYaw[spr.id] || 0
        }

        setSpriteModelScale(spr: Sprite, scale: number) {
            this.spriteModelScale[spr.id] = scale
        }

        // Projects and flat-fills every face of a sprite's attached model.
        // Reuses the caller's already-computed, wall-occlusion-tested column
        // range [blitXMin, blitXMin+blitWidth) for the sprite as a whole
        // (see drawSprite below), then additionally checks each triangle's
        // nearest vertex against the per-column wall distance buffer so
        // individual faces at different depths still occlude correctly
        // against nearby walls.
        private drawModel3D(spr: Sprite, model: Model3D, blitXMin: number, blitWidth: number) {
            const scale = this.spriteModelScale[spr.id] || 1
            const yaw = this.spriteModelYaw[spr.id] || 0
            const invDet = one2 / (this.planeX * this.dirYFpx - this.dirXFpx * this.planeY)
            const baseSpriteX = this.sprXFx8(spr) - this.xFpx
            const baseSpriteY = this.sprYFx8(spr) - this.yFpx
            const groundNumerator = this.viewZPos - this.spriteMotionZ[spr.id].p
            const cosY = Math.cos(yaw), sinY = Math.sin(yaw)

            const verts = model.vertices
            for (let i = 0; i < verts.length; i++) {
                const v = verts[i]
                // rotate the model's horizontal footprint around its vertical
                // axis, then scale; height (y) is not affected by yaw
                const rx = (v.x * cosY - v.z * sinY) * scale
                const rz = (v.x * sinY + v.z * cosY) * scale
                // rx/rz are pixel offsets - divide by tilemapScaleSize to
                // convert into the same tile-based fixed-point scale that
                // sprXFx8/xFpx use for horizontal world position
                const vSpriteX = baseSpriteX + rx / this.tilemapScaleSize
                const vSpriteY = baseSpriteY + rz / this.tilemapScaleSize
                let tY = invDet * (-this.planeY * vSpriteX + this.planeX * vSpriteY) >> fpx
                // clamp near/behind-camera vertices: without this, a vertex
                // crossing the eye plane would flip the projection sign and
                // draw wildly wrong. Models that are mostly this close to the
                // camera may show minor stretching - there's no true near-plane
                // clipping here, only this safety clamp.
                if (tY < (one >> 4)) tY = one >> 4
                const tX = invDet * (this.dirYFpx * vSpriteX - this.dirXFpx * vSpriteY) >> fpx
                const lineHeight = Math.idiv(this.wallHeightInView, tY)
                // heightNumerator==groundNumerator projects to the same
                // screen Y a normal billboard sprite's bottom edge would use
                // (see drawSprite's drawStart, which is this same expression
                // plus a full sprite-height offset); subtracting the vertex's
                // own height moves it up the screen from there.
                const heightNumerator = groundNumerator - tofpx(v.y * scale)
                this.modelScreenX[i] = Math.ceil(SWHalf * (1 - tX / tY)) - this.cameraOffsetX
                this.modelScreenY[i] = SHHalf + (lineHeight * (heightNumerator / this.tilemapScaleSize) >> fpx)
                this.modelDepth[i] = tY
            }

            const faces = model.faces
            // painter's algorithm: draw farthest faces first so nearer faces
            // correctly overpaint them - enough for small convex solids
            // without needing a full per-pixel depth buffer
            this.modelFaceOrder.length = 0
            for (let i = 0; i < faces.length; i++) this.modelFaceOrder.push(i)
            this.modelFaceOrder.sort((a, b) => this.modelFaceAvgDepth(faces[b]) - this.modelFaceAvgDepth(faces[a]))

            const blitXMax = blitXMin + blitWidth
            for (let oi = 0; oi < this.modelFaceOrder.length; oi++) {
                const face = faces[this.modelFaceOrder[oi]]
                const dis = this.modelFaceAvgDepth(face) / fpx_scale
                let brightness = this.brightnessAt(dis)
                if (face.shade !== undefined) brightness *= face.shade
                const idx = face.indices
                // fan-triangulate: works for any planar convex polygon
                for (let i = 1; i + 1 < idx.length; i++) {
                    this.fillTriangle(idx[0], idx[i], idx[i + 1], face.color, brightness, blitXMin, blitXMax)
                }
            }
        }

        private modelFaceAvgDepth(face: ModelFace): number {
            let sum = 0
            for (const i of face.indices) sum += this.modelDepth[i]
            return sum / face.indices.length
        }

        // Classic top-to-bottom scanline triangle fill, reading projected
        // vertex positions out of the modelScreenX/Y/Depth scratch buffers
        // that drawModel3D just populated.
        private fillTriangle(i0: number, i1: number, i2: number, color: number, brightness: number, xMin: number, xMax: number) {
            let ax = this.modelScreenX[i0], ay = this.modelScreenY[i0]
            let bx = this.modelScreenX[i1], by = this.modelScreenY[i1]
            let cx = this.modelScreenX[i2], cy = this.modelScreenY[i2]
            // sort the three points top-to-bottom by screen Y (ay <= by <= cy)
            if (ay > by) { const tx = ax, ty = ay; ax = bx; ay = by; bx = tx; by = ty }
            if (ay > cy) { const tx = ax, ty = ay; ax = cx; ay = cy; cx = tx; cy = ty }
            if (by > cy) { const tx = bx, ty = by; bx = cx; by = cy; cx = tx; cy = ty }

            const nearestDepth = Math.min(this.modelDepth[i0], Math.min(this.modelDepth[i1], this.modelDepth[i2]))

            const yTop = Math.max(0, Math.ceil(ay))
            const yMid = Math.min(SH, Math.ceil(by))
            const yBot = Math.min(SH, Math.ceil(cy))
            if (yTop >= yBot) return // degenerate or fully off-screen vertically

            // edge a->c spans the full height of the triangle; a->b and b->c
            // each cover one half - interpolate x along each per scanline
            const slopeAC = cy != ay ? (cx - ax) / (cy - ay) : 0
            const slopeAB = by != ay ? (bx - ax) / (by - ay) : 0
            const slopeBC = cy != by ? (cx - bx) / (cy - by) : 0

            for (let y = yTop; y < yMid; y++) {
                const xLeft = ax + (y - ay) * slopeAC
                const xRight = ax + (y - ay) * slopeAB
                this.fillModelSpan(y, xLeft, xRight, color, brightness, nearestDepth, xMin, xMax)
            }
            for (let y = yMid; y < yBot; y++) {
                const xLeft = ax + (y - ay) * slopeAC
                const xRight = bx + (y - by) * slopeBC
                this.fillModelSpan(y, xLeft, xRight, color, brightness, nearestDepth, xMin, xMax)
            }
        }

        private fillModelSpan(y: number, xa: number, xb: number, color: number, brightness: number, nearestDepth: number, xMin: number, xMax: number) {
            let x0 = Math.round(Math.min(xa, xb))
            let x1 = Math.round(Math.max(xa, xb))
            if (x0 < xMin) x0 = xMin
            if (x1 > xMax) x1 = xMax
            for (let x = x0; x < x1; x++) {
                // a wall drawn earlier in this column is nearer than every
                // point of this triangle - it's fully hidden here
                if (this.dist[x] && this.dist[x] < nearestDepth)
                    continue
                const c = this.ditheredColor(color, brightness, x, y)
                if (c) this.tempScreen.setPixel(x, y, c)
            }
        }

        drawSprite(spr: Sprite, index: number, transformX: number, transformY: number, myAngle: number) {
            const spriteScreenX = Math.ceil((SWHalf) * (1 - transformX / transformY)) - this.cameraOffsetX;
            const spriteScreenHalfWidth = Math.idiv((spr._width as any as number) / this.tilemapScaleSize / 2 * this.wallWidthInView, transformY)  //origin: (texSpr.width / 2 << fpx) / transformY / this.fov / 3 * 2 * 4
            const spriteScreenLeft = spriteScreenX - spriteScreenHalfWidth
            const spriteScreenRight = spriteScreenX + spriteScreenHalfWidth

            //calculate drawing range in X direction
            //assume there is one range only
            let blitX = 0, blitWidth = 0
            for (let sprX = 0; sprX < SW; sprX++) {
                if (this.dist[sprX] > transformY) {
                    if (blitWidth == 0)
                        blitX = sprX
                    blitWidth++
                } else if (blitWidth > 0) {
                    if (blitX <= spriteScreenRight && blitX + blitWidth >= spriteScreenLeft)
                        break
                    else
                        blitX = 0, blitWidth = 0;
                }
            }
            // this.tempScreen.print([this.getxFx8(spr), this.getyFx8(spr)].join(), 0,index*10+10)
            const blitXSpr = Math.max(blitX, spriteScreenLeft)
            const blitWidthSpr = Math.min(blitX + blitWidth, spriteScreenRight) - blitXSpr
            if (blitWidthSpr <= 0)
                return

            const lineHeight = Math.idiv(this.wallHeightInView, transformY)
            const drawStart = SHHalf + (lineHeight * ((this.viewZPos - this.spriteMotionZ[spr.id].p - (spr._height as any as number)) / this.tilemapScaleSize) >> fpx)

            const model = this.spriteModels[spr.id]
            if (model) {
                // real 3D solid: project & flat-fill its faces into the same
                // wall-occlusion-tested column range [blitXSpr, blitXSpr+blitWidthSpr)
                // the flat-billboard path below would have blitted into
                this.drawModel3D(spr, model, blitXSpr, blitWidthSpr)
            } else {
                //for textures=image[][], abandoned
                //    const texSpr = spr.getTexture(Math.floor(((Math.atan2(spr.vxFx8, spr.vyFx8) - myAngle) / Math.PI / 2 + 2-.25) * spr.textures.length +.5) % spr.textures.length)
                //for deal in user code
                if (this.onSpriteDirectionUpdateHandler)
                    this.onSpriteDirectionUpdateHandler(spr, ((Math.atan2(spr._vx as any as number, spr._vy as any as number) - myAngle) / Math.PI / 2 + 2 - .25))
                //for CharacterAnimation ext.
                //     const iTexture = Math.floor(((Math.atan2(spr._vx as any as number, spr._vy as any as number) - myAngle) / Math.PI / 2 + 2 - .25) * 4 + .5) % 4
                //     const characterAniDirs = [Predicate.MovingLeft,Predicate.MovingDown, Predicate.MovingRight, Predicate.MovingUp]
                //     character.setCharacterState(spr, character.rule(characterAniDirs[iTexture]))
                //for this.spriteAnimations
                const texSpr = !this.spriteAnimations[spr.id] ? spr.image : this.spriteAnimations[spr.id].getFrameByDir(((Math.atan2(spr._vx as any as number, spr._vy as any as number) - myAngle) / Math.PI / 2 + 2 - .25))

                const sprTexRatio = texSpr.width / spriteScreenHalfWidth / 2
                helpers.imageBlit(
                    this.tempScreen,
                    blitXSpr,
                    drawStart,
                    blitWidthSpr,
                    lineHeight * spr.height / this.tilemapScaleSize,
                    texSpr,
                    (blitXSpr - (spriteScreenX - spriteScreenHalfWidth)) * sprTexRatio
                    ,
                    0,
                    blitWidthSpr * sprTexRatio, texSpr.height, true, false)
            }

            screen.fill(0)
            const fpx_div_transformy = Math.roundWithPrecision(transformY / 4 / fpx_scale, 2)
            const height = (SH / fpx_div_transformy)
            const blitXSaySrc = ((blitX - spriteScreenX) * fpx_div_transformy) + SWHalf
            const blitWidthSaySrc = (blitWidth * fpx_div_transformy)

            //sprite
            // screen.drawImage(texSpr, SWHalf-texSpr.width/2, SHHalf)
            //sayText
            const sayRender = this.sayRederers[spr.id]
            if (sayRender) {
                if (this.sayEndTimes[spr.id] && control.millis() > this.sayEndTimes[spr.id]) {
                    this.sayRederers[spr.id] = undefined
                } else {
                    this.tempSprite.x = SWHalf
                    this.tempSprite.y = SHHalf + 2
                    this.camera.drawOffsetX = 0
                    this.camera.drawOffsetY = 0
                    sayRender.draw(screen, this.camera, this.tempSprite)
                }
            }
            //particle
            const particle = this.spriteParticles[spr.id]
            if (particle) {
                if (particle.lifespan) {
                    //debug
                    // this.tempScreen.print([spr.id].join(), 0,index*10+10)
                    this.tempSprite.x = SWHalf
                    this.tempSprite.y = SHHalf + spr.height
                    this.camera.drawOffsetX = 0//spr.x-SWHalf
                    this.camera.drawOffsetY = 0//spr.y-SH
                    particle.__draw(this.camera)
                } else {
                    this.spriteParticles[spr.id] = undefined
                }
            }
            //update screen for this spr
            // const sayTransformY = 
            if (blitXSaySrc <= 0) { //imageBlit considers negative value as 0
                helpers.imageBlit(
                    this.tempScreen,
                    spriteScreenX - SWHalf / fpx_div_transformy, drawStart - height / 2, (blitWidthSaySrc + blitXSaySrc) / fpx_div_transformy, height,
                    screen,
                    0, 0, blitWidthSaySrc + blitXSaySrc, SH, true, false)
            } else {
                helpers.imageBlit(
                    this.tempScreen,
                    // blitX, drawStart - height / 2 , blitWidth, height,
                    blitX, drawStart - height / 2, blitWidth, height,
                    screen,
                    blitXSaySrc, 0, blitWidthSaySrc, SH,
                    true, false)
            }
        }
    }

    //%fixedinstance
    export const raycastingRender = new RayCastingRender()
}
