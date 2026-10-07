# AETHER WATCH V1 — Mechanical Prototype

**Adaptive Health & Emergency Assistant**  
AETHER INTELLIGENCE · Revision 1 · units: mm

This is a parametric, FDM-oriented enclosure prototype based on the supplied rugged communicator reference. It uses an original enclosure layout and contains no Garmin branding or copied markings.

## Deliverables

- `aether_watch_assembly.step` — colored assembly in standard CAD orientation: X width, Y depth, Z height; front faces toward −Y.
- `aether_watch_exploded.step` — exploded assembly with component spacing exaggerated for inspection.
- `aether_watch_v1.py` — parametric build123d source; run with `python aether_watch_v1.py` to regenerate the CAD outputs.
- `aether_watch_main_housing.step` / `stl/aether_watch_main_housing.stl` — printable front shell, guards, mounting rails and internal supports.
- `aether_watch_rear_cover.step` / `stl/aether_watch_rear_cover.stl` — removable cover, inner locating lip, buzzer cradle and grille.
- `aether_watch_display_bezel.step` / `stl/aether_watch_display_bezel.stl` — raised front bezel.
- `aether_watch_antenna_housing.step` / `stl/aether_watch_antenna_housing.stl` — hollow mechanical antenna placeholder.
- `aether_watch_sos_button.step` / `stl/aether_watch_sos_button.stl` — red side plunger.
- `AETHER_WATCH_V1_engineering_sheets.pdf` — exterior views, nominal dimensions, section schematic, exploded view, assembly sequence and print notes.

The generic ESP32-C3, OLED, LEDs, battery, tactile switch, buzzer, wires and simplified fasteners are modeled as assembly envelopes for fit/layout review; they are not print parts.

## Geometry and fit decisions

The main shell face remains 50 × 68 mm. The fit-checked assembly envelope is **52.5 W × 33.2 D × 84.0 H** because the antenna, side lanyard eyes, raised bezel and service cover add to the nominal shell. The 52 × 28 × 12 ESP32-C3, 27 × 27 OLED, 30 × 40 × 6 LiPo and 12 mm buzzer cannot be responsibly stacked inside the original 22 mm depth with the requested walls and service clearances. Depth and overall height were increased rather than compressing components.

| Feature | Model intent |
|---|---|
| Main shell | 50 × 68 × 30; 5 mm corner radius; 2 mm nominal front/side walls |
| Rear cover | 2 mm plate with 1.6 mm perimeter register lip and four corner fasteners |
| OLED | 27 × 27 PCB nest with 0.3 mm nominal side clearance; 23 × 13 viewing opening; 1.2 mm raised bezel |
| SOS | Ø7 side-wall passage, guarded red plunger, aligned to a 6 × 6 tactile-switch envelope |
| LEDs | Two Ø5.2 bores, 12 mm centre spacing, recessed Ø8 protective pockets |
| USB-C | 10 × 5 bottom opening aligned to a generic short-end, centred USB connector |
| Audio | Seven Ø2 rear grille holes over a 12 × 5.5 buzzer envelope |
| Antenna | Ø16 × 15 outside, Ø10.4 cable passage; no electrical antenna is specified |
| Battery pocket | 32 × 41.2 clear opening for a 30 × 40 × 6 LiPo; 1.0 mm side and 0.6 mm end clearance |
| Strap eyes | Two reinforced side eyes with Ø4.6 mm passages |

The USB and battery leads are routed through protected side channels. The bezel retains the OLED PCB against the inner face of the window. The buzzer is seated in the rear-cover cradle and should be retained with a removable adhesive pad or equivalent acoustic-safe mount.

## Assumptions to verify before printing

1. **ESP32-C3 board:** represented as a generic 52 × 28 × 12 envelope, with USB-C on the short lower end and four assumed 2.4 mm mounting holes at approximately ±11 mm × ±23.5 mm relative to board centre. Verify the actual dev-board hole pattern, USB shell and antenna-clearance zone; the board model is not a guarantee of a specific manufacturer layout.
2. **LiPo lead exit:** the battery envelope is rotated to 30 mm wide × 40 mm tall. Confirm the actual pack's lead side and connector before assembly.
3. **Fasteners:** screws are simplified, unthreaded envelopes. The housing uses nominal self-tapping pilots; select actual screw lengths and ream pilots to suit the printer/material.
4. **FDM fit:** printed dimensions vary with printer, orientation, shrinkage and slicer compensation. Check the rear lip, screw pilots, bezel seats and button travel on a small test print before committing to the full shell.
5. **Antenna and buzzer retention:** their mechanical seats are modeled; sealing, adhesive, strain relief and RF performance are not qualified.

## Print and assembly guidance

- PETG is preferred for the functional prototype; PLA+ is suitable for a fit-check model.
- Start with a 0.4 mm nozzle and 0.2 mm layers. Inspect thin channel roofs and screw-boss regions in the slicer.
- Print the main housing with the front face on the build plate and the rear cavity upward. Print the cover with its exterior face on the plate and the internal lip/cradle upward. Print the antenna housing flange-down; print the SOS plunger head-down.
- Install the OLED and bezel first, then LEDs and SOS switch/plunger. Fit the ESP32-C3 to its four supports, install the battery and route its leads, seat the buzzer, route the antenna feed, close the cover and install four screws. Attach a strap through the reinforced eyes.

## Important capability and safety limit

This is **mechanical prototype CAD**, not an operational emergency communicator. The listed hardware contains no GNSS receiver or satellite modem, so the current bill of materials cannot provide GPS positioning or satellite SOS. It also does not define a LiPo charging/protection circuit, so the USB-C cutout is only a mechanical alignment feature. Do not power or deploy this as life-safety equipment until the electrical architecture, antenna, charging protection, ingress protection and environmental tests are designed and validated.

## Validation performed

- Assembly STEP inspected at **52.5 × 33.2 × 84.0 mm** overall.
- 40 solids in the assembled fit sweep; **0 unintended interferences, 0 floating suspects, 0 distance-solve failures**.
- The five print-part STLs were checked as watertight, winding-consistent single-component meshes after vertex welding.
- Front, rear, left/right, top, bottom, exploded and section renderings were reviewed. The PDF section is explicitly schematic rather than a tolerance-controlled production drawing.
