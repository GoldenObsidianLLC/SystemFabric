'use strict';

/** Static capability snapshot; availability is not a performance promise. */
function getAccelerationCapabilities(globalObject = globalThis) {
  const nodeRuntime = typeof process !== 'undefined' && Boolean(process.versions?.node);
  const sharedArrayBufferAvailable = typeof globalObject.SharedArrayBuffer === 'function';
  const crossOriginIsolated = globalObject.crossOriginIsolated === true;
  const sharedArrayBufferUsable = sharedArrayBufferAvailable && (nodeRuntime || crossOriginIsolated);
  const navigatorObject = globalObject.navigator;
  return Object.freeze({
    runtime: nodeRuntime ? 'node' : 'browser-or-other',
    wasm: typeof globalObject.WebAssembly === 'object',
    wasmSimdModuleBundled: true,
    webgpuApiAvailable: Boolean(navigatorObject?.gpu),
    webgpuAdapterProbed: false,
    sharedArrayBufferAvailable,
    sharedArrayBufferUsable,
    sharedArrayBufferMode: sharedArrayBufferUsable ? 'shared-memory' : 'transferable-or-message-passing',
    crossOriginIsolated: nodeRuntime ? null : crossOriginIsolated,
    webSocketAvailable: typeof globalObject.WebSocket === 'function',
    webTransportAvailable: typeof globalObject.WebTransport === 'function',
    webRtcAvailable: typeof globalObject.RTCPeerConnection === 'function'
  });
}

/** Probe an adapter and its feature set. This reports support only, not speed. */
async function probeAccelerationCapabilities(globalObject = globalThis) {
  const base = getAccelerationCapabilities(globalObject);
  if (!globalObject.navigator?.gpu) {
    return Object.freeze({ ...base, webgpuAdapterProbed: true, webgpuAdapterAvailable: false, webgpuFeatures: [] });
  }
  try {
    const adapter = await globalObject.navigator.gpu.requestAdapter();
    if (!adapter) {
      return Object.freeze({ ...base, webgpuAdapterProbed: true, webgpuAdapterAvailable: false, webgpuFeatures: [] });
    }
    return Object.freeze({
      ...base,
      webgpuAdapterProbed: true,
      webgpuAdapterAvailable: true,
      webgpuFeatures: Object.freeze(Array.from(adapter.features || []).sort()),
      webgpuLimits: Object.freeze({
        maxBufferSize: adapter.limits?.maxBufferSize ?? null,
        maxStorageBufferBindingSize: adapter.limits?.maxStorageBufferBindingSize ?? null,
        maxComputeWorkgroupsPerDimension: adapter.limits?.maxComputeWorkgroupsPerDimension ?? null
      })
    });
  } catch (error) {
    return Object.freeze({
      ...base,
      webgpuAdapterProbed: true,
      webgpuAdapterAvailable: false,
      webgpuFeatures: [],
      webgpuProbeError: String(error?.message || error).slice(0, 240)
    });
  }
}

module.exports = { getAccelerationCapabilities, probeAccelerationCapabilities };
