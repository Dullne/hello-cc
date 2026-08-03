const bufferGcSuffix = '/lib/runtime/buffer-gc.mjs';

const instrumentedImport = `
import __gcOriginalFs from 'node:fs';
import path from 'node:path';

const __gcSuppliedTarget = path.resolve(process.env.HCC_TEST_GC_DRIFT_FILE);
const __gcTarget = path.join(
  __gcOriginalFs.realpathSync(path.dirname(__gcSuppliedTarget)),
  path.basename(__gcSuppliedTarget)
);
const __gcMode = process.env.HCC_TEST_GC_DRIFT_MODE;
const fs = Object.create(__gcOriginalFs);
let __gcDrifted = false;
fs.lstatSync = function __gcPatchedLstatSync(value, ...args) {
  if (!__gcDrifted && path.resolve(String(value)) === __gcTarget &&
      String(new Error().stack).includes('applyBufferPlan')) {
    __gcDrifted = true;
    if (__gcMode === 'missing') __gcOriginalFs.unlinkSync(__gcTarget);
    else {
      __gcOriginalFs.renameSync(__gcTarget, __gcTarget + '.planned');
      __gcOriginalFs.writeFileSync(__gcTarget, 'replacement');
    }
  }
  return __gcOriginalFs.lstatSync(value, ...args);
};
`;

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.includes(bufferGcSuffix)) return loaded;
  const originalSource = String(loaded.source);
  const source = originalSource.replace(
    "import fs from 'node:fs';\nimport path from 'node:path';",
    instrumentedImport.trim()
  );
  if (source === originalSource) throw new Error('buffer GC drift loader could not instrument the module');
  return { ...loaded, source, shortCircuit: true };
}
