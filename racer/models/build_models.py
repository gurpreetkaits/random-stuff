"""Builds the racer's 3D models in Blender and exports them as GLB.

Run:  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P models/build_models.py

Conventions (the game depends on these):
  * Meters. Blender: car FRONT points to -Y, up is +Z, centred on X = 0.
    The glTF exporter (export_yup) turns Blender -Y into three.js +Z, so the car faces +Z in game.
  * CarBody origin = ground under the car centre. Tyres touch Z = 0.
    Wheelbase 2.7 (axles at Y = -1.35 / +1.35), wheel centres at X = +-0.84, Z = 0.34.
  * Wheel origin = wheel centre, axle along X, rim face (spokes) on +X.
  * Every exported node has an identity rotation/scale (transforms are baked).
"""
import bpy
import bmesh
import math
import os
import random
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

OUT = os.path.dirname(os.path.realpath(__file__))
random.seed(11)

WHEEL_R = 0.34
WHEEL_W = 0.27
TRACK_X = 0.84
AXLE_Y = 1.35


# ---------------------------------------------------------------- helpers
MATS = {}


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    MATS.clear()


def srgb(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]


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
    m.diffuse_color = col[:3] + (alpha,)
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


def box(size, loc, m, bev=0.0, rot=(0, 0, 0), seg=2):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = obj()
    o.scale = size          # local axes: scale before the rotation is baked
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


def fix_normals(o):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()


def solid_from(verts, faces, m, name='mesh', normals=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o)
    assign(o, m)
    if normals:
        fix_normals(o)
    return o


def revolve(profile, m, axis='X', n=32, a0=0.0, a1=2 * math.pi, name='rev'):
    """Revolve a closed (r, h) profile around `axis`. A partial sweep gets end caps."""
    full = abs(a1 - a0 - 2 * math.pi) < 1e-6
    steps = n if full else n + 1
    k = len(profile)
    verts, faces = [], []
    for i in range(steps):
        a = a0 + (a1 - a0) * i / n
        ca, sa = math.cos(a), math.sin(a)
        for r, h in profile:
            if axis == 'X':
                verts.append((h, r * ca, r * sa))
            else:
                verts.append((r * ca, r * sa, h))
    for i in range(n):
        i2 = (i + 1) % steps
        for j in range(k):
            j2 = (j + 1) % k
            faces.append((i * k + j, i * k + j2, i2 * k + j2, i2 * k + j))
    if not full:
        faces.append(tuple(range(k)))
        faces.append(tuple(n * k + j for j in range(k)))
    return solid_from(verts, faces, m, name)


def extrude_x(profile_yz, x0, x1, m, name='ext'):
    """Extrude a closed (y, z) polygon along X."""
    k = len(profile_yz)
    verts = [(x0, y, z) for y, z in profile_yz] + [(x1, y, z) for y, z in profile_yz]
    faces = [tuple(range(k)), tuple(range(2 * k - 1, k - 1, -1))]
    for j in range(k):
        j2 = (j + 1) % k
        faces.append((j, j2, k + j2, k + j))
    return solid_from(verts, faces, m, name)


def extrude_z(profile_xy, z0, z1, m, name='extz'):
    k = len(profile_xy)
    verts = [(x, y, z0) for x, y in profile_xy] + [(x, y, z1) for x, y in profile_xy]
    faces = [tuple(range(k)), tuple(range(2 * k - 1, k - 1, -1))]
    for j in range(k):
        j2 = (j + 1) % k
        faces.append((j, j2, k + j2, k + j))
    return solid_from(verts, faces, m, name)


def finish(parts, name, smooth_angle=35):
    """Apply modifiers, bake transforms, join into one object named `name`, origin at world 0."""
    parts = [p for p in parts if p is not None]
    for p in parts:
        select_only(p)
        for md in list(p.modifiers):
            bpy.ops.object.modifier_apply(modifier=md.name)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
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


# ---------------------------------------------------------------- curves
def spline(keys, t):
    """Catmull-Rom through (t, value) keys, clamped outside the range."""
    if t <= keys[0][0]:
        return keys[0][1]
    if t >= keys[-1][0]:
        return keys[-1][1]
    for i in range(len(keys) - 1):
        if keys[i][0] <= t <= keys[i + 1][0]:
            break
    p0 = keys[max(i - 1, 0)][1]
    p1 = keys[i][1]
    p2 = keys[i + 1][1]
    p3 = keys[min(i + 2, len(keys) - 1)][1]
    u = (t - keys[i][0]) / (keys[i + 1][0] - keys[i][0])
    return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u
                  + (-p0 + 3 * p1 - 3 * p2 + p3) * u ** 3)


def smoothstep(a, b, t):
    t = min(max((t - a) / (b - a), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


# ---------------------------------------------------------------- the car hull
# Longitudinal shape keys, y from the nose (-Y) to the tail (+Y).
Y_NOSE, Y_TAIL = -2.2, 2.2

K_WMAX = [(-2.2, 0.72), (-2.08, 0.87), (-1.9, 0.94), (-1.6, 0.972), (-1.35, 0.978), (-1.05, 0.968),
          (-0.6, 0.935), (-0.1, 0.925), (0.4, 0.935), (0.9, 0.97), (1.35, 0.978), (1.75, 0.972),
          (2.0, 0.955), (2.2, 0.90)]
K_ZB = [(-2.2, 0.17), (-2.0, 0.135), (-1.7, 0.125), (1.6, 0.125), (1.95, 0.17), (2.2, 0.24)]
K_ZS = [(-2.2, 0.36), (-1.98, 0.54), (-1.7, 0.75), (-1.35, 0.835), (-1.0, 0.8), (-0.6, 0.765),
        (0.0, 0.78), (0.6, 0.845), (1.0, 0.9), (1.35, 0.93), (1.8, 0.905), (2.2, 0.86)]
K_TOP = [(-2.2, 0.37), (-1.98, 0.52), (-1.6, 0.675), (-1.3, 0.75), (-0.9, 0.775), (-0.55, 0.92),
         (-0.2, 1.10), (0.1, 1.185), (0.4, 1.17), (0.8, 1.07), (1.2, 0.975), (1.55, 0.925),
         (1.9, 0.895), (2.2, 0.87)]
K_BELT = [(-0.9, 0.77), (-0.5, 0.795), (0.2, 0.825), (0.8, 0.88), (1.3, 0.93)]

# profile segment ids (between consecutive key points P0..P9)
SEG_BOTTOM, SEG_LOW, SEG_SIDE, SEG_SHOULDER, SEG_DECK, SEG_WINDOW, SEG_RAIL, SEG_ROOF1, SEG_ROOF2 = range(9)
SUB = 3   # samples per profile segment


def cabin(y):
    return smoothstep(-1.0, -0.72, y) * (1 - smoothstep(0.85, 1.6, y))


def key_points(y):
    wmax = spline(K_WMAX, y)
    zb = spline(K_ZB, y)
    zs = spline(K_ZS, y)
    ztop = spline(K_TOP, y)
    zbelt = min(spline(K_BELT, y), ztop)
    c = cabin(y)
    ws = wmax - 0.065
    g = lerp(1.0, 0.93, smoothstep(0.2, 1.1, y))        # greenhouse tapers in plan towards the tail
    h = ztop - zbelt
    pts = [
        (0.0, zb),                                   # P0 bottom centre
        (wmax - 0.07, zb),                           # P1 sill underside
        (wmax - 0.005, zb + 0.36 * (zs - zb)),       # P2 lower side
        (wmax, zb + 0.80 * (zs - zb)),               # P3 upper side (widest)
        (ws + 0.02, zs),                             # P4 fender / shoulder crest
        (lerp(ws * 0.86, 0.80 * g, c), zbelt),       # P5 window line
        (lerp(ws * 0.66, 0.635 * g, c), zbelt + h * 0.80),   # P6 window top
        (lerp(ws * 0.60, 0.585 * g, c), zbelt + h * 0.89),   # P7 roof rail
        (lerp(ws * 0.32, 0.35 * g, c), zbelt + h * 0.975 + 0.012 * (1 - c)),  # P8 roof
        (0.0, ztop + 0.015 * (1 - c)),               # P9 centre top
    ]
    return pts


def sample_profile(pts):
    """Catmull-Rom through the half-profile; returns (points, segment id per edge)."""
    ext = [(-pts[1][0], pts[1][1])] + pts + [(-pts[-2][0], pts[-2][1])]
    out, segs = [], []
    for i in range(len(pts) - 1):
        p0, p1, p2, p3 = (Vector(ext[i + j]) for j in range(4))
        for s in range(SUB):
            u = s / SUB
            p = 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u
                       + (-p0 + 3 * p1 - 3 * p2 + p3) * u ** 3)
            out.append((max(p.x, 0.0) if i > 0 or s > 0 else 0.0, p.y))
            segs.append(i)
    out.append(pts[-1])
    out[0] = (0.0, out[0][1])
    return out, segs


def section(y):
    half, segs = sample_profile(key_points(y))
    M = len(half) - 1
    loop = [(x, y, z) for x, z in half] + [(-half[k][0], y, half[k][1]) for k in range(M - 1, 0, -1)]
    lsegs = segs + [segs[2 * M - e - 1] for e in range(M, 2 * M)]
    return loop, lsegs


def face_material(seg, y, c):
    """0 = Paint, 1 = Glass, 2 = Trim."""
    if seg == SEG_WINDOW and -0.6 <= y <= 0.72:
        return 1
    if seg in (SEG_ROOF1, SEG_ROOF2) and (-0.86 <= y <= -0.14 or 0.42 <= y <= 1.22):
        return 1
    if seg == SEG_RAIL and c > 0.35:
        return 2
    return 0


def build_hull(paint, glass, trim):
    ys = []
    n = 90
    for i in range(n + 1):
        t = i / n
        # denser near the ends where the curvature is high
        u = 0.5 - 0.5 * math.cos(math.pi * t)
        ys.append(lerp(Y_NOSE, Y_TAIL, lerp(t, u, 0.35)))
    loops, segs = [], None
    for y in ys:
        lp, sg = section(y)
        loops.append(lp)
        segs = sg
    L = len(loops[0])

    def capped(lp, s, dy):
        cz = sum(p[2] for p in lp) / len(lp)
        return [(p[0] * s, p[1] + dy, cz + (p[2] - cz) * s) for p in lp]

    front = [capped(loops[0], s, -d) for s, d in ((0.35, 0.05), (0.72, 0.038), (0.92, 0.018))]
    rear = [capped(loops[-1], s, d) for s, d in ((0.94, 0.016), (0.78, 0.032), (0.4, 0.045))]
    all_loops = front + loops + rear
    nf = len(front)
    verts = [p for lp in all_loops for p in lp]
    faces, mats = [], []
    for i in range(len(all_loops) - 1):
        ymid = (all_loops[i][0][1] + all_loops[i + 1][0][1]) / 2
        c = cabin(ymid)
        main = nf <= i < nf + len(loops) - 1
        for e in range(L):
            e2 = (e + 1) % L
            faces.append((i * L + e, i * L + e2, (i + 1) * L + e2, (i + 1) * L + e))
            mats.append(face_material(segs[e], ymid, c) if main else 0)
    # end fans
    for idx, lp in ((0, all_loops[0]), (len(all_loops) - 1, all_loops[-1])):
        cx = Vector((0, sum(p[1] for p in lp) / L, sum(p[2] for p in lp) / L))
        verts.append(tuple(cx))
        ci = len(verts) - 1
        for e in range(L):
            e2 = (e + 1) % L
            faces.append((idx * L + e, idx * L + e2, ci))
            mats.append(0)
    me = bpy.data.meshes.new('hull')
    me.from_pydata(verts, [], faces)
    me.update()
    o = bpy.data.objects.new('hull', me)
    bpy.context.collection.objects.link(o)
    for m in (paint, glass, trim):
        me.materials.append(m)
    for p, mi in zip(me.polygons, mats):
        p.material_index = mi
    fix_normals(o)
    bvh = BVHTree.FromPolygons([Vector(v) for v in verts], faces)
    return o, bvh


def hit(bvh, origin, direction):
    r = bvh.ray_cast(Vector(origin), Vector(direction).normalized(), 50.0)
    if r[0] is None:
        return None, None
    n = r[1]
    if n.dot(Vector(direction)) > 0:
        n = -n
    return r[0], n


def patch(bvh, m, grid_fn, direction, nu, nv, out=0.006, depth=0.012, name='patch', lift=None):
    """Project a uv grid onto the hull and give it thickness along the surface normal.
    grid_fn(u, v) -> ray origin (a point well outside the hull)."""
    top, bot = [], []
    for i in range(nu + 1):
        for j in range(nv + 1):
            u, v = i / nu, j / nv
            p, nrm = hit(bvh, grid_fn(u, v), direction)
            if p is None:
                return None
            o = out if lift is None else out + lift(u, v)
            top.append(p + nrm * o)
            bot.append(p - nrm * depth)
    verts = top + bot
    N = len(top)
    idx = lambda i, j: i * (nv + 1) + j
    faces = []
    for i in range(nu):
        for j in range(nv):
            faces.append((idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)))
            faces.append((N + idx(i, j), N + idx(i, j + 1), N + idx(i + 1, j + 1), N + idx(i + 1, j)))
    ring = [idx(i, 0) for i in range(nu)] + [idx(nu, j) for j in range(nv)] + \
           [idx(i, nv) for i in range(nu, 0, -1)] + [idx(0, j) for j in range(nv, 0, -1)]
    for k in range(len(ring)):
        a, b = ring[k], ring[(k + 1) % len(ring)]
        faces.append((a, b, N + b, N + a))
    return solid_from(verts, faces, m, name)


def both_sides(fn):
    return [fn(1), fn(-1)]


# ---------------------------------------------------------------- the car
def build_car():
    reset()
    paint = mat('Paint', '#c8141c', metal=0.5, rough=0.25)
    trim = mat('Trim', '#141518', metal=0.2, rough=0.55)
    glass = mat('Glass', '#05080b', metal=0.2, rough=0.04, alpha=0.55)
    headlight = mat('Headlight', '#f4f7ff', emit=6.0, rough=0.2)
    taillight = mat('Taillight', '#ff0a14', emit=3.0, rough=0.3)
    chrome = mat('Chrome', '#d8dce0', metal=1.0, rough=0.12)
    tyre = mat('Tyre', '#161616', rough=0.92)
    rim = mat('Rim', '#a9adb3', metal=0.9, rough=0.28)
    brake = mat('Brake', '#d01818', metal=0.2, rough=0.4)
    disc = mat('BrakeDisc', '#55585c', metal=0.85, rough=0.45)

    hull, bvh = build_hull(paint, glass, trim)
    p = [hull]

    # wheel arches: cut the hull with cylinders; the cut faces take the cutter's Trim -> dark liners
    cutters = []
    for ay in (-AXLE_Y, AXLE_Y):
        for s in (1, -1):
            c = cyl(WHEEL_R + 0.045, 0.75, (s * 1.035, ay, WHEEL_R), trim, rot=(0, math.radians(90), 0), verts=48)
            cutters.append(c)
    for c in cutters:
        select_only(c)
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    bpy.ops.object.select_all(action='DESELECT')
    for c in cutters:
        c.select_set(True)
    bpy.context.view_layer.objects.active = cutters[0]
    bpy.ops.object.join()
    cutter = obj()
    md = hull.modifiers.new('arches', 'BOOLEAN')
    md.operation = 'DIFFERENCE'
    md.object = cutter
    md.solver = 'EXACT'
    md.material_mode = 'TRANSFER'
    select_only(hull)
    bpy.ops.object.modifier_apply(modifier=md.name)
    bpy.data.objects.remove(cutter, do_unlink=True)

    # arch lips (thin dark flare following each arch on the outer surface)
    for ay in (-AXLE_Y, AXLE_Y):
        for s in (1, -1):
            r0, r1 = WHEEL_R + 0.045, WHEEL_R + 0.075
            a0, a1 = math.radians(8), math.radians(172)
            n = 28
            vs, fs = [], []
            for i in range(n + 1):
                a = lerp(a0, a1, i / n)
                for r in (r0, r1):
                    yy, zz = ay + r * math.cos(a), WHEEL_R + r * math.sin(a)
                    pnt, _ = hit(bvh, (s * 2.0, yy, zz), (-s, 0, 0))
                    xx = abs(pnt.x) if pnt else 0.95
                    vs.append((s * (xx + 0.012), yy, zz))
                    vs.append((s * (xx - 0.02), yy, zz))
            for i in range(n):
                b, c2 = i * 4, (i + 1) * 4
                fs += [(b, b + 2, c2 + 2, c2), (b + 1, c2 + 1, c2 + 3, b + 3),
                       (b, c2, c2 + 1, b + 1), (b + 2, b + 3, c2 + 3, c2 + 2)]
            fs += [(0, 1, 3, 2), (n * 4, n * 4 + 2, n * 4 + 3, n * 4 + 1)]
            p.append(solid_from(vs, fs, trim, 'archlip'))

    # interior so the tinted glass shows a dark cabin rather than the inside of the shell
    p.append(box((1.3, 1.25, 0.42), (0, 0.22, 0.58), trim))
    p.append(box((1.3, 0.3, 0.16), (0, -0.42, 0.8), trim, bev=0.04))           # dashboard
    for x in (-0.34, 0.34):
        p.append(box((0.44, 0.13, 0.36), (x, 0.5, 0.92), trim, bev=0.05, rot=(math.radians(-16), 0, 0)))

    # ---- front
    # splitter
    prof = []
    for i in range(21):
        x = lerp(-0.88, 0.88, i / 20)
        prof.append((x, -2.27 + 0.24 * (abs(x) / 0.88) ** 3))
    prof += [(0.88, -1.85), (-0.88, -1.85)]
    p.append(extrude_z(prof, 0.085, 0.115, trim, 'splitter'))
    # main and side intakes (dark recessed look), projected onto the nose
    p.append(patch(bvh, trim, lambda u, v: (lerp(-0.5, 0.5, u), -3.0, lerp(0.2, 0.33, v)), (0, 1, 0), 12, 4,
                   out=0.009, name='grille'))
    for s in (1, -1):
        p.append(patch(bvh, trim, lambda u, v, s=s: (s * lerp(0.56, 0.78, u), -3.0, lerp(0.2, 0.31 - 0.04 * u, v)),
                       (0, 1, 0), 6, 4, out=0.009, name='sideintake'))
        # swept headlights on the nose top
        p.append(patch(bvh, headlight,
                       lambda u, v, s=s: (s * lerp(0.50, 0.85, u), lerp(-2.17, -1.98, u ** 1.4) + 0.012 + v * lerp(0.06, 0.04, u),
                                          3.0), (0, 0, -1), 10, 2, out=0.006, name='headlight'))
        # dark surround under each headlight
        p.append(patch(bvh, trim,
                       lambda u, v, s=s: (s * lerp(0.48, 0.87, u), lerp(-2.19, -2.0, u ** 1.4) + v * lerp(0.1, 0.075, u),
                                          3.0), (0, 0, -1), 10, 2, out=0.003, name='hlsurround'))
        # hood vents
        p.append(patch(bvh, trim, lambda u, v, s=s: (s * lerp(0.22, 0.4, u), lerp(-1.75, -1.6, v) + 0.06 * u, 3.0),
                       (0, 0, -1), 4, 3, out=0.003, name='hoodvent'))

    # ---- sides
    for s in (1, -1):
        # side skirt blade
        p.append(patch(bvh, trim, lambda u, v, s=s: (s * 2.0, lerp(-0.88, 0.86, u), lerp(0.13, 0.25, v)),
                       (-s, 0, 0), 16, 2, out=0.022, name='skirt'))
        # door intake ahead of the rear wheel
        p.append(patch(bvh, trim,
                       lambda u, v, s=s: (s * 2.0, lerp(0.42, 0.88, u) + 0.12 * v, lerp(0.38, 0.62 - 0.06 * u, v)),
                       (-s, 0, 0), 8, 4, out=0.003, name='doorintake'))
        # mirrors
        base, nrm = hit(bvh, (s * 2.0, -0.5, 0.84), (-s, 0, 0))
        bx = abs(base.x)
        p.append(box((0.12, 0.05, 0.022), (s * (bx + 0.03), -0.47, 0.875), trim, bev=0.008,
                     rot=(0, s * math.radians(-28), 0)))
        p.append(box((0.17, 0.11, 0.085), (s * (bx + 0.12), -0.46, 0.915), paint, bev=0.035, seg=3))
        p.append(box((0.14, 0.01, 0.06), (s * (bx + 0.12), -0.402, 0.915), chrome, bev=0.004))

    # ---- rear
    # tail light strip across the tail plus wrap-around corners
    p.append(patch(bvh, taillight, lambda u, v: (lerp(-0.8, 0.8, u), 3.0, lerp(0.762, 0.79, v)), (0, -1, 0),
                   24, 1, out=0.008, name='tailstrip'))
    for s in (1, -1):
        p.append(patch(bvh, taillight, lambda u, v, s=s: (s * lerp(0.6, 0.8, u), 3.0, lerp(0.79, 0.825, v) - 0.03 * u),
                       (0, -1, 0), 5, 1, out=0.008, name='tailcorner'))
    p.append(patch(bvh, trim, lambda u, v: (lerp(-0.83, 0.83, u), 3.0, lerp(0.74, 0.84, v)), (0, -1, 0),
                   24, 2, out=0.004, name='tailband'))
    # engine vent / mesh panel between lights and bumper
    p.append(patch(bvh, trim, lambda u, v: (lerp(-0.5, 0.5, u), 3.0, lerp(0.56, 0.68, v)), (0, -1, 0),
                   10, 2, out=0.003, name='rearvent'))
    for i in range(7):
        x = -0.42 + i * 0.14
        p.append(patch(bvh, paint, lambda u, v, x=x: (x + lerp(-0.012, 0.012, u), 3.0, lerp(0.565, 0.675, v)),
                       (0, -1, 0), 1, 1, out=0.008, name='ventslat'))
    # lower rear: black bumper section
    p.append(patch(bvh, trim, lambda u, v: (lerp(-0.88, 0.88, u), 3.0, lerp(0.27, 0.46, v)), (0, -1, 0),
                   20, 3, out=0.004, name='rearlower'))
    # diffuser with fins
    diff = [(1.85, 0.2), (2.26, 0.33), (2.26, 0.29), (1.85, 0.16)]
    p.append(extrude_x(diff, -0.8, 0.8, trim, 'diffuser'))
    for x in (-0.6, -0.36, 0.36, 0.6):
        p.append(extrude_x([(1.9, 0.19), (2.265, 0.31), (2.265, 0.2), (1.9, 0.15)], x - 0.012, x + 0.012, trim, 'fin'))
    # twin exhausts in the diffuser
    for x in (-0.16, 0.16):
        p.append(cyl(0.055, 0.2, (x, 2.17, 0.3), chrome, rot=(math.radians(90), 0, 0), verts=20))
        p.append(cyl(0.043, 0.02, (x, 2.267, 0.3), trim, rot=(math.radians(90), 0, 0), verts=20))
    # engine cover louvres behind the rear window
    p.append(patch(bvh, trim, lambda u, v: (lerp(-0.42, 0.42, u), lerp(1.3, 1.72, v), 3.0), (0, 0, -1), 8, 6,
                   out=0.003, name='louvrebase'))
    for i in range(6):
        y = 1.34 + i * 0.065
        p.append(patch(bvh, paint, lambda u, v, y=y: (lerp(-0.4, 0.4, u), y + lerp(0, 0.022, v), 3.0), (0, 0, -1),
                       8, 1, out=0.012, name='louvre'))
    # rear wing: inverted airfoil on two struts, carbon end plates
    chord = 0.36
    af = [(0.0, 0.0), (0.03, -0.022), (0.1, -0.036), (0.2, -0.032), (chord, -0.008),
          (chord, 0.004), (0.2, 0.0), (0.1, 0.006), (0.03, 0.008)]
    aoa = math.radians(9)
    wing_y, wing_z = 1.84, 1.11
    af = [(wing_y + y * math.cos(aoa) - 0, wing_z + z + y * math.sin(aoa)) for y, z in af]
    p.append(extrude_x(af, -0.82, 0.82, trim, 'wing'))
    for s in (1, -1):
        p.append(extrude_x([(1.78, 1.04), (2.22, 1.09), (2.22, 1.2), (1.84, 1.18)],
                           s * 0.82, s * 0.835, trim, 'endplate'))
        sp, _ = hit(bvh, (s * 0.42, 2.02, 3.0), (0, 0, -1))
        z0 = sp.z - 0.02
        p.append(extrude_x([(1.94, z0), (2.08, z0), (2.04, 1.13), (1.95, 1.12)],
                           s * 0.42 - 0.012, s * 0.42 + 0.012, trim, 'strut'))

    body = finish(p, 'CarBody', smooth_angle=48)

    # ---------------------------------------------------------- wheel
    w = []
    hw = WHEEL_W / 2
    tyre_prof = [(0.25, -hw + 0.01), (0.29, -hw), (0.322, -hw + 0.004), (0.336, -hw + 0.02),
                 (WHEEL_R, -hw + 0.045), (WHEEL_R, hw - 0.045), (0.336, hw - 0.02), (0.322, hw - 0.004),
                 (0.29, hw), (0.25, hw - 0.01)]
    w.append(revolve(tyre_prof, tyre, 'X', n=40, name='tyre'))
    barrel = [(0.228, -hw + 0.02), (0.252, -hw + 0.008), (0.256, -hw + 0.018), (0.248, hw - 0.022),
              (0.258, hw - 0.004), (0.252, hw + 0.004), (0.232, hw - 0.012)]
    w.append(revolve(barrel, rim, 'X', n=40, name='barrel'))
    # brake disc and caliper, behind the spokes
    w.append(revolve([(0.08, -0.03), (0.205, -0.03), (0.205, -0.002), (0.08, -0.002)], disc, 'X', n=36, name='disc'))
    w.append(revolve([(0.085, -0.002), (0.1, -0.002), (0.1, 0.07), (0.085, 0.07)], disc, 'X', n=24, name='hat'))
    w.append(revolve([(0.17, -0.045), (0.225, -0.045), (0.225, 0.04), (0.17, 0.04)], brake, 'X', n=8,
                     a0=math.radians(20), a1=math.radians(70), name='caliper'))
    # 5 split spokes (10 blades) on the +X face, dished outward
    for i in range(10):
        a = (i // 2) * 2 * math.pi / 5 + (1 if i % 2 else -1) * math.radians(7)
        d = Vector((0, math.cos(a), math.sin(a)))
        t = Vector((0, -math.sin(a), math.cos(a)))
        vs = []
        for r, wid, x0, x1 in ((0.06, 0.022, 0.07, 0.115), (0.236, 0.014, 0.085, 0.112)):
            for sx in (x0, x1):
                for sw in (-wid, wid):
                    v = d * r + t * sw
                    vs.append((sx, v.y, v.z))
        fs = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
        w.append(solid_from(vs, fs, rim, 'spoke'))
    w.append(revolve([(0.0, 0.07), (0.075, 0.07), (0.075, 0.115), (0.05, 0.125), (0.0, 0.125)], rim, 'X', n=24,
                     name='hub'))
    w.append(cyl(0.03, 0.02, (0.128, 0, 0), chrome, rot=(0, math.radians(90), 0), verts=16))
    for i in range(5):
        a = i * 2 * math.pi / 5 + math.pi / 5
        w.append(cyl(0.011, 0.02, (0.125, 0.052 * math.cos(a), 0.052 * math.sin(a)), chrome,
                     rot=(0, math.radians(90), 0), verts=6))
    wheel = finish(w, 'Wheel', smooth_angle=40)

    export(os.path.join(OUT, 'car.glb'), [body, wheel])


# ---------------------------------------------------------------- props
def build_props():
    reset()
    bark = mat('Bark', '#5e3f26', rough=0.95)
    pine = mat('Pine', '#2c5e34', rough=0.9)
    pine2 = mat('Pine2', '#36703d', rough=0.9)
    leaf = mat('Leaf', '#4f8f36', rough=0.9)
    leaf2 = mat('Leaf2', '#6aa543', rough=0.9)
    stone = mat('Stone', '#85898a', rough=0.95)
    orange = mat('ConeOrange', '#ff6a13', rough=0.55)
    white = mat('ConeWhite', '#f4f4f0', rough=0.5)
    tyre = mat('Tyre', '#1a1a1a', rough=0.92)
    concrete = mat('Concrete', '#a7a39b', rough=0.9)
    steel = mat('Steel', '#5d636b', metal=0.7, rough=0.4)
    roof = mat('Roof', '#e8e8ea', metal=0.3, rough=0.5)
    seat_cols = [mat('SeatRed', '#c8232c', rough=0.6), mat('SeatBlue', '#1f5fbf', rough=0.6),
                 mat('SeatWhite', '#ececec', rough=0.6), mat('SeatYellow', '#f2c12e', rough=0.6)]
    out = []

    # pine: tiers of cones on a trunk (~8 m)
    t = [cyl(0.2, 2.0, (0, 0, 1.0), bark, verts=8)]
    for i, (r, z0, h) in enumerate(((2.3, 1.3, 2.8), (1.85, 2.7, 2.6), (1.4, 4.0, 2.4), (0.9, 5.3, 2.6))):
        t.append(cone(r, 0.05, h, (0, 0, z0 + h / 2), pine if i % 2 == 0 else pine2, verts=9))
    out.append(finish(t, 'TreePine', smooth_angle=0))

    # round tree (~7 m)
    t = [cone(0.28, 0.16, 3.4, (0, 0, 1.7), bark, verts=8)]
    t.append(ico(2.1, (0, 0, 4.7), leaf, sub=2, jitter=0.18))
    t.append(ico(1.4, (1.3, 0.4, 4.0), leaf2, sub=1, jitter=0.12))
    t.append(ico(1.3, (-1.2, -0.3, 4.2), leaf2, sub=1, jitter=0.12))
    t.append(ico(1.1, (0.2, -0.9, 5.9), leaf2, sub=1, jitter=0.1))
    out.append(finish(t, 'TreeRound', smooth_angle=0))

    # traffic cone (~0.7 m)
    c = [box((0.42, 0.42, 0.035), (0, 0, 0.0175), orange, bev=0.01)]
    c.append(revolve([(0.0, 0.035), (0.165, 0.035), (0.03, 0.70), (0.0, 0.70)], orange, 'Z', n=20, name='conebody'))
    for z0, z1 in ((0.26, 0.36), (0.46, 0.53)):
        r0 = lerp(0.165, 0.03, (z0 - 0.035) / 0.665) + 0.004
        r1 = lerp(0.165, 0.03, (z1 - 0.035) / 0.665) + 0.004
        c.append(revolve([(r0 - 0.01, z0), (r0, z0), (r1, z1), (r1 - 0.01, z1)], white, 'Z', n=20, name='band'))
    out.append(finish(c, 'Cone', smooth_angle=30))

    # tyre stack (~1 m)
    s = []
    tw = 0.32
    for i in range(3):
        z = i * tw
        prof = [(0.2, z + 0.03), (0.28, z + 0.005), (0.37, z + 0.015), (0.38, z + tw / 2),
                (0.37, z + tw - 0.015), (0.28, z + tw - 0.005), (0.2, z + tw - 0.03)]
        s.append(revolve(prof, tyre, 'Z', n=24, name='stacktyre'))
    out.append(finish(s, 'TireStack', smooth_angle=50))

    # grandstand: 24 m along X, 8 m deep, 7 m tall, facing -Y (spectators look towards -Y)
    g = []
    L, D = 24.0, 8.0
    g.append(box((L, D, 0.6), (0, 0, 0.3), concrete))                       # base slab
    rows = 7
    for i in range(rows):
        y0 = -D / 2 + 1.0 + i * 0.9
        z = 0.6 + (i + 1) * 0.55
        g.append(box((L - 0.4, D / 2 - y0, z - 0.6), (0, (y0 + D / 2) / 2, (z + 0.6) / 2), concrete))
        # seat strips: blocks of colours along the row
        blocks = 6
        for b in range(blocks):
            col = seat_cols[(b + i) % len(seat_cols)] if (b + i) % 3 else seat_cols[(i % 2)]
            x0 = -L / 2 + 0.6 + b * (L - 1.2) / blocks
            g.append(box(((L - 1.2) / blocks - 0.25, 0.42, 0.22), (x0 + (L - 1.2) / blocks / 2, y0 + 0.45, z + 0.11),
                         col))
            g.append(box(((L - 1.2) / blocks - 0.25, 0.08, 0.38), (x0 + (L - 1.2) / blocks / 2, y0 + 0.68, z + 0.3),
                         col))
    top_z = 0.6 + rows * 0.55
    g.append(box((L, 0.3, 6.8), (0, D / 2 - 0.15, 3.4), concrete))         # back wall
    for sx in (-1, 1):                                                        # side walls (stepped silhouette)
        g.append(extrude_x([(-D / 2 + 0.6, 0.6), (D / 2 - 0.3, top_z), (D / 2 - 0.3, 0.6)],
                           sx * L / 2 - 0.15, sx * L / 2 + 0.15, concrete, 'sidewall'))
    g.append(box((L, 0.06, 1.0), (0, -D / 2 + 0.3, 1.1), steel))            # front rail panel
    # roof on posts, sloping down to the back
    for x in (-11.5, -5.75, 0.0, 5.75, 11.5):
        g.append(box((0.25, 0.25, 6.9), (x, -D / 2 + 0.6, 3.45), steel))
    roof_prof = [(-D / 2 - 0.4, 7.0), (D / 2 + 0.2, 6.55), (D / 2 + 0.2, 6.35), (-D / 2 - 0.4, 6.75)]
    g.append(extrude_x(roof_prof, -L / 2 - 0.4, L / 2 + 0.4, roof, 'roof'))
    g.append(extrude_x([(-D / 2 - 0.45, 7.0), (-D / 2 - 0.35, 7.0), (-D / 2 - 0.35, 6.45), (-D / 2 - 0.45, 6.45)],
                       -L / 2 - 0.4, L / 2 + 0.4, seat_cols[0], 'fascia'))
    out.append(finish(g, 'Grandstand', smooth_angle=0))

    out.append(finish([ico(0.55, (0, 0, 0.42), leaf, sub=2, jitter=0.05),
                       ico(0.42, (0.5, 0.15, 0.32), leaf2, sub=1, jitter=0.06),
                       ico(0.4, (-0.48, -0.1, 0.3), leaf2, sub=1, jitter=0.06)], 'Bush', smooth_angle=0))
    out.append(finish([ico(0.7, (0, 0, 0.35), stone, sub=1, jitter=0.16, scale=(1.3, 1.0, 0.75))],
                      'Rock', smooth_angle=0))

    # put each prop's base on Z = 0 exactly (origin = base centre)
    for o in out:
        zmin = min(v.co.z for v in o.data.vertices)
        off = Vector((0, 0, zmin))
        for v in o.data.vertices:
            v.co -= off
    export(os.path.join(OUT, 'props.glb'), out)


build_car()
build_props()
