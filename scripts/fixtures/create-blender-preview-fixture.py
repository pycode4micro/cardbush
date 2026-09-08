import os
import sys
import bpy

directory = sys.argv[sys.argv.index('--') + 1]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.mesh.primitive_cube_add()
cube = bpy.context.object
cube.name = 'Animated cube'
cube.location.x = -1
cube.keyframe_insert(data_path='location', frame=1)
cube.location.x = 1
cube.keyframe_insert(data_path='location', frame=24)
cube.shape_key_add(name='Basis')
shape = cube.shape_key_add(name='Stretch')
shape.data[0].co.z += 0.5
shape.value = 0
shape.keyframe_insert(data_path='value', frame=1)
shape.value = 1
shape.keyframe_insert(data_path='value', frame=24)
material = bpy.data.materials.new('Packed image material')
material.use_nodes = True
material.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value = 0.45
image = bpy.data.images.new('Packed texture', width=2, height=2)
image.pixels = [0.7, 0.18, 0.06, 1.0] * 4
image.pack()
texture = material.node_tree.nodes.new('ShaderNodeTexImage')
texture.image = image
material.node_tree.links.new(texture.outputs['Color'], material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
cube.data.materials.append(material)
bpy.ops.object.light_add(type='AREA', location=(4, -3, 5))
bpy.context.object.data.energy = 300
scene = bpy.context.scene
scene.name = 'Animated scene'
scene.frame_end = 24
scene.frame_set(1)
second = bpy.data.scenes.new('Second scene')
copy = cube.copy()
copy.data = cube.data.copy()
copy.animation_data_clear()
copy.name = 'Second cube'
second.collection.objects.link(copy)
marker = os.path.join(directory, 'embedded-script-ran')
embedded = bpy.data.texts.new('preview_test.py')
embedded.write("open(" + repr(marker) + ", 'w').write('unexpected')")
embedded.use_module = True
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(directory, 'scene.blend'), compress=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(directory, 'uncompressed.blend'), compress=False)
