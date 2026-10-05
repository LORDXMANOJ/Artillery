# FP-155 Canard Steering Assembly: Photoreal Digital Twin

An interactive WebGL engineering model of a 155 mm modular nose-guidance module: deployable canards, a roll-decoupling ceramic bearing, a potted avionics core and a sapphire sensor dome. Built on Three.js r169 with procedural geometry, textures and lighting. There are no model files or image assets.

## Run it

```powershell
python -m http.server 8080
# open http://localhost:8080/index.html
```

Opening `index.html` directly from disk also works in Chromium browsers. `app.js` is a classic script that loads the Three.js ES modules with `import()` through the page’s import map, so it needs an internet connection for the jsDelivr CDN.

## Files

| File | Contents |
| :--- | :--- |
| `index.html` | HUD markup and the import map (`three`, `three/addons/`) |
| `style.css` | Glass-panel UI, responsive bottom sheet under 960 px |
| `app.js` | Everything else, in numbered modules (see below) |

`app.js` modules: **0** boot · **1** math/easing (cubic-bezier solver, seeded RNG) · **2** Web Audio FX · **3** procedural textures · **4** in-memory studio HDRI · **5** geometry kernels · **6** materials and the section-cap shader · **7** assembly · **8** supersonic flow FX · **9** controller/UI/loop.

## What’s modelled

| Subsystem | Geometry | Material / shader |
| :--- | :--- | :--- |
| Threaded base interface | True helicoid 2" thread with run-out, relief groove, knurled setting collar; 2-stage safety lock (discs, pins, spring, detents) inside the bore | 4340 steel, diamond-knurl normal map, brass |
| Ceramic thrust bearing | Grooved 440C inner/outer races, 14 Si₃N₄ balls, cage, dual interleaved labyrinth seals | Si₃N₄: dielectric IOR 2.0, roughness 0, clearcoat |
| Power module | Anodized chassis, reserve battery can, 8 intake slits (partial revolves with capped ends), 8-blade impeller | Brushed stainless, titanium |
| Avionics core | 3 tiered PCBs with ICs, leads, passives; MEMS IMU under an RF-shield can; brass standoffs | Transmission resin, IOR 1.52, amber attenuation |
| Canard actuation | Titanium collar with 4 parallel-walled slots, BLDC motors, drive shafts, clevis, hinge pin, torsion spring, double-wedge diamond fins with chamfered LE/TE | Bead-blasted Ti |
| Ogive cowling | Tangent ogive, 6 ram-air vents, sapphire hemisphere dome over a radar patch antenna | Ti-6Al-4V (metalness 0.92, roughness 0.22, lathe-groove normal map, anisotropy); sapphire IOR 1.77 + iridescence + dispersion |
| Outer body | Ogival shoulder, bore, brushed-bronze interface band | Slate-green coating with stencils (“FLIGHT PROBE 155 // SER-2026-A // MASS 43.5 KG”), calibration ruler, chipped edges driving roughness/metalness |

Every revolved part comes from one `revolve()` kernel. It closes the profile loop, forces outward (CCW) winding, splits normals at crease angles, and caps partial sweeps. The result is closed solids, which the section-cut capping trick relies on.

## Controls

| Control | Key | Behaviour |
| :--- | :--- | :--- |
| Exploded view slider / presets | `Space` | Staggered axial separation, `cubic-bezier(0.76, 0, 0.24, 1)` per subsystem, outermost first |
| 50% section cut + offset slider | `C` | Local clipping plane (`renderer.localClippingEnabled`) along the longitudinal plane; cut faces render as hatched CAD caps |
| Canards deployed ↔ stowed | `D` | Under-damped torsion-spring unfold with latch-stop rebound |
| Closed-loop steering | `S` | ±7.5° harmonic pitch/yaw fin commands |
| Roll decoupling | `R` | Aft body + thread + inner race spin; ball set orbits at 0.42×; forward section holds roll |
| Supersonic flow (M 2.2) | `F` | Oblique bow shock (β ≈ 31°), canard-station shock, 1,100 streamlines deflected by the body |
| Camera views | `1`–`4` | Iso, profile, canards, thread base |
| Export CAD mesh | — | Downloads `FP-155_Canard_Steering_Assembly.obj` in millimetres, +Y = nose, current pose |

Click any part to inspect it. Hovering shows the part name.

## Notes

*   The on-screen spin rate is scaled down: 250 Hz cannot be shown at 60 fps. The telemetry bar reports the real value.
*   OBJ has no PBR materials, so the export carries geometry only (one named object per part).
*   Scale: 1 scene unit = 77.5 mm, so the body radius of 1.0 gives Ø155 mm.