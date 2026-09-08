/**
 * initFirebaseAdmin — coverage 100%: caminho com service account (cert) e
 * caminho sem (project id apenas). Mockamos firebase-admin/app inteiro.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { initializeAppMock, certMock } = vi.hoisted(() => ({
  initializeAppMock: vi.fn(() => ({})),
  certMock: vi.fn((c: unknown) => c),
}));

vi.mock("firebase-admin/app", () => ({
  getApps: vi.fn(() => []), // vazio → initFirebaseAdmin DEVE inicializar
  initializeApp: initializeAppMock,
  cert: certMock,
}));

// Importa DEPOIS do mock
import { firebaseAuthMiddleware } from "../../src/middleware/auth.js";

beforeEach(() => {
  initializeAppMock.mockClear();
  certMock.mockClear();
});

describe("initFirebaseAdmin (via firebaseAuthMiddleware)", () => {
  it("inicializa com service account (cert) quando B64 presente", () => {
    const sa = Buffer.from(
      JSON.stringify({ client_email: "a@b.iam.gserviceaccount.com", private_key: "KEY" }),
    ).toString("base64");
    firebaseAuthMiddleware("proj-x", sa);
    expect(certMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-x", clientEmail: "a@b.iam.gserviceaccount.com" }),
    );
    expect(initializeAppMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-x" }),
    );
  });

  it("inicializa apenas com projectId quando sem service account", () => {
    firebaseAuthMiddleware("proj-y", undefined);
    expect(certMock).not.toHaveBeenCalled();
    expect(initializeAppMock).toHaveBeenCalledWith({ projectId: "proj-y" });
  });
});
