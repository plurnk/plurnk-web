// Fault injection for the real thread-pool termination path, independent of compiler speed.
export default function stalled() {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0);
    throw new Error("A stalled compiler must be terminated, never resumed.");
}
