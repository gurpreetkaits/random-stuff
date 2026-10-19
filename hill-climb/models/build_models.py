"""Builds the game's 3D models in Blender and exports them as GLB.

Run:  npm run models
      (= blender -b --factory-startup -P models/build_models.py)

Units are meters. The car is modelled along +X (front), Z up, Y across; the
glTF exporter converts to Y-up, so in three.js the car faces +X and its
left side (Blender -Y) faces the camera at +Z.

The body's origin is the physics centre of mass. Measurements match the
physics in src/physics.js (40 px = 1 m): wheel radius 0.45, wheels at
x = -1.0 / +1.05, driver's head at (-0.2, 1.15), roll bar top at (-0.75, 0.95).
"""
import bpy
import bmesh
import math
import os
import random
from mathutils import Vector

OUT = os.path.dirname(os.path.realpath(__file__))
random.seed(7)


# ---------------------------------------------------------------- helpers
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    MATS.clear()


def srgb(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]


MATS = {}


def mat(name, color, metal=0.0, rough=0.6, emit=0.0, alpha=1.0):
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    if m.node_tree is None:
        m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    col = (*srgb(color), 1.0)
    b.inputs['Base Color'].default_value = col
    b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    if emit:
        b.inputs['Emission Color'].default_value = col
        b.inputs['Emission Strength'].default_value = emit
    if alpha < 1.0:
        b.inputs['Alpha'].default_value = alpha
        for attr, val in (('surface_render_method', 'BLENDED'), ('blend_method', 'BLEND')):
            try:
                setattr(m, attr, val)
            except Exception:
                pass
    MATS[name] = m
    return m


def obj():
    return bpy.context.active_object


def assign(o, m):
    o.data.materials.clear()
    o.data.materials.append(m)
    return o


def select_only(o):
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o


def bevel(o, width=0.03, segments=2):
    md = o.modifiers.new('bevel', 'BEVEL')
    md.width = width
    md.segments = segments
    md.limit_method = 'ANGLE'
    return o


def shade(o, angle=35):
    select_only(o)
    try:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle))
    except Exception:
        bpy.ops.object.shade_smooth()


def flat(o):
    select_only(o)
    bpy.ops.object.shade_flat()


def box(size, loc, m, bev=0.03, rot=(0, 0, 0), seg=2):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = obj()
    o.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    assign(o, m)
    if bev:
        bevel(o, bev, seg)
    return o


def cyl(r, depth, loc, m, rot=(0, 0, 0), verts=24, bev=0.0):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=loc, rotation=rot)
    o = assign(obj(), m)
    if bev:
        bevel(o, bev, 2)
    return o


def tube(p1, p2, r, m, verts=10):
    p1, p2 = Vector(p1), Vector(p2)
    d = p2 - p1
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=d.length, location=(p1 + p2) / 2)
    o = obj()
    o.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    return assign(o, m)


def ball(r, loc, m, scale=(1, 1, 1), seg=20, rings=12):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=rings, radius=r, location=loc)
    o = obj()
    o.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return assign(o, m)


def ico(r, loc, m, sub=1, jitter=0.0, scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=sub, radius=r, location=loc)
    o = obj()
    if jitter:
        for v in o.data.vertices:
            v.co += Vector([random.uniform(-jitter, jitter) for _ in range(3)])
    o.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return assign(o, m)


def cone(r1, r2, depth, loc, m, verts=8):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r1, radius2=r2, depth=depth, location=loc)
    return assign(obj(), m)


def torus(R, r, loc, m, rot=(0, 0, 0), major=32, minor=12):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, major_segments=major,
                                     minor_segments=minor, location=loc, rotation=rot)
    return assign(obj(), m)


def solid_from(verts, faces, m, name='mesh'):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o)
    return assign(o, m)


def arch(cx, cz, r_in, r_out, y0, y1, a0, a1, m, n=14):
    """Curved wheel-arch flare: a ring segment in XZ extruded across Y."""
    verts, faces = [], []
    for i in range(n + 1):
        a = math.radians(a0 + (a1 - a0) * i / n)
        for r in (r_in, r_out):
            for y in (y0, y1):
                verts.append((cx + r * math.cos(a), y, cz + r * math.sin(a)))
    for i in range(n):
        b, c = i * 4, (i + 1) * 4
        # verts per step: 0 in/y0, 1 in/y1, 2 out/y0, 3 out/y1
        faces += [(b + 2, b + 3, c + 3, c + 2), (b, c, c + 1, b + 1),
                  (b, b + 2, c + 2, c), (b + 1, c + 1, c + 3, b + 3)]
    faces += [(0, 1, 3, 2), (n * 4, n * 4 + 2, n * 4 + 3, n * 4 + 1)]
    o = solid_from(verts, faces, m, 'arch')
    bevel(o, 0.015, 2)
    return o


def text_mesh(s, loc, size, m, rot=(math.radians(90), 0, 0), extrude=0.01):
    try:
        bpy.ops.object.text_add(location=loc, rotation=rot)
        t = obj()
        t.data.body = s
        t.data.size = size
        t.data.extrude = extrude
        t.data.align_x = 'CENTER'
        t.data.align_y = 'CENTER'
        bpy.ops.object.convert(target='MESH')
        return assign(obj(), m)
    except Exception as e:  # fonts unavailable: skip decal
        print('text skipped:', e)
        return None


def finish(parts, name, smooth_angle=35):
    """Apply modifiers, join into one object named `name`, origin at world 0."""
    parts = [p for p in parts if p is not None]
    for p in parts:
        select_only(p)
        for md in list(p.modifiers):
            bpy.ops.object.modifier_apply(modifier=md.name)
        # bake rotation/scale into the mesh so the exported node has an identity transform
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    bpy.ops.object.select_all(action='DESELECT')
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    if len(parts) > 1:
        bpy.ops.object.join()
    o = obj()
    o.name = name
    o.data.name = name
    bpy.context.scene.cursor.location = (0, 0, 0)
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    if smooth_angle:
        shade(o, smooth_angle)
    else:
        flat(o)
    return o


def export(path, objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True,
                              export_apply=True, export_yup=True)
    print('exported', path)


# ---------------------------------------------------------------- the car
def build_car():
    reset()
    paint = mat('Paint', '#d62f26', metal=0.35, rough=0.32)
    paint_dark = mat('PaintDark', '#9e1c16', metal=0.3, rough=0.4)
    black = mat('Trim', '#1d1f22', rough=0.7)
    steel = mat('Steel', '#3a3f46', metal=0.8, rough=0.35)
    chrome = mat('Chrome', '#d9dde2', metal=1.0, rough=0.12)
    white = mat('Stripe', '#f3efe6', rough=0.5)
    glass = mat('Glass', '#9fd6ff', metal=0.0, rough=0.05, alpha=0.32)
    light = mat('Headlight', '#fff3c4', emit=3.0, rough=0.2)
    tail = mat('Taillight', '#ff2a1a', emit=2.5, rough=0.3)
    seat = mat('Seat', '#2a2522', rough=0.8)
    jacket = mat('Jacket', '#2f6fb3', rough=0.75)
    skin = mat('Skin', '#f0c39c', rough=0.6)
    helmet = mat('Helmet', '#f2c230', metal=0.1, rough=0.3)
    visor = mat('Visor', '#1a2633', metal=0.6, rough=0.1)
    glove = mat('Glove', '#222222', rough=0.8)
    tyre = mat('Tyre', '#1b1b1b', rough=0.9)
    flag = mat('Flag', '#ff7a1a', rough=0.7)

    p = []
    # tub and hood
    p.append(box((3.1, 1.4, 0.5), (0, 0, -0.13), paint, bev=0.07, seg=3))
    p.append(box((1.15, 1.3, 0.2), (1.0, 0, 0.2), paint, bev=0.06, seg=3, rot=(0, math.radians(3), 0)))
    p.append(box((0.6, 1.0, 0.04), (1.05, 0, 0.31), paint_dark, bev=0.015))      # hood scoop plate
    p.append(box((0.3, 0.5, 0.1), (1.1, 0, 0.35), black, bev=0.03))             # scoop
    # sill stripe and lower panels
    for y in (-0.705, 0.705):
        p.append(box((2.7, 0.01, 0.07), (0.05, y, 0.02), white, bev=0))
        p.append(box((2.9, 0.02, 0.12), (0, y * 1.01, -0.33), paint_dark, bev=0.01))
    # race number on the camera side (Blender -Y)
    p.append(cyl(0.2, 0.02, (-0.1, -0.71, -0.12), white, rot=(math.radians(90), 0, 0), verts=32))
    p.append(text_mesh('7', (-0.1, -0.725, -0.12), 0.3, black))
    # grille, lights, bumpers
    p.append(box((0.06, 0.95, 0.32), (1.565, 0, -0.06), black, bev=0.015))
    for i in range(5):
        p.append(box((0.03, 0.04, 0.26), (1.6, -0.32 + i * 0.16, -0.06), chrome, bev=0.008))
    for y in (-0.5, 0.5):
        p.append(cyl(0.1, 0.06, (1.57, y, 0.1), chrome, rot=(0, math.radians(90), 0), verts=20))
        p.append(cyl(0.08, 0.06, (1.6, y, 0.1), light, rot=(0, math.radians(90), 0), verts=20))
        p.append(box((0.04, 0.16, 0.1), (-1.56, y, 0.02), tail, bev=0.01))
    p.append(box((0.16, 1.55, 0.15), (1.66, 0, -0.32), steel, bev=0.04))
    p.append(box((0.16, 1.55, 0.15), (-1.63, 0, -0.32), steel, bev=0.04))
    for y in (-0.35, 0.35):                                                     # bull bar
        p.append(tube((1.68, y, -0.28), (1.72, y, 0.12), 0.03, steel))
    p.append(tube((1.72, -0.4, 0.12), (1.72, 0.4, 0.12), 0.03, steel))
    # wheel arches (rest wheel centres sit ~0.25 below the CoM)
    for cx in (-1.0, 1.05):
        for y0, y1 in ((-0.98, -0.6), (0.6, 0.98)):
            p.append(arch(cx, -0.25, 0.52, 0.6, y0, y1, 8, 172, black))
    # side steps
    for y in (-0.76, 0.76):
        p.append(box((0.75, 0.16, 0.05), (0.02, y, -0.36), steel, bev=0.015))
    # windshield frame + glass
    for y in (-0.6, 0.6):
        p.append(tube((0.55, y, 0.28), (0.32, y, 0.86), 0.035, steel))
    p.append(tube((0.32, -0.62, 0.86), (0.32, 0.62, 0.86), 0.035, steel))
    p.append(box((0.03, 1.15, 0.58), (0.44, 0, 0.57), glass, bev=0, rot=(0, math.radians(-22), 0)))
    # roll cage
    for y in (-0.62, 0.62):
        p.append(tube((-1.25, y, 0.1), (-0.8, y, 0.97), 0.045, steel))
        p.append(tube((-0.8, y, 0.97), (0.32, y, 0.86), 0.04, steel))
        p.append(tube((-1.35, y, 0.12), (-1.0, y, 0.6), 0.03, steel))
    p.append(tube((-0.8, -0.64, 0.97), (-0.8, 0.64, 0.97), 0.045, steel))
    p.append(tube((-1.1, -0.62, 0.55), (-1.1, 0.62, 0.55), 0.035, steel))
    # seat, steering, dashboard
    p.append(box((0.55, 0.62, 0.14), (-0.35, 0, 0.18), seat, bev=0.05))
    p.append(box((0.14, 0.62, 0.65), (-0.62, 0, 0.5), seat, bev=0.05, rot=(0, math.radians(-10), 0)))
    p.append(box((0.25, 1.2, 0.18), (0.48, 0, 0.27), black, bev=0.04))
    p.append(tube((0.45, 0, 0.3), (0.25, 0, 0.5), 0.025, steel))
    p.append(torus(0.15, 0.025, (0.24, 0, 0.52), black, rot=(0, math.radians(-60), 0), major=24, minor=8))
    # driver
    p.append(ball(0.26, (-0.32, 0, 0.55), jacket, scale=(0.75, 0.95, 1.25)))
    p.append(tube((-0.28, 0, 0.8), (-0.22, 0, 0.96), 0.08, skin))
    for y in (-0.22, 0.22):
        p.append(tube((-0.3, y, 0.74), (0.0, y * 0.8, 0.52), 0.065, jacket))
        p.append(tube((0.0, y * 0.8, 0.52), (0.2, y * 0.55, 0.55), 0.055, jacket))
        p.append(ball(0.06, (0.22, y * 0.5, 0.55), glove))
        p.append(tube((-0.2, y * 0.6, 0.25), (0.3, y * 0.6, 0.3), 0.08, jacket))   # thighs
        p.append(tube((0.3, y * 0.6, 0.3), (0.45, y * 0.6, -0.1), 0.07, jacket))   # shins
    p.append(ball(0.21, (-0.17, 0, 1.13), skin))
    p.append(ball(0.275, (-0.22, 0, 1.17), helmet, scale=(1.0, 0.95, 0.92)))
    p.append(box((0.08, 0.36, 0.15), (0.03, 0, 1.13), visor, bev=0.035, rot=(0, math.radians(-8), 0)))
    # spare tyre, exhaust, antenna flag
    p.append(torus(0.24, 0.1, (-1.66, 0, 0.32), tyre, rot=(0, math.radians(90), 0), major=24, minor=10))
    p.append(cyl(0.15, 0.12, (-1.66, 0, 0.32), steel, rot=(0, math.radians(90), 0), verts=16))
    p.append(tube((-0.9, -0.55, -0.36), (-1.66, -0.55, -0.36), 0.05, chrome))
    p.append(cyl(0.065, 0.1, (-1.7, -0.55, -0.36), black, rot=(0, math.radians(90), 0), verts=14))
    p.append(tube((-1.3, 0.55, 0.12), (-1.45, 0.55, 1.65), 0.012, steel, verts=6))
    p.append(solid_from([(-1.44, 0.55, 1.62), (-1.43, 0.55, 1.36), (-1.86, 0.55, 1.5),
                         (-1.44, 0.57, 1.62), (-1.43, 0.57, 1.36), (-1.86, 0.57, 1.5)],
                        [(0, 1, 2), (3, 5, 4), (0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)], flag, 'flag'))
    body = finish(p, 'CarBody', smooth_angle=40)

    # wheel (axis along Blender Y), origin at its centre
    rim = mat('Rim', '#c7a43a', metal=0.9, rough=0.3)
    hub = mat('Hub', '#2c2f33', metal=0.7, rough=0.4)
    w = []
    t = torus(0.32, 0.13, (0, 0, 0), tyre, rot=(math.radians(90), 0, 0), major=40, minor=14)
    t.scale = (1, 1, 1.35)   # local Z is the tyre axis after the X rotation: widen the tread, keep it round
    select_only(t)
    bpy.ops.object.transform_apply(scale=True)
    w.append(t)
    for i in range(22):                                                         # tread lugs
        a = i * 2 * math.pi / 22
        w.append(box((0.09, 0.15, 0.06), (0.43 * math.cos(a), 0.09 * (1 if i % 2 else -1), 0.43 * math.sin(a)),
                     tyre, bev=0.012, rot=(0, -a + math.pi / 2, 0)))
    w.append(cyl(0.24, 0.3, (0, 0, 0), hub, rot=(math.radians(90), 0, 0), verts=32))
    w.append(cyl(0.225, 0.04, (0, -0.15, 0), rim, rot=(math.radians(90), 0, 0), verts=32, bev=0.01))
    for i in range(6):
        a = i * math.pi / 3
        w.append(box((0.2, 0.04, 0.05), (0.11 * math.cos(a), -0.17, 0.11 * math.sin(a)), rim, bev=0.01,
                     rot=(0, -a, 0)))
    w.append(cyl(0.07, 0.06, (0, -0.19, 0), chrome, rot=(math.radians(90), 0, 0), verts=16, bev=0.01))
    for i in range(5):
        a = i * 2 * math.pi / 5
        w.append(cyl(0.015, 0.04, (0.1 * math.cos(a), -0.19, 0.1 * math.sin(a)), chrome,
                     rot=(math.radians(90), 0, 0), verts=6))
    wheel = finish(w, 'Wheel', smooth_angle=50)

    export(os.path.join(OUT, 'car.glb'), [body, wheel])


# ---------------------------------------------------------------- props
def build_props():
    reset()
    gold = mat('Gold', '#f2b522', metal=1.0, rough=0.28)
    gold_dark = mat('GoldDark', '#b8800f', metal=1.0, rough=0.35)
    can_red = mat('CanRed', '#d8342c', metal=0.3, rough=0.45)
    cap = mat('CanCap', '#f2c230', metal=0.4, rough=0.4)
    bark = mat('Bark', '#6b4528', rough=0.95)
    pine = mat('Pine', '#2f6b3a', rough=0.9)
    leaf = mat('Leaf', '#5c9e3c', rough=0.9)
    leaf2 = mat('Leaf2', '#7ab648', rough=0.9)
    stone = mat('Stone', '#8b8f8e', rough=0.95)
    wood = mat('Wood', '#9a6a3f', rough=0.9)
    cloud = mat('Cloud', '#ffffff', rough=1.0)
    out = []

    # coin: faces the camera (axis along Blender Y)
    c = [cyl(0.3, 0.07, (0, 0, 0), gold, rot=(math.radians(90), 0, 0), verts=32, bev=0.012),
         torus(0.26, 0.025, (0, -0.035, 0), gold_dark, rot=(math.radians(90), 0, 0), major=32, minor=6),
         torus(0.26, 0.025, (0, 0.035, 0), gold_dark, rot=(math.radians(90), 0, 0), major=32, minor=6)]
    star = []
    for i in range(10):
        a = math.pi / 2 + i * math.pi / 5
        r = 0.17 if i % 2 == 0 else 0.07
        star.append((r * math.cos(a), r * math.sin(a)))
    for side in (-1, 1):
        y0, y1 = side * 0.035, side * 0.06
        verts = [(x, y0, z) for x, z in star] + [(x, y1, z) for x, z in star] + [(0, y0, 0), (0, y1, 0)]
        faces = []
        for i in range(10):
            j = (i + 1) % 10
            faces += [(i, j, j + 10, i + 10), (20, j, i), (21, i + 10, j + 10)]
        c.append(solid_from(verts, faces, gold_dark, 'star'))
    out.append(finish(c, 'Coin', smooth_angle=45))

    # jerry can
    f = [box((0.5, 0.24, 0.62), (0, 0, 0), can_red, bev=0.05, seg=3)]
    for y in (-0.125, 0.125):
        f.append(box((0.36, 0.01, 0.04), (0, y, 0), can_red, bev=0.005, rot=(0, math.radians(52), 0)))
        f.append(box((0.36, 0.01, 0.04), (0, y, 0), can_red, bev=0.005, rot=(0, math.radians(-52), 0)))
    for x in (-0.16, -0.02):
        f.append(tube((x, 0, 0.3), (x, 0, 0.4), 0.025, can_red))
    f.append(tube((-0.18, 0, 0.4), (0.0, 0, 0.4), 0.03, can_red))
    f.append(tube((0.14, 0, 0.3), (0.22, 0, 0.42), 0.05, cap))
    out.append(finish(f, 'FuelCan', smooth_angle=40))

    # trees and scenery (base at z = 0)
    t = [cyl(0.12, 0.8, (0, 0, 0.4), bark, verts=7)]
    for i, (r, z) in enumerate(((1.0, 1.2), (0.8, 1.9), (0.55, 2.55))):
        t.append(cone(r, 0.0, 1.3, (0, 0, z), pine, verts=8))
    out.append(finish(t, 'TreePine', smooth_angle=0))

    t = [cone(0.16, 0.1, 1.4, (0, 0, 0.7), bark, verts=7)]
    t.append(ico(0.85, (0, 0, 1.9), leaf, sub=1, jitter=0.08))
    t.append(ico(0.6, (0.55, 0.2, 1.6), leaf2, sub=1, jitter=0.06))
    t.append(ico(0.55, (-0.5, -0.15, 1.7), leaf2, sub=1, jitter=0.06))
    out.append(finish(t, 'TreeRound', smooth_angle=0))

    out.append(finish([ico(0.6, (0, 0, 0.25), stone, sub=1, jitter=0.14, scale=(1.3, 1.0, 0.75))],
                      'Rock', smooth_angle=0))
    out.append(finish([ico(0.42, (0, 0, 0.3), leaf, sub=1, jitter=0.05),
                       ico(0.32, (0.4, 0.1, 0.22), leaf2, sub=1, jitter=0.05),
                       ico(0.3, (-0.38, -0.05, 0.2), leaf2, sub=1, jitter=0.05)], 'Bush', smooth_angle=0))

    fence = []
    for x in (-1.5, 0.0, 1.5):
        fence.append(box((0.12, 0.12, 1.0), (x, 0, 0.5), wood, bev=0.02))
    for z in (0.45, 0.8):
        fence.append(box((3.2, 0.06, 0.13), (0, 0.07, z), wood, bev=0.015))
    out.append(finish(fence, 'Fence', smooth_angle=0))

    cl = [ico(1.4, (0, 0, 0), cloud, sub=2, jitter=0.1),
          ico(1.0, (1.4, 0, -0.3), cloud, sub=2, jitter=0.08),
          ico(1.1, (-1.5, 0.2, -0.25), cloud, sub=2, jitter=0.08),
          ico(0.8, (2.4, -0.1, -0.5), cloud, sub=1, jitter=0.06)]
    out.append(finish(cl, 'Cloud', smooth_angle=0))

    # signpost: board front faces the camera (Blender -Y); the label is drawn in three.js
    s = [box((0.12, 0.12, 1.9), (0, 0, 0.95), wood, bev=0.02),
         box((1.3, 0.08, 0.55), (0, -0.1, 1.75), wood, bev=0.03)]
    out.append(finish(s, 'Sign', smooth_angle=0))

    export(os.path.join(OUT, 'props.glb'), out)


build_car()
build_props()
