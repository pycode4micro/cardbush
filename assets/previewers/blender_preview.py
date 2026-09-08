"""Read a .blend in a factory-startup process and export a disposable glTF view.

Never save the source file or user preferences. Embedded Python is disabled by
the launcher and open_mainfile. Scene/display changes affect this process only.
"""
import argparse
import json
import os
import sys

import bpy


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("output")
    parser.add_argument("--scene", default="")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    bpy.ops.wm.open_mainfile(filepath=args.source, load_ui=False, use_scripts=False)
    if args.scene:
        if args.scene not in bpy.data.scenes:
            raise ValueError("The requested scene no longer exists.")
        bpy.context.window.scene = bpy.data.scenes[args.scene]
    scene = bpy.context.scene
    objects = list(scene.objects)
    issues = []

    def issue(code, items):
        names = sorted(set(items))
        if names:
            issues.append({"code": code, "count": len(names), "examples": names[:8]})

    issue("unsupported_objects", [o.name for o in objects if o.type in {"VOLUME", "GREASEPENCIL", "POINTCLOUD"}])
    issue("simulations", [o.name for o in objects if o.particle_systems or any(m.type in {"FLUID", "CLOTH", "SOFT_BODY", "PARTICLE_SYSTEM"} for m in o.modifiers)])
    issue("procedural_materials", [m.name for m in bpy.data.materials if m.use_nodes and m.node_tree and any(n.type.startswith("TEX_") and n.type not in {"TEX_IMAGE", "TEX_COORD"} for n in m.node_tree.nodes)])
    issue("missing_images", [i.name for i in bpy.data.images if i.source == "FILE" and not i.packed_file and i.filepath and not os.path.isfile(bpy.path.abspath(i.filepath, library=i.library))])
    if getattr(bpy.app, "autoexec_fail", False):
        issues.append({"code": "scripts_disabled", "count": 1, "examples": []})

    has_shape_keys = any(o.type == "MESH" and o.data.shape_keys for o in objects)
    if has_shape_keys:
        issue("unapplied_modifiers", [o.name for o in objects if any(m.type != "ARMATURE" for m in o.modifiers)])
    options = {
        "filepath": os.path.join(args.output, "scene.glb"),
        "export_format": "GLB",
        "use_selection": False,
        "use_visible": False,
        "use_renderable": False,
        "use_active_scene": True,
        "export_apply": not has_shape_keys,
        "export_animations": True,
        "export_animation_mode": "ACTIONS",
        "export_frame_range": True,
        "export_force_sampling": True,
        "export_cameras": True,
        "export_lights": True,
        "export_extras": False,
        "export_yup": True,
        "export_draco_mesh_compression_enable": False,
    }
    properties = bpy.ops.export_scene.gltf.get_rna_type().properties
    result = bpy.ops.export_scene.gltf(**{key: value for key, value in options.items() if key in properties})
    if "FINISHED" not in result:
        raise RuntimeError("Blender did not finish exporting the preview.")
    metadata = {
        "blenderVersion": bpy.app.version_string,
        "scene": scene.name,
        "scenes": [s.name for s in bpy.data.scenes],
        "frameStart": scene.frame_start,
        "frameEnd": scene.frame_end,
        "fps": scene.render.fps / scene.render.fps_base,
        "objects": len(objects),
        "materials": len(bpy.data.materials),
        "issues": issues,
    }
    with open(os.path.join(args.output, "metadata.json"), "w", encoding="utf-8") as handle:
        json.dump(metadata, handle, ensure_ascii=False)


if __name__ == "__main__":
    main()
