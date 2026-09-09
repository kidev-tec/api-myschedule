// Gera custom token p/ debug dos endpoints (uso local, fora do git)
import { cert, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const svc = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString(),
);
initializeApp({ credential: cert(svc) });
const user = await getAuth().getUserByEmail(
  process.argv[2] ?? 'teste.qa@minhaagenda.app',
);
const token = await getAuth().createCustomToken(user.uid);
console.log(token);
