DrawingML preset shape data is derived from Apache POI's
[presetShapeDefinitions.xml](https://github.com/apache/poi/blob/338882ac8898df5c13a7d15f533204c5dd8607d6/poi/src/main/resources/org/apache/poi/sl/draw/geom/presetShapeDefinitions.xml),
revision `338882ac8898df5c13a7d15f533204c5dd8607d6`, licensed under Apache-2.0.
The source hash is recorded in presetShapes.json; regenerate with
`node scripts/update-pptx-presets.mjs`. The catalog contains data, not executable
formulas; the evaluator supports DrawingML's arithmetic operations only.

The worker adapter retains @file-viewer/pptx 3.0.0 (Apache-2.0). Its parser,
styles, text, media, transforms and connector markers remain upstream-owned.
Preset paths are evaluated from the definitions in the original shape's size.
New dependency versions must be audited before changing the pinned adapter.
