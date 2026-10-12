# AETHER rover enclosure — V1 prototype

This package contains a configurable, 3D-printable four-wheel rover shell and its removable covers and sensor mounts. It is a **provisional fit model**, not a confirmed match to the physical chassis: no caliper measurements or chassis mounting-hole coordinates were supplied.

## Geometry baseline used

| Item | Model value | Basis / caveat |
|---|---:|---|
| Reference chassis envelope | 255 × 160 × 65 mm | Representative 4WD listing; other common kits differ. The source lists 65 × 30 mm wheels and a 255 × 160 × 65 mm structure, but not track or wheelbase ([Arob Tech listing](https://www.arobtech.com/product/4wd-4wheel-robot-chassis/)). |
| Wheel envelope | Ø65 × 30 mm | From the same listing. |
| Axle layout | 160 mm wheelbase, 130 mm track | **Assumed** for this prototype, not stated by the chassis seller. |
| ESP32-CAM | AI-Thinker board envelope 40.5 × 27 × 4.5 mm | Board-only dimension; the mounted camera/lens protrusion and exact lens position need checking on the physical module ([datasheet](https://www.handsontec.com/dataspecs/module/ESP32-CAM.pdf)). |
| HC-SR04 | 45 × 20 × 15 mm; Ø16 mm transducers | Module envelope from [SparkFun](https://www.sparkfun.com/ultrasonic-distance-sensor-3-3v-hc-sr04.html); 16 mm transducer diameter from [StemVolt](https://stemvolt.in/product/hc-sr04-ultrasonic-sensor-distance-measuring-sensor/). The model uses a provisional 25 mm centre pitch; measure your board before printing. |
| HC-SR501 PIR | 32 × 24 mm board; Ø23 mm Fresnel lens; 28 mm mounting pitch | From the [HC-SR501 datasheet](https://components101.com/sites/default/files/component_datasheet/HC%20SR501%20PIR%20Sensor%20Datasheet.pdf). The mount uses tie slots for board retention. |

The chassis is not a standardized envelope: for example, another 4WD listing gives 200 × 200 × 60 mm with 65 × 20 mm wheels ([Nauvitel listing](https://nauvitel.com/product/4wd-robot-chassis/)). The values above are only a starting point.

## Files

- `STL/AETHER_Main_Body_Shell.stl` — complete, unsplit shell reference, 260 × 170 × 86 mm.
- `STL/AETHER_Main_Body_Rear_Half.stl` — rear print half, 160 × 170 × 86 mm.
- `STL/AETHER_Main_Body_Front_Half.stl` — front print half, 100 × 170 × 86 mm.
- `STL/AETHER_Removable_Top_Cover.stl` — locating plug and screw-on access cover.
- `STL/AETHER_Front_Camera_Mount.stl` — camera carrier and aperture.
- `STL/AETHER_Ultrasonic_Sensor_Mount.stl` — two-opening HC-SR04 carrier.
- `STL/AETHER_Motion_Detector_Mount.stl` — angled PIR bracket, lens opening, and tie slots.
- `STL/AETHER_Rear_Access_Panel.stl` — removable service panel with cable openings.
- `STL/AETHER_Interchangeable_ID_Panel.stl` — blank side identity plate; print two copies for the blue/red options.

The full shell is longer than a typical 220 mm-class printer bed. Use the two body-half STLs for printing and join them with three M3 × 16 mm self-tapping screws into the printed pilot bosses. The camera and ultrasonic carriers use M3 mounting holes; the top cover uses four M3 bolts and nuts, while the rear service panel uses four M3 screws into the printed pilot bosses. The PIR board is retained with two narrow cable ties through the mount slots, and its roof pedestal uses four M3 screws into pilot bosses. Print two identity panels and fasten them with M2.5 hardware.

`aether_rover_v1.py` is the editable build123d generator. The `CONFIG` block near the top contains the chassis, wheel, aperture, sensor-pitch, and body-split assumptions. Update it from physical measurements and rerun the script before treating the enclosure as fit-ready.

## Checks completed

- All **9 STL files** load as watertight, winding-consistent, single-component meshes.
- The source B-rep shell measures 260 × 170 × 86 mm; the roof cavity, wheel arches, and service openings are real geometry.
- The enclosure assembly has **0 interferences and 0 floating parts** in the CAD interference sweep. The top-cover sliding fit is 0.40 mm; the removable side panels have 0.19 mm clearance; the camera and ultrasonic carriers are 1.0 mm apart.
- Four Ø65 × 30 mm reference wheel envelopes at the assumed 160 × 130 mm layout have zero solid overlap with the shell. This checks only the assumed model, not the real chassis.
- FDM screening used a 45° overhang threshold because the printer and material are unknown. It is a screening result, not a slicer guarantee or a pass/fail certification. Sampled local wall minima reach 1.0 mm at the camera carrier and 1.51 mm at shell/cover features, while the main shell and front-half 5th-percentile values are 2.5 mm; inspect these regions in your slicer. Print the camera, ultrasonic, and PIR mounts as test pieces first, then compare board, lens, hole-pitch, and cable clearances against the actual hardware.

## Before full-body printing

Measure the real chassis length and width, wheel diameter and width, front-to-rear and left-to-right wheel-centre spacing, chassis mounting holes, motor protrusions, and tallest installed electronics. Also verify the ESP32-CAM lens position and the HC-SR04 transducer pitch. The STL set is not yet chassis-fit verified, and the waterproofing, strength, and motion clearance of the actual rover have not been certified.
