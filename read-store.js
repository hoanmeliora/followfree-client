const { app } = require('electron');
const Store = require('electron-store');

app.whenReady().then(() => {
  const store = new Store({
    name: 'followfree-data',
    encryptionKey: 'followfree-local-encryption-key'
  });
  
  const accounts = store.get('accounts') || [];
  console.log('--- ACCOUNTS IN STORE ---');
  console.log('Total accounts:', accounts.length);
  accounts.forEach(a => {
    console.log(a.id, a.platform, a.status, 'isManual:', a.isManual);
  });
  console.log('-------------------------');
  app.quit();
});
