// Official sid mapping for the pinned Kokoro v1.1-zh bank (not v1.0).
// https://k2-fsa.github.io/sherpa/onnx/tts/all/Chinese-English/kokoro-multi-lang-v1_1.html
const female = [1,2,3,4,5,6,7,8,17,18,19,21,22,23,24,26,27,28,32,36,38,39,40,42,43,44,46,47,48,49,51,59,60,67,70,71,72,73,74,75,76,77,78,79,83,84,85,86,87,88,90,92,93,94,99];
const male = [9,10,11,12,13,14,15,16,20,25,29,30,31,33,34,35,37,41,45,50,52,53,54,55,56,57,58,61,62,63,64,65,66,68,69,80,81,82,89,91,95,96,97,98,100];
export const kokoroPresets = {
  female: female.map((id, index) => ({ value: index + 3, name: `zf_${String(id).padStart(3, '0')}` })),
  male: male.map((id, index) => ({ value: index + 58, name: `zm_${String(id).padStart(3, '0')}` })),
};
