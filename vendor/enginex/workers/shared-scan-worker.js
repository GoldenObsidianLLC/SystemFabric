'use strict';
const { parentPort } = require('node:worker_threads');

parentPort.on('message', message => {
  const { id, inputBuffer, bitmapBuffer, controlBuffer, start, end } = message;
  try {
    const input = new Uint8Array(inputBuffer);
    const bitmap = new Uint8Array(bitmapBuffer);
    const control = new Int32Array(controlBuffer);
    let found = 0;
    for (let index = start; index < end; index++) {
      const byte = input[index];
      if (byte === 38 || byte === 60 || byte === 62 || byte === 34 || byte === 39) {
        bitmap[index] = 1;
        found++;
      }
    }
    Atomics.add(control, 0, end - start); // processed bytes
    Atomics.add(control, 1, found);        // special bytes found
    Atomics.add(control, 2, 1);            // completed chunks
    parentPort.postMessage({ id, ok: true, found });
  } catch (error) {
    const control = new Int32Array(message.controlBuffer);
    Atomics.add(control, 3, 1);
    parentPort.postMessage({ id, ok: false, error: error.message });
  }
});
