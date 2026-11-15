import path from 'node:path';

// The normal reporter prints only completed tests. Emit the dequeue boundary
// too, so an interrupted file identifies its last started test.
export default async function* progress(events) {
  for await (const event of events) {
    if (event.type !== 'test:dequeue') continue;
    const { file, line, name } = event.data;
    yield `[${new Date().toISOString()}] TEST START ${path.basename(file || '')}:${line || 0} ${String(name).replace(/[\r\n]/g, ' ')}\n`;
  }
}
