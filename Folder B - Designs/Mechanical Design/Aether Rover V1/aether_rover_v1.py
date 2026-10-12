"""AETHER rover enclosure V1, generated in build123d.

Coordinate system: X front (+X), Y left (+Y), Z up (+Z). Units: mm.
IMPORTANT: This is a configurable fit-first reference model, not a verified fit
for the user's physical chassis. Change the CONFIG block after measuring.
"""
from build123d import *
from pathlib import Path
import json

OUT = Path(__file__).resolve().parent
STL = OUT / "STL"
STL.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# CONFIG: Provisional common 4WD baseline only.
# Chassis example is nominal 255 x 160 x 65 mm. Axle layout is an assumption.
# ---------------------------------------------------------------------------
CHASSIS_L = 255.0
CHASSIS_W = 160.0
CHASSIS_H = 65.0
WHEEL_D = 65.0
WHEEL_W = 30.0
WHEELBASE = 160.0                 # assumed, not published for the kit listing
TRACK = 130.0                     # assumed, not published for the kit listing
WHEEL_CLEARANCE_RADIAL = 4.5
SHELL_LENGTH = 260.0
SHELL_WIDTH = 170.0
WALL = 2.5
BODY_BOTTOM = 34.0
ROOF_Z = 120.0

# Common module assumptions used only for the first mounting pass.
ESP32_BOARD_Y = 40.5
ESP32_BOARD_Z = 27.0               # landscape, lens assumed near upper edge
ESP32_BOARD_T = 4.5
CAMERA_LENS_APERTURE = 14.0        # parametric placeholder; verify actual lens
CAMERA_LENS_Z = 85.0
HC_SR04_BOARD_W = 45.0
HC_SR04_BOARD_H = 20.0
HC_SR04_BOARD_D = 15.0
HC_SR04_PITCH = 25.0               # common-module approximation; measure actual
HC_SR04_TRANSDUCER_D = 16.0
HC_SR04_APERTURE_D = 17.4
PIR_BOARD_XY = (32.0, 24.0)
PIR_LENS_D = 23.0
PIR_APERTURE_D = 24.0

# Chassis wheel centers (assumed) and world placement.
WHEEL_XS = (-WHEELBASE / 2.0, WHEELBASE / 2.0)
WHEEL_YS = (-TRACK / 2.0, TRACK / 2.0)
WHEEL_Z = WHEEL_D / 2.0

# ---------------------------------------------------------------------------
# Geometric helpers
# ---------------------------------------------------------------------------
def box_at(dx, dy, dz, x, y, z):
    return Pos(x, y, z) * Box(dx, dy, dz)


def cyl_x(x0, x1, y, z, radius):
    return Pos((x0 + x1) / 2, y, z) * Rot(Y=90) * Cylinder(radius, x1 - x0)


def cyl_y(y0, y1, x, z, radius):
    return Pos(x, (y0 + y1) / 2, z) * Rot(X=90) * Cylinder(radius, y1 - y0)


def cyl_z(z0, z1, x, y, radius):
    return Pos(x, y, (z0 + z1) / 2) * Cylinder(radius, z1 - z0)


def prism_xz(points, y0, width):
    """Extrude an X-Z polygon along +Y."""
    wire = Wire.make_polygon([Vector(x, y0, z) for x, z in points], close=True)
    return extrude(Face(wire), amount=width, dir=(0, 1, 0))


def cut_side_polygon(shape, points, side, depth):
    """Cut a shallow angular panel pocket into one outer side (side = +/-1)."""
    if side > 0:
        cutter = prism_xz(points, SHELL_WIDTH / 2 + 0.01, -depth)
    else:
        cutter = prism_xz(points, -SHELL_WIDTH / 2 - 0.01, depth)
    return shape - cutter


def color_shape(shape, label, rgb):
    shape.label = label
    shape.color = Color(*rgb)
    return shape


def print_pose(shape, rotate=None):
    """Place a copy in a slicer-friendly origin; caller controls rotation."""
    s = shape
    if rotate is not None:
        s = rotate * s
    bb = s.bounding_box()
    return Pos(-bb.center().X, -bb.center().Y, -bb.min.Z) * s


def export_mesh(shape, filename, rotate=None, tol=0.12, ang=0.22):
    s = print_pose(shape, rotate)
    export_stl(s, str(STL / filename), tolerance=tol, angular_tolerance=ang)
    return s

# ---------------------------------------------------------------------------
# Main hollow shell. Body profile is a faceted wedge with a flat roof deck.
# ---------------------------------------------------------------------------
hx = SHELL_LENGTH / 2.0
hy = SHELL_WIDTH / 2.0
outer_profile = [
    (-hx, BODY_BOTTOM),
    ( hx, BODY_BOTTOM),
    ( hx, 96.0),
    (80.0, ROOF_Z),
    (35.0, ROOF_Z),
    (-60.0, ROOF_Z),
    (-110.0, 100.0),
    (-hx, 78.0),
]
# Inner cavity extends below the lower rim, leaving an open underside.
inner_profile = [
    (-hx + WALL, BODY_BOTTOM - 5.0),
    ( hx - WALL, BODY_BOTTOM - 5.0),
    ( hx - WALL, 94.0),
    (79.0, ROOF_Z - WALL),
    (34.0, ROOF_Z - WALL),
    (-59.0, ROOF_Z - WALL),
    (-108.5, 97.8),
    (-hx + WALL, 75.8),
]
outer = prism_xz(outer_profile, -hy, SHELL_WIDTH)
inner = prism_xz(inner_profile, -(hy - WALL), SHELL_WIDTH - 2 * WALL)
body = outer - inner

# Four true wheel wells. Cutter radius = 32.5 mm tire radius + 4.5 mm clearance.
wheel_r_cut = WHEEL_D / 2.0 + WHEEL_CLEARANCE_RADIAL
for wx in WHEEL_XS:
    body = body - cyl_y(-hy - 2, hy + 2, wx, WHEEL_Z, wheel_r_cut)

# Top access seat: a 50 x 94 mm opening with 62 x 106 mm cover land.
TOP_COVER_X = -24.0
TOP_HOLE_X = 50.0
TOP_HOLE_Y = 94.0
TOP_SEAT_X = 62.0
TOP_SEAT_Y = 106.0
body = body - box_at(TOP_SEAT_X, TOP_SEAT_Y, 2.5, TOP_COVER_X, 0, ROOF_Z - 1.25)
body = body - box_at(TOP_HOLE_X, TOP_HOLE_Y, 22.0, TOP_COVER_X, 0, ROOF_Z - 10.0)
# Front sensor openings through the vertical nose wall.
body = body - cyl_x(hx - 4, hx + 2, 0, CAMERA_LENS_Z, CAMERA_LENS_APERTURE / 2)
US_Z = 48.0
for y in (-HC_SR04_PITCH / 2, HC_SR04_PITCH / 2):
    body = body - cyl_x(hx - 4, hx + 2, y, US_Z, HC_SR04_APERTURE_D / 2)

# Camera carrier fasteners in the nose panel (M3 clearance).
CAM_Z = 79.0
CAM_BOLT_Y = (-22.0, 22.0)
CAM_BOLT_Z = (68.0, 90.0)
for y in CAM_BOLT_Y:
    for z in CAM_BOLT_Z:
        body = body - cyl_x(hx - 4, hx + 2, y, z, 1.7)

# Ultrasonic carrier fasteners in the nose panel (M3 clearance).
US_BOLT_Y = (-25.0, 25.0)
US_BOLT_Z = (39.0, 59.5)
for y in US_BOLT_Y:
    for z in US_BOLT_Z:
        body = body - cyl_x(hx - 4, hx + 2, y, z, 1.7)

# Service opening at the rear, with four fastener holes.
REAR_CX = -hx
REAR_Z = 56.0
body = body - box_at(8.0, 76.0, 31.0, REAR_CX, 0, REAR_Z)
REAR_BOLT_Y = (-34.0, 34.0)
REAR_BOLT_Z = (43.0, 69.0)
for y in REAR_BOLT_Y:
    for z in REAR_BOLT_Z:
        body = body - cyl_x(-hx - 2, -hx + 4, y, z, 1.7)

# Rear panel screw pilots are reinforced on the cavity side.
for y in REAR_BOLT_Y:
    for z in REAR_BOLT_Z:
        boss = cyl_x(-hx + WALL, -hx + WALL + 7.0, y, z, 4.6)
        body = body + boss
        body = body - cyl_x(-hx + WALL - 0.2, -hx + WALL + 7.2, y, z, 1.25)

# Chassis mounting shelves: adjustable hole positions in the source script.
for x in (-123.0, 123.0):
    for y in (-62.0, 62.0):
        # Each shelf overlaps the lower sidewall intentionally and sits clear
        # of the assumed tire swept volume.
        tab = box_at(14.0, 44.0, 3.2, x, y, BODY_BOTTOM + 2.0)
        body = body + tab
        body = body - cyl_z(BODY_BOTTOM - 1, BODY_BOTTOM + 6, x, y, 2.25)

# Roof cover M3 clearance holes. Use M3 bolts + nuts inside because no chassis
# or printer-specific insert standard was supplied.
TOP_SCREW_XS = (-43.0, -5.0)
TOP_SCREW_YS = (-49.5, 49.5)
for x in TOP_SCREW_XS:
    for y in TOP_SCREW_YS:
        body = body - cyl_z(ROOF_Z - 2.7, ROOF_Z + 1.0, x, y, 1.7)

# Roof-mounted PIR pedestal screws and wire pass-through.
PIR_BASE_X = 60.0
PIR_BASE_Y = 0.0
PIR_BOLT_X = (PIR_BASE_X - 11.0, PIR_BASE_X + 11.0)
PIR_BOLT_Y = (-15.0, 15.0)
for x in PIR_BOLT_X:
    for y in PIR_BOLT_Y:
        boss = cyl_z(109.0, ROOF_Z - WALL, x, y, 4.3)
        body = body + boss
        body = body - cyl_z(108.5, ROOF_Z + 1.0, x, y, 1.25)
        body = body - cyl_z(ROOF_Z - WALL - 0.1, ROOF_Z + 1.0, x, y, 1.7)
body = body - cyl_z(ROOF_Z - WALL - 0.1, ROOF_Z + 1.0, PIR_BASE_X, 0, 4.5)

# Replaceable police/medical identity panel areas: shallow angular relief + screw holes.
identity_profile = [(-47.0, 73.0), (-42.0, 96.0), (18.0, 96.0), (43.0, 83.0), (31.0, 69.0), (-22.0, 69.0)]
for side in (-1, 1):
    body = cut_side_polygon(body, identity_profile, side, 1.0)
    for x in (-34.0, 30.0):
        body = body - cyl_y((hy - 4 if side > 0 else -hy - 2), (hy + 2 if side > 0 else -hy + 4), x, 82.0, 1.45)

# Side/rear seam joiner features for a two-piece print split at X=30 mm.
SPLIT_X = 30.0
# Rear-half clearance ears, front-half pilot bosses, two side positions + one roof position.
seam_side_z = 75.0
for side in (-1, 1):
    y0 = side * 73.0
    rear_ear = box_at(8.0, 20.0, 22.0, SPLIT_X - 4.0, y0, seam_side_z)
    body = body + rear_ear
    body = body - cyl_x(SPLIT_X - 4.5, SPLIT_X + 0.5, y0, seam_side_z, 1.7)
    front_boss = box_at(9.0, 20.0, 20.0, SPLIT_X + 4.5, y0, seam_side_z)
    body = body + front_boss
    body = body - cyl_x(SPLIT_X - 0.2, SPLIT_X + 9.2, y0, seam_side_z, 1.25)
# Roof seam joiner
body = body + box_at(8.0, 24.0, 9.0, SPLIT_X - 4.0, 0, 114.0)
body = body - cyl_x(SPLIT_X - 4.5, SPLIT_X + 0.5, 0, 114.0, 1.7)
body = body + box_at(9.0, 22.0, 9.0, SPLIT_X + 4.5, 0, 114.0)
body = body - cyl_x(SPLIT_X - 0.2, SPLIT_X + 9.2, 0, 114.0, 1.25)

body = color_shape(body, "AETHER_Main_Body_Shell", (0.80, 0.84, 0.89))

# ---------------------------------------------------------------------------
# Removable top access cover, with locating plug and M3 clearance holes.
# ---------------------------------------------------------------------------
cover_flange = box_at(61.2, 105.2, 2.5, TOP_COVER_X, 0, ROOF_Z - 1.25)
cover_plug = box_at(49.2, 93.2, 6.0, TOP_COVER_X, 0, ROOF_Z - 2.5 - 3.0)
top_cover = cover_flange + cover_plug
for x in TOP_SCREW_XS:
    for y in TOP_SCREW_YS:
        top_cover = top_cover - cyl_z(ROOF_Z - 2.7, ROOF_Z + 0.1, x, y, 1.7)
top_cover = color_shape(top_cover, "AETHER_Removable_Top_Cover", (0.48, 0.53, 0.60))

# ---------------------------------------------------------------------------
# Front camera carrier: 27 x 40.5 mm board portrait pocket with aperture.
# Aperture offset assumes lens near the upper end; adjust CAMERA_LENS_Z.
# ---------------------------------------------------------------------------
cam_frame = box_at(3.5, 50.0, 30.0, hx - 4.25, 0, CAM_Z)
cam_frame = cam_frame - cyl_x(hx - 12.0, hx + 1.0, 0, CAMERA_LENS_Z, CAMERA_LENS_APERTURE / 2)
for y in CAM_BOLT_Y:
    for z in CAM_BOLT_Z:
        cam_frame = cam_frame - cyl_x(hx - 12.0, hx + 1.0, y, z, 1.7)
# Board edge cage behind the face plate; inner pocket approx 27.8 x 41.3 mm.
rail_x = hx - 8.0
for y in (-22.2, 22.2):
    cam_frame = cam_frame + box_at(5.5, 2.0, 29.0, rail_x, y, CAM_Z)
for z in (CAM_Z - 14.5, CAM_Z + 14.5):
    cam_frame = cam_frame + box_at(5.5, 44.0, 1.0, rail_x, 0, z)
# Notches in the cage allow board insertion/removal without trapping it.
cam_frame = color_shape(cam_frame, "AETHER_Front_Camera_Mount", (0.16, 0.23, 0.32))

# ---------------------------------------------------------------------------
# HC-SR04 carrier frame with two real openings and a rear cradle.
# ---------------------------------------------------------------------------
us_frame = box_at(3.5, 58.0, 30.0, hx - 4.25, 0, US_Z)
for y in (-HC_SR04_PITCH / 2, HC_SR04_PITCH / 2):
    us_frame = us_frame - cyl_x(hx - 12.0, hx + 1.0, y, US_Z, HC_SR04_APERTURE_D / 2)
for y in US_BOLT_Y:
    for z in US_BOLT_Z:
        us_frame = us_frame - cyl_x(hx - 12.0, hx + 1.0, y, z, 1.7)
# Back cradle bounds a 45 x 20 x 15 mm board envelope.
cradle_x = hx - 12.5
for y in (-25.5, 25.5):
    us_frame = us_frame + box_at(15.0, 3.0, 24.0, cradle_x, y, US_Z)
for z in (US_Z - 11.5, US_Z + 11.5):
    us_frame = us_frame + box_at(15.0, 51.0, 2.0, cradle_x, 0, z)
us_frame = color_shape(us_frame, "AETHER_Ultrasonic_Sensor_Mount", (0.19, 0.29, 0.39))

# ---------------------------------------------------------------------------
# HC-SR501 PIR roof bracket. The lens faces forward and 30 degrees upward.
# ---------------------------------------------------------------------------
# Horizontal foot on the roof, local bottom at z=120.
pir_foot = box_at(42.0, 46.0, 3.0, PIR_BASE_X, 0, ROOF_Z + 1.5)
for x in PIR_BOLT_X:
    for y in PIR_BOLT_Y:
        pir_foot = pir_foot - cyl_z(ROOF_Z - 0.1, ROOF_Z + 3.1, x, y, 1.7)
pir_foot = pir_foot - cyl_z(ROOF_Z - 0.1, ROOF_Z + 3.1, PIR_BASE_X, 0, 4.5)
# Face plate made in local coordinates, then tilted into forward/upward view.
pir_face_local = Box(5.0, 50.0, 40.0)
pir_face_local = pir_face_local - Cylinder(PIR_APERTURE_D / 2, 5.2, rotation=(0, 90, 0))
# Two tie slots retain the 32 x 24 mm HC-SR501 PCB at its upper/lower edges;
# the 24 mm aperture clears the nominal 23 mm Fresnel lens.
for z in (-15.5, 15.5):
    slot = Pos(0, 0, z) * Box(5.2, 8.0, 2.4)
    pir_face_local = pir_face_local - slot
PIR_FACE_CX = 61.0
PIR_FACE_CZ = 140.0
pir_face = Pos(PIR_FACE_CX, 0, PIR_FACE_CZ) * Rot(Y=-30) * pir_face_local
# Triangular cheek webs connect the tilted face to the roof foot.
web_a = prism_xz([(41.0, 121.0), (71.0, 121.0), (52.0, 157.0)], -18.0, 3.5)
web_b = prism_xz([(41.0, 121.0), (71.0, 121.0), (52.0, 157.0)], 14.5, 3.5)
pir_mount = pir_foot + pir_face + web_a + web_b
pir_mount = color_shape(pir_mount, "AETHER_Motion_Detector_Mount", (0.12, 0.17, 0.22))

# ---------------------------------------------------------------------------
# Removable rear service panel, with mounting holes and two cable ports.
# ---------------------------------------------------------------------------
rear_panel = box_at(2.5, 84.0, 38.0, -hx - 1.25, 0, REAR_Z)
for y in REAR_BOLT_Y:
    for z in REAR_BOLT_Z:
        rear_panel = rear_panel - cyl_x(-hx - 3.0, -hx, y, z, 1.7)
for y in (-14.0, 14.0):
    rear_panel = rear_panel - cyl_x(-hx - 3.0, -hx, y, REAR_Z, 3.0)
rear_panel = color_shape(rear_panel, "AETHER_Rear_Access_Panel", (0.73, 0.77, 0.82))

# ---------------------------------------------------------------------------
# Blank removable identity panel. Print two copies and use a blue/red insert,
# paint, or decal for the police/medical configuration.
# ---------------------------------------------------------------------------
ID_PROFILE = [(-43.0, 74.0), (-40.0, 93.0), (18.0, 93.0), (39.0, 83.0), (29.0, 72.0), (-20.0, 72.0)]
id_panel_left = prism_xz(ID_PROFILE, hy - 0.8, 1.8)
for x in (-34.0, 30.0):
    id_panel_left = id_panel_left - cyl_y(hy - 0.8, hy + 1.0, x, 82.0, 1.45)
id_panel_left = color_shape(id_panel_left, "AETHER_Identity_Panel_Blue", (0.10, 0.33, 0.72))
id_panel_right = prism_xz(ID_PROFILE, -hy - 1.0, 1.8)
for x in (-34.0, 30.0):
    id_panel_right = id_panel_right - cyl_y(-hy - 1.0, -hy + 0.8, x, 82.0, 1.45)
id_panel_right = color_shape(id_panel_right, "AETHER_Identity_Panel_Red", (0.78, 0.12, 0.15))

# ---------------------------------------------------------------------------
# Print-piece split halves, cropped from the complete shell at X=30.
# M3 x 16 mm screws through clearance ears into 2.5 mm pilot bosses.
# ---------------------------------------------------------------------------
rear_clip = box_at(SPLIT_X + hx, SHELL_WIDTH + 30, 200.0,
                   (SPLIT_X - hx) / 2.0, 0, 80.0)
front_clip = box_at(hx - SPLIT_X, SHELL_WIDTH + 30, 200.0,
                    (SPLIT_X + hx) / 2.0, 0, 80.0)
rear_half = body & rear_clip
front_half = body & front_clip
if isinstance(rear_half, ShapeList):
    rear_half = Compound(children=list(rear_half))
if isinstance(front_half, ShapeList):
    front_half = Compound(children=list(front_half))
rear_half.label = "AETHER_Main_Body_Rear_Half"
front_half.label = "AETHER_Main_Body_Front_Half"

# ---------------------------------------------------------------------------
# Exports. Full-body STL is useful as the complete reference; the two halves
# are the recommended print files for a typical 220 mm class bed.
# ---------------------------------------------------------------------------
# STEP BREP files (source geometry, world coordinates).
export_step(body, str(OUT / "AETHER_Main_Body_Shell.step"))
parts = [body, top_cover, cam_frame, us_frame, pir_mount, rear_panel, id_panel_left, id_panel_right]
assembly = Compound(children=parts)
assembly.label = "AETHER_Rover_Enclosure_Assembly"
export_step(assembly, str(OUT / "AETHER_Rover_Assembly.step"))

# Visual-only wheel envelopes show the assumed 4WD layout. They are not part
# of the body STL set or claimed to represent the user's measured chassis.
wheel_refs = []
for i, (wx, wy) in enumerate([(x, y) for x in WHEEL_XS for y in WHEEL_YS], 1):
    wheel_ref = Pos(wx, wy, WHEEL_Z) * Rot(X=90) * Cylinder(WHEEL_D / 2, WHEEL_W)
    wheel_ref = color_shape(wheel_ref, f"Reference_Wheel_Envelope_{i}", (0.08, 0.10, 0.13))
    wheel_refs.append(wheel_ref)
fit_preview = Compound(children=parts + wheel_refs)
fit_preview.label = "AETHER_4WD_Fit_Reference_Assembly"
export_step(fit_preview, str(OUT / "AETHER_Fit_Reference_Assembly.step"))

# Full body STL and print-sized split halves. Roof-down orientation for the
# shell halves provides the broadest stable bed contact and open underside up.
export_mesh(body, "AETHER_Main_Body_Shell.stl", rotate=Rot(X=180), tol=0.18, ang=0.25)
export_mesh(rear_half, "AETHER_Main_Body_Rear_Half.stl", rotate=Rot(X=180), tol=0.18, ang=0.25)
export_mesh(front_half, "AETHER_Main_Body_Front_Half.stl", rotate=Rot(X=180), tol=0.18, ang=0.25)
export_mesh(top_cover, "AETHER_Removable_Top_Cover.stl", tol=0.08, ang=0.18)
export_mesh(cam_frame, "AETHER_Front_Camera_Mount.stl", rotate=Rot(Y=90), tol=0.08, ang=0.18)
export_mesh(us_frame, "AETHER_Ultrasonic_Sensor_Mount.stl", rotate=Rot(Y=90), tol=0.08, ang=0.18)
export_mesh(pir_mount, "AETHER_Motion_Detector_Mount.stl", tol=0.12, ang=0.2)
export_mesh(rear_panel, "AETHER_Rear_Access_Panel.stl", rotate=Rot(Y=90), tol=0.08, ang=0.18)
export_mesh(id_panel_left, "AETHER_Interchangeable_ID_Panel.stl", rotate=Rot(X=90), tol=0.08, ang=0.18)

# Geometry verification metrics. Wheel cylinders are reference envelopes only.
wheel_clearance = []
for wx in WHEEL_XS:
    for wy in WHEEL_YS:
        wheel = Pos(wx, wy, WHEEL_Z) * Rot(X=90) * Cylinder(WHEEL_D / 2, WHEEL_W)
        overlap_shape = body & wheel
        overlap = float(overlap_shape.volume) if overlap_shape is not None else 0.0
        wheel_clearance.append({"center_x": wx, "center_y": wy, "overlap_mm3": overlap})

shapes = {
    "body_shell": body,
    "top_cover": top_cover,
    "camera_mount": cam_frame,
    "ultrasonic_mount": us_frame,
    "motion_detector_mount": pir_mount,
    "rear_access_panel": rear_panel,
    "identity_panel_left": id_panel_left,
    "identity_panel_right": id_panel_right,
    "rear_body_half": rear_half,
    "front_body_half": front_half,
}
metrics = {"assumption": {
    "chassis_envelope_mm": [CHASSIS_L, CHASSIS_W, CHASSIS_H],
    "wheel_diameter_mm": WHEEL_D,
    "wheel_width_mm": WHEEL_W,
    "wheelbase_assumed_mm": WHEELBASE,
    "track_assumed_mm": TRACK,
    "ultrasonic_pitch_assumed_mm": HC_SR04_PITCH,
    "body_split_x_mm": SPLIT_X,
    "coordinate_system": "+X front, +Y left, +Z up",
}, "parts": {}, "wheel_intersections": wheel_clearance}
for name, shape in shapes.items():
    bb = shape.bounding_box()
    metrics["parts"][name] = {
        "valid": bool(shape.is_valid),
        "volume_mm3": float(shape.volume),
        "bbox_mm": [float(bb.size.X), float(bb.size.Y), float(bb.size.Z)],
        "solid_count": len(shape.solids()),
    }
(OUT / "geometry_metrics.json").write_text(json.dumps(metrics, indent=2))
print(json.dumps(metrics, indent=2))
