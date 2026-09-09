import type { AuthUser } from "./middleware/auth.js";

/** Env tipado do app Hono — authUser vem do middleware Firebase. */
export type AppEnv = {
	Variables: { authUser: AuthUser; businessGate: BusinessGate };
	Bindings: Record<string, never>;
};

import type { BusinessGate } from "./middleware/paywall.js";
