const app = require("firebase-admin/app");
const auth = require("firebase-admin/auth");
const sa = require("/tmp/sa.json");
app.initializeApp({ credential: app.cert(sa) });
const UID = "2h0NLqYUNyMPFQbe3A8sK7cxpx53";
auth
  .getAuth()
  .createCustomToken(UID)
  .then((t) => {
    require("fs").writeFileSync("/tmp/custom_token.txt", t);
    console.log("gravado len", t.length);
  })
  .catch((e) => {
    console.error("ERRO:", e.message.slice(0, 200));
    process.exit(1);
  });
