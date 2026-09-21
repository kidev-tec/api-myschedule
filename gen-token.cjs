const admin = require('firebase-admin');
const sa = require('/tmp/sa2.json');
admin.initializeApp({credential: admin.cert(sa)});
admin.auth().createCustomToken('2h0NLqYUNyMPFQbe3A8sK7cxpx53')
  .then(t => console.log(t))
  .catch(e => console.error(e));
