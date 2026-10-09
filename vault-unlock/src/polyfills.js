// Some transitive deps (bip39 / readable-stream) expect Node's Buffer in the browser.
import { Buffer } from "buffer";
globalThis.Buffer ??= Buffer;
globalThis.global ??= globalThis;
