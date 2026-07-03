// Intermediate module. It is *not* a test and *not* the changed file, so on a
// util.ts edit it must be invalidated explicitly in the SSR runner — otherwise a
// cached `mid` never re-imports the new `util`, and the test sees a stale tag.
import { token } from "./util.ts";

export const tag = `[${token}]`;
